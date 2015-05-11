import { _, t, Q, async, defer, config, lazy_require, log, isBlank, path } from 'azk';
import { ImageNotAvailable, SystemRunError, RunCommandError, NotBeenImplementedError } from 'azk/utils/errors';
import { Balancer } from 'azk/system/balancer';
import net from 'azk/utils/net';

var lazy = lazy_require({
  MemoryStream: 'memorystream',
  docker      : ['azk/docker', 'default'],
  Client      : ['azk/agent/client'],
});

var Run = {
  runProvision(system, options = {}) {
    return async(this, function* (notify) {
      var steps = system.provision_steps;

      options = _.defaults(options, {
        provision_force: false,
        build_force: false,
        provision_verbose: false,
      });

      if (_.isEmpty(steps)) {
        return null;
      }
      if ((!options.provision_force) && system.provisioned) {
        return null;
      }
      log.debug('provision steps', steps);

      // provision command (require /bin/sh)
      var cmd  = ["/bin/sh", "-c", "( " + steps.join('; ') + " )"];

      // Capture outputs
      var output = "";
      if (!options.provision_verbose) {
        options = _.clone(options);
        options.shell_type = "provision";
        options.stdout = new lazy.MemoryStream();
        options.stderr = options.stdout;
        options.stdout.on('data', (data) => {
          output += data.toString();
        });
      } else {
        output = t("system.seelog");
      }

      notify({ type: "provision", system: system.name });
      var exitResult = yield system.runShell(cmd, options);
      if (exitResult.code !== 0) {
        throw new RunCommandError(system.name, cmd.join(' '), output);
      }
      // save the date provisioning
      system.provisioned = new Date();
    });
  },

  runShell(system, command, options = {}) {
    return async(this, function* () {
      options = _.defaults(options, {
        remove: false,
        sequencies: yield this._getSequencies(system)
      });

      // Envs
      var deps_envs = yield system.checkDependsAndReturnEnvs(options, false);
      options.envs  = _.merge(deps_envs, options.envs || {});

      yield this._check_image(system, options);
      var docker_opt = system.shellOptions(options);
      var container  = yield lazy.docker.run(system.image.name, command, docker_opt);
      var data       = yield container.inspect();

      // Remove before run
      if (options.remove) { yield container.remove(); }

      return {
        code: data.State.ExitCode,
        container: container,
        containerId: container.Id,
        removed: options.remove,
      };
    });
  },

  runDaemon(system, options = {}) {
    return async(this, function* () {
      // TODO: add instances and dependencies options
      // Prepare options
      var image = yield this._check_image(system, options);
      options.image_data = image;

      // Check provision
      yield system.runProvision(options);

      options = _.defaults(options, {
        sequencies: yield this._getSequencies(system),
        wait: system.wait_scale,
      });

      var docker_opt = system.daemonOptions(options);
      var command    = docker_opt.command;
      var container  = yield lazy.docker.run(system.image.name, command, docker_opt);

      if (options.wait) {
        var first_tcp = _.find((docker_opt.ports_orderly || []), (data) => {
          return /\/tcp/.test(data.name);
        });

        // TODO: support to wait udp protocol
        var data = yield container.inspect();
        var port_data = _.chain(data.NetworkSettings.Access)
          .filter((port) => {
            return port.protocol == 'tcp' && port.name == first_tcp.private;
          })
          .find()
          .value();

        if (!_.isEmpty(port_data)) {
          var retry   = options.wait.retry   || config('docker:run:retry');
          var timeout = options.wait.timeout || config('docker:run:timeout');

          yield this._wait_available(system, port_data, container, retry, timeout);
        }
      }

      // Adding to balancer
      yield Balancer.add(system, container);

      return container;
    });
  },

  runSync(system) {
    return async(this, function* () {
      var sync_result = yield this._fixSyncFolderPermissions(system.manifest.namespace);
      if (sync_result !== 0) {
        // TODO: throw proper error
        throw new NotBeenImplementedError('SyncError');
      }

      _.each(system.syncs || {}, (guest_folder, host_folder) => {
        return async(this, function* (notify) {
          yield lazy.Client.sync(`${host_folder}/`, guest_folder);
          notify({ type: "sync", system: system.name });
        });
      });
    });
  },

  stop(system, instances, options = {}) {
    options = _.defaults(options, {
      kill: false,
      remove: true,
    });

    return async(function* (notify) {
      var container = null;

      // Default stop all
      if (_.isEmpty(instances)) {
        instances = yield system.instances();
      }

      while ( (container = instances.pop()) ) {
        container = lazy.docker.getContainer(container.Id);

        // Remove from balancer
        yield Balancer.remove(system, container);

        if (options.kill) {
          notify({ type: 'kill_service', system: system.name });
          yield container.kill();
        } else {
          notify({ type: 'stop_service', system: system.name });
          yield container.stop();
        }
        notify({ type: "stopped", id: container.Id });
        if (options.remove) {
          yield container.remove();
        }
      }

      return true;
    });
  },

  // Wait for container/system available
  _wait_available(system, port_data, container, retry, timeout) {
    return async(this, function* (notify) {
      var host;
      if (config('agent:requires_vm')) {
        host = config('agent:vm:ip');
      } else {
        host = port_data.gateway;
      }

      // Wait for available
      var wait_opts = {
        timeout: timeout,
        context: `${system.name}_connect`,
        retry_if: () => {
          return container.inspect().then((data) => {
            return data.State.Running;
          });
        },
      };

      notify(_.merge(port_data, {
        name: system.portName(port_data.name),
        type: "wait_port", system: system.name
      }));

      var address = `tcp://${host}:${port_data.port}`;
      var running = yield net.waitService(address, retry, wait_opts);

      if (!running) {
        var data = yield container.inspect();
        var exitCode = data.State.ExitCode;

        if (exitCode === 0) {
          throw new SystemRunError(
            system.name,
            container,
            data.Config.Cmd.join(' '),
            exitCode,
            Q(t('errors.run_timeout_error', {
              system: system.name,
              port: port_data && port_data.port,
              retry: retry,
              timeout: timeout,
              hostname: system.url.underline,
            }))
          );
        } else {
          yield this.throwRunError(system, container, null, true);
        }
      }

      return true;
    });
  },

  throwRunError(system, container, data = null, stop = false) {
    data = data ? Q(data) : container.inspect();
    return data.then((data) => {
      // Get container log
      var promise = container.logs({stdout: true, stderr: true}).then((stream) => {
        return defer((resolve, reject) => {
          var acc = '';
          var stdout = {
            write(data) { acc += data.toString(); }
          };
          container.modem.demuxStream(stream, stdout, stdout);
          stream.on('end', () => { resolve(acc); });
          setTimeout(() => { reject(new Error("timeout")); }, 4000);
        });
      });

      return promise.then((log) => {
        // distinguish system log output
        log = log.replace(/^/gm, ' .' + system.name + ' [log] >  ');
        var raise = () => {
          throw new SystemRunError(
            system.name,
            container,
            data.Config.Cmd.join(' '),
            data.State.ExitCode,
            log
          );
        };

        // Stop and remove container
        if (stop) {
          return this.stop(system, [container], { kill: true, remove: true }).then(raise);
        } else {
          raise();
        }
      });
    });
  },

  // Check and pull image
  _check_image(system, options) {
    options = _.defaults(options, {
      image_pull: true,
    });

    return async(function* () {
      var promise;
      if ((options.build_force || options.image_pull) && !system.image.builded) {
        if (system.image.provider === 'docker') {
          promise = system.image.pull(options);
        } else if (system.image.provider === 'dockerfile') {
          promise = system.image.build(options);
        }

        // save the date provisioning
        system.image.builded = new Date();
      } else {
        promise = system.image.check().then((image) => {
          if (isBlank(image)) {
            throw new ImageNotAvailable(system.name, system.image.name);
          }
          return image;
        });
      }

      var image = yield promise.progress((event) => {
        event.system = system;
        return event;
      });

      if (!isBlank(image)) {
        return image.inspect();
      }
    });
  },

  _getSequencies(system, type = "*") {
    return async(this, function*() {
      var instances = yield system.instances({ type: type });

      return _.reduce(instances, (sequencies, instance) => {
        var type = instance.Annotations.azk.type;
        var seq  = parseInt(instance.Annotations.azk.seq);
        if (seq === sequencies[type]) {
          sequencies[type] = sequencies[type] + 1;
        }
        return sequencies;
      }, { shell: 1, daemon: 1 });
    });
  },

  instances(system, options = {}) {
    // Default options
    options = _.defaults(options, {
      include_dead: false,
      type: "*",
    });

    // Include dead containers
    var query_options = {};
    if (options.include_dead) {
      query_options.all = true;
    }

    return lazy.docker.azkListContainers(query_options).then((containers) => {
      var instances = _.filter(containers, (container) => {
        var azk = container.Annotations.azk;
        return (
          azk.mid == system.manifest.namespace &&
          azk.sys == system.name &&
          ( options.type == "*" || azk.type == options.type )
        );
      });

      return _.sortBy(instances, (instance) => { return instance.Annotations.azk.seq; });
    });
  },

  _fixSyncFolderPermissions(manifest_id) {
    return async(this, function* () {
      var mounted_sync_folders = '/sync_folders';
      var current_sync_folder = path.join(`${mounted_sync_folders}`, `${manifest_id}`);
      var chown = {
        cmd: `chown -R ${process.getuid()}:${process.getuid()} ${current_sync_folder}`.split(' '),
        opts: {
          volumes: {},
          interactive: false,
        },
      };
      chown.opts.volumes[mounted_sync_folders] = config('paths:sync_folders');

      var image_name = config('docker:image_default');
      var container  = yield lazy.docker.run(image_name, chown.cmd, chown.opts);
      var data = yield container.inspect();
      yield container.remove();

      return data.State.ExitCode;
    });
  },

};

export { Run };
