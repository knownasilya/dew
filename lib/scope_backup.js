var dataFile = null
  , dockerHost = process.env.DOCKER_HOST
  , inspect = require('util').inspect
  , Docker = require('dockerode')
  , rimraf = require('rimraf')
  , URI = require("uri-js")
  , path = require('path')
  , _ = require('lodash')
  , fs = require('fs')

function Scope(options) {
  var dockerOpts = null
    , numVolumes = []
    , container = null
    , volumes = null
    , docker = null
    , local = null
    , scope = null
    , home = null
    , name = null

  scope = this;

  function load() {
    try {
      scope.data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      volumes = scope.data.config.volumes;
    } catch (e) {
      save();
    } finally {
      var id = null;
      if (this.data) {
        id = scope.data.id
      } else {
        this.data = {}
      }
      container = scope.container = docker.getContainer(id);
      numVolumes = _.keys(volumes).length;
    }
  };

  function volumePath(_name) {
    if ( ! local) {
      console.warn("Dew does not support remote host volumes right now")
    }
    var volRoot = path.join(home, 'volumes')
      , volPath = path.join(volRoot, _name)
    if (fs.existsSync(volPath)) {
      return volPath;
    } else {
      if ( !fs.existsSync(volRoot) )
        fs.mkdirSync(volRoot)
      if ( !fs.existsSync(volPath) )
        fs.mkdirSync(volPath)
      return volPath;
    }
  };
  this.volumePath = volumePath;

  function save() {
    fs.writeFileSync(dataFile, JSON.stringify(scope.data, null, 4));
  };
  this.save = save;

  function getMyIPAddresses() {
    var ifaces = require('os').networkInterfaces();
    return _.pluck(_.flatten(_.map(ifaces, function (eth) {
      return _.map(eth, function(addr) { return addr })
    })), 'address')
  };

  function eachVolume(fn) {
    if (local) {
      if (volumes) return _.each(volumes, fn);
    } else {
      return cb(new Error('Setting up volumes on remote hosts is unsupported at this time'));
    }
  }
  this.eachVolume = eachVolume;

  function handleInspectError(err, config, cb) {
    if (err.statusCode === 404) {
      var createOpts = {
        name: name,
        Image: config.image,
      };
      docker.createContainer(createOpts, function (err, container) {
        if (err) {
          if (err.statusCode === 404) {
            pull(config.image, function (err, res) {
              if (err) {
                cb(new Error(err))
              } else {
                apply(scope, config, cb);
              }
            });
          } else cb(new Error(err))
        } else {
          scope.data.id = container.id;
          save();
          container.start(config.options.start, function (err) {
            if (err) {
              cb(new Error(err));
            } else {
              save();
              apply(scope, config, cb);
            }
          });
        }
      });
    } else {
      if (err.code === "EACCES" && err.syscall === "connect" && local && dockerOpts.socketPath) {
        console.error("Permission to access socket "+dockerOpts.socketPath+" was denied. You may want to use sudo.");
        cb(null);
      } else {
        cb(new Error(err));
      }
    }
  }

  function apply(scope, config, cb) {
    load();
    container.inspect(function (err, res) {
      if (err) {
        handleInspectError(err, config, cb)
      } else ensure(scope, config, cb);
    });
  };
  this.apply = apply;

  function ensure(scope, config, cb) {
    load();
    container.inspect(function (err, res) {
      if (err) cb(new Error(err))
        else {
          var liveConfig = res["HostConfig"];
          if (config.volumes) {
            var binds = {}
            _.each(liveConfig.Binds, function (pair) {
              var parts = pair.split(':')
              binds[parts[1]] = parts[0]
            });
            if (liveConfig === null) {
              err = new Error("Volumes did not mount!")
            } else {
              console.log(name);
              _.each(config.volumes, function (containerPath, volName) {
                console.log(containerPath+" => "+volumePath(volName))
                if (binds[containerPath] !== volumePath(volName)) {
                  err = new Error("Volume mounted incorrectly!");
                }
              });
            }
          }
          cb(err)
        }
    });
  };

  function pull(image, cb) {
    docker.pull(image, function (err, stream) {  
      if (err) cb(new Error(err))
        else {
          stream.on('end', function() { console.log("done"); cb(err) });
          stream.on('error', function(e2) { err = new Error(e2) });
          stream.on('data', function (chunk) {
            var data = JSON.parse(chunk.toString());
            if (data.error) {
              err = new Error("Pull failed. "+data.error)
            } else {
              // consider using https://www.npmjs.org/package/progress
              console.info(data);
            }
          });
        }
    });
  };

  home = options.home
  name = options.name
  dataFile = path.join(home, 'data.json')
  // Is this docker instance local or remote?
  // It affects our assumptions with volume paths.
  if (dockerHost) {
    dockerOpts = URI.parse(dockerHost)
    // this is not bulletproof -- you might be using dns, etc
    local = _.contains(getMyIPAddresses(), dockerOpts.host)
    docker = new Docker(dockerOpts);
  } else if (fs.existsSync('/var/run/docker.sock')) {
    local = true
    dockerOpts = { socketPath: '/var/run/docker.sock' };
    docker = new Docker(dockerOpts);
  } else {
    throw new Error("Failed to setup docker client");
  }
  if ( fs.existsSync(dataFile) ) {
    load();
  } else {
    save();
    load();
  }
};

Scope.prototype = {
  data: function (key, value) {
    if (value) {
      this.data[key] = value
      this.save()
    }
    return this.data[key]
  },
  applyConfig: function (config, cb) {
    scope = this;
    this.data('config', config);
    volumes = this.data('config').volumes;
    config.options = { start: { Binds: [] } }
    if (volumes) {
      scope.eachVolume(function (containerPath, volName) {
        var bind = scope.volumePath(volName)+":"+containerPath;
        config.options.start.Binds.push(bind);
      });
    }
    scope.save();
    scope.apply(this, config, cb);
  },
  destroy: function (cb) {
    var removeVolumes = true; // on by default
    var scope = this;
    console.log("Removing container")
    scope.container.remove({
      force: true, // Stop container and remove
      v: removeVolumes // Remove volumes
    }, function (err) {
      if (err) {
        console.error(err)
        cb(new Error(err));
      } else if (numVolumes > 0) {
        var done = _.after(numVolumes, function () {
          cb(null);
        });
        eachVolume(function (c, name) {
          rimraf(volumePath(name), done)
        })
      } else cb(null)
    })
  },
  tailUntilMatch: function (pattern, cb) {
    var match = null;
    scope.container.logs({
      follow: true, stdout: true, stderr: true
    }, function (err, stream) {
      if (err) throw err;
      stream.on('error', function(e2) { err = new Error(e2) });
      stream.on('data', function (chunk) {
        match = chunk.toString('utf-8').match(pattern)
        if (match) {
          stream.destroy(null)
          cb(err, match)
        }
      });
    })
  },
  tailForever: function () {
    scope.container.logs({
      follow: true, stdout: true, stderr: true
    }, function (err, stream) {
      if (err) throw err;
      stream.on('error', function(e2) { err = new Error(e2) });
      stream.on('data', function (chunk) {
        console.log(inspect(chunk.toString('utf-8')));
      });
    })
  }
};

module.exports = Scope
