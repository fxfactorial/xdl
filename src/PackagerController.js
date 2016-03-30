'use strict';

import _ from 'lodash';
import child_process from 'child_process';
import crayon from '@ccheever/crayon';
import express from 'express';
import freeportAsync from 'freeport-async';
import instapromise from 'instapromise';
import ngrok from 'ngrok';
import path from 'path';
import proxy from 'express-http-proxy';
import events from 'events';

import Api from './Api';
import Config from './Config';
import Exp from './Exp';
import Login from './Login';
import ProjectSettings from './ProjectSettings';
import * as UrlUtils from './UrlUtils';

class PackagerController extends events.EventEmitter {
  constructor(opts) {
    super(opts);

    let DEFAULT_OPTS = {
      port: undefined,
      cliPath: path.join(opts.absolutePath, 'node_modules/react-native/local-cli/cli.js'),
      mainModulePath: 'index.js',
      // absolutePath: root,
    };

    this.opts = Object.assign(DEFAULT_OPTS, opts);
    this._givenOpts = opts;

    this._cachedSignedManifest = {
      manifestString: null,
      signedManifest: null,
    };

    global._PackagerController = this;
  }

  static exit() {
    let pc = global._PackagerController;
    if (pc) {
      if (pc._expressServer) {
        pc._expressServer.close();
      }
      if (pc._packager) {
        pc._packager.kill('SIGTERM');
      }
      if (pc._ngrokUrl) {
        ngrok.kill();
      }
    }
  }

  async startOrRestartLocalServerAsync() {
    await this._stopLocalServerAsync();

    let app = express();
    let self = this;

    // Proxy '/bundle' to the packager.
    app.use('/bundle', proxy('localhost:' + this.opts.packagerPort, {
      forwardPath: (req, res) => {
        let queryString = require('url').parse(req.url).query;
        let platform = req.headers['exponent-platform'] || 'ios';
        let path = '/' + UrlUtils.guessMainModulePath(self.opts.entryPoint);
        path += '.bundle';
        path += '?';
        if (queryString) {
         path += queryString + '&';
        }
        path += 'platform=' + platform;
        return path;
      },
    }));

    app.use('/map', proxy('localhost:' + this.opts.packagerPort, {
      forwardPath: (req, res) => {
        let queryString = require('url').parse(req.url).query;
        let platform = req.headers['exponent-platform'] || 'ios';
        let path = '/' + UrlUtils.guessMainModulePath(self.opts.entryPoint);
        path += '.map';
        path += '?';
        if (queryString) {
         path += queryString + '&';
        }
        path += 'platform=' + platform;
        return path;
      },
    }));

    // Proxy sourcemaps to the packager.
    app.use('/', proxy('localhost:' + this.opts.packagerPort, {
      filter: function(req, res) {
        let path = require('url').parse(req.url).pathname;
        return path !== '/' && path !== '/manifest' && path !== '/bundle' && path !== '/index.exp';
      },
    }));

    // Serve the manifest.
    let manifestHandler = async (req, res) => {
      try {

        // N.B. We intentionally don't `await` this. We want to continue trying even
        //  if there is a potential error in the package.json and don't want to slow
        //  down the request
        self.validatePackageJsonAsync();

        let pkg = await Exp.packageJsonForRoot(self.opts.absolutePath).readAsync();
        let manifest = pkg.exp || {};
        let packagerOpts = await ProjectSettings.getPackagerOptsAsync(self.opts.absolutePath);
        let queryParams = UrlUtils.constructBundleQueryParams(packagerOpts);
        // TODO: remove bundlePath
        manifest.bundlePath = 'bundle?' + queryParams;
        packagerOpts.http = true;
        packagerOpts.redirect = false;
        manifest.xde = true;
        manifest.bundleUrl = await UrlUtils.constructBundleUrlAsync(self.getRoot(), packagerOpts) + '?' + queryParams;
        manifest.debuggerHost = await UrlUtils.constructDebuggerHostAsync(self.getRoot());
        manifest.mainModuleName = UrlUtils.guessMainModulePath(self.opts.entryPoint);

        let manifestString = JSON.stringify(manifest);
        let currentUser = await Login.currentUserAsync();
        if (req.headers['exponent-accept-signature'] && currentUser) {
          if (self._cachedSignedManifest.manifestString === manifestString) {
            manifestString = self._cachedSignedManifest.signedManifest;
          } else {
            let publishInfo = await Exp.getPublishInfoAsync({
              username: currentUser.username,
              packagerController: this,
            });
            let signedManifest = await Api.callMethodAsync('signManifest', [publishInfo.args], 'post', manifest);
            self._cachedSignedManifest.manifestString = manifestString;
            self._cachedSignedManifest.signedManifest = signedManifest.response;
            manifestString = signedManifest.response;
          }
        }

        res.send(manifestString);
      } catch (e) {
        console.error("Error in manifestHandler:", e, e.stack);
        // 5xx = Server Error HTTP code
        res.status(520).send({"error": e.toString()});
      }
    };

    app.get('/', manifestHandler);
    app.get('/manifest', manifestHandler);
    app.get('/index.exp', manifestHandler);

    this._expressServer = app.listen(this.opts.port, () => {
      let host = this._expressServer.address().address;
      let port = this._expressServer.address().port;

      console.log('Local server listening at http://%s:%s', host, port);
    });
  }

  async getUsernameAsync() {
    let user = await Login.currentUserAsync();
    if (user) {
      return user.username;
    } else {
      return null;
    }
  }

  async getRandomnessAsync() {
    let ps = await ProjectSettings.readAsync(this.opts.absolutePath);
    let randomness = ps.urlRandomness;
    if (!randomness) {
      randomness = UrlUtils.someRandomness();
      ProjectSettings.setAsync(this.opts.absolutePath, {'urlRandomness': randomness});
    }
    return randomness;
  }

  async startOrRestartNgrokAsync() {
    if (this._ngrokUrl) {
      console.log("Waiting for ngrok to disconnect...");
      await this._stopNgrokAsync();
      console.log("Disconnected ngrok; restarting...");
    }

    this.emit('ngrok-will-start', this.opts.port);

    // Don't try to parallelize these because they both might
    // mess with the same settings.json file, which could get gnarly
    let username = await this.getUsernameAsync();
    let packageShortName = this.getProjectShortName();
    if (!username) {
      username = await this.getLoggedOutPlaceholderUsernameAsync();
    }
    let randomness = await this.getRandomnessAsync();

    let hostname = [randomness, UrlUtils.domainify(username), UrlUtils.domainify(packageShortName), Config.ngrok.domain].join('.');

    try {
      this._ngrokUrl = await ngrok.promise.connect({
        hostname,
        authtoken: Config.ngrok.authToken,
        port: this.opts.port,
        proto: 'http',
      });
    } catch (e) {
      console.error("Problem with ngrok: " + JSON.stringify(e));
    }

    this.emit('ngrok-did-start', this.opts.port, this._ngrokUrl);
    this.emit('ngrok-ready', this.opts.port, this._ngrokUrl);

    console.log("Connected ngrok to port " + this.opts.port + " via " + this._ngrokUrl);
    return this._ngrokUrl;
  }

  async getLoggedOutPlaceholderUsernameAsync() {
    let lpu = await UserSettings.getAsync('loggedOutPlaceholderUsername', null);
    if (!lpu) {
      let lpu = UrlUtils.randomIdentifierForLoggedOutUser();
      await UserSettings.updateAsync('loggedOutPlaceholderUsername', lpu);
    }
    return lpu;
  }

  async startOrRestartPackagerAsync(options = {}) {
    if (!this.opts.packagerPort) {
      throw new Error("`this.opts.packagerPort` must be set before starting the packager!");
    }

    let root = this.getRoot();
    if (!root) {
      throw new Error("`this.opts.absolutePath` must be set to start the packager!");
    }

    await this._stopPackagerAsync();

    let cliOpts = ['start',
      '--port', this.opts.packagerPort,
      '--projectRoots', root,
      '--assetRoots', root,
    ];

    if (options.reset) {
      cliOpts.push('--reset-cache');
    }

    // Run the copy of Node that's embedded in Electron by setting the
    // ELECTRON_RUN_AS_NODE environment variable
    // Note: the CLI script sets up graceful-fs and sets ulimit to 4096 in the
    // child process
    let packagerProcess = child_process.fork(this.opts.cliPath, cliOpts, {
      cwd: path.dirname(path.dirname(this.opts.cliPath)),
      env: {
        ...process.env,
        NODE_PATH: null,
        ELECTRON_RUN_AS_NODE: 1,
      },
      silent: true,
    });
    process.on('exit', () => {
      packagerProcess.kill();
    });
    this._packager = packagerProcess;
    this._packager.stdout.setEncoding('utf8');
    this._packager.stderr.setEncoding('utf8');
    this._packager.stdout.on('data', (data) => {
      this.emit('stdout', data);

      if (data.match(/React packager ready\./)) {
        // this._packagerReadyFulfill(this._packager);
        // this._packagerReady = true;
        this.emit('packager-ready', this._packager);
      }

      // crayon.yellow.log("STDOUT:", data);
    });

    this._packager.stderr.on('data', (data) => {
      this.emit('stderr', data);
      // crayon.orange.error("STDERR:", data);
    });

    this.packagerExited$ = new Promise((fulfill, reject) => {
      this._packagerExitedFulfill = fulfill;
      this._packagerExitedReject = reject;
    });

    this._packager.on('exit', (code) => {
      console.log("packager process exited with code", code);
      // console.log("packagerExited$ should fulfill");
      this._packagerExitedFulfill(code);
      this.emit('packager-stopped', code);
    });
  }

  async _stopLocalServerAsync() {
    if (this._expressServer) {
      console.log("Waiting for express to close...");
      await this._expressServer.close();
      console.log("Closed express; restarting...");
    }
  }

  async _stopPackagerAsync() {
    if (this._packager && (!this._packager.killed && (this._packager.exitCode === null))) {
      console.log("Stopping packager...");
      let stopped$ = new Promise((fulfill, reject) => {
        let timeout = setTimeout(() => {
          console.error("Stopping packager timed out!");
          reject();
        }, 10000);
        this._packager.on('exit', (exitCode) => {
          clearTimeout(timeout);
          fulfill(exitCode);
        });
      });
      this.emit('packager-will-stop');
      this._packager.kill('SIGTERM');
      return stopped$;
    } else {
      console.log("Packager already stopped.");
    }
  }

  async _stopNgrokAsync() {
    if (this._ngrokUrl) {
      this.emit('ngrok-will-disconnect', this._ngrokUrl);
      try {
        await ngrok.promise.disconnect(this._ngrokUrl);
        let oldNgrokUrl = this._ngrokUrl;
        this._ngrokUrl = null;
        // this._ngrokDisconnectedFulfill(oldNgrokUrl);
        // console.log("Disconnected ngrok");
        this.emit('ngrok-disconnected', oldNgrokUrl);
      } catch (e) {
        console.error("Problem disconnecting ngrok:", e);
        // this._ngrokDisconnectedReject(e);
        this.emit('ngrok-disconnect-err', e);
      }
    }
  }

  async startAsync() {
    this.validatePackageJsonAsync();

    if (!this.opts.entryPoint) {
      console.log("Determining entry point automatically...");
      this.opts.entryPoint = await Exp.determineEntryPointAsync(this.getRoot());
      console.log("Entry point: " + this.opts.entryPoint);
    }

    if (!this.opts.port || !this.opts.packagerPort) {
      let ports = await freeportAsync.rangeAsync(2, 19000);
      this.opts.port = ports[0];
      this.opts.packagerPort = ports[1];
    }

    await Promise.all([
      this.startOrRestartLocalServerAsync(),
      this.startOrRestartPackagerAsync(),
      this.startOrRestartNgrokAsync(),
    ]);

    await ProjectSettings.setPackagerInfoAsync(this.opts.absolutePath, {
      packagerPort: this.opts.packagerPort,
      port: this.opts.port,
      ngrok: this.getNgrokUrl(),
    });

    return this;
  }

  async stopAsync() {
    return await Promise.all([
      this._stopPackagerAsync(),
      this._stopNgrokAsync(),
      this._stopLocalServerAsync(),
    ]);
  }

  async getNgrokUrlAsync() {
    return this.getNgrokUrl();
  }

  getNgrokUrl() {
    if (this._ngrokUrl) {
      // ngrok reports https URLs, but to use https/TLS, we actually need to do a bunch of steps
      // to set up the certificates. Those are (somewhat) documented here:
      // https://ngrok.com/docs#tls-cert-warnings
      // Until we have that setup properly, we'll transform these URLs into http URLs
      return this._ngrokUrl.replace(/^https/, 'http');
    } else {
      return this._ngrokUrl;
    }
  }

  getProjectShortName() {
    return path.parse(this.opts.absolutePath).base;
  }

  getRoot() {
    return this.opts.absolutePath;
  }

  async validatePackageJsonAsync() {
    let pkg = await Exp.packageJsonForRoot(this.opts.absolutePath).readAsync();
    if (!pkg) {
      this.emit('stderr', `Error: Can't find package.json`);
      return;
    }

    if (!pkg.dependencies || !pkg.dependencies['react-native']) {
      this.emit('stderr', `Error: Can't find react-native in package.json dependencies`);
      return;
    }

    let reactNative = pkg.dependencies['react-native'];
    if (reactNative.indexOf('exponentjs/react-native#') === -1) {
      this.emit('stderr', `Error: Must use Exponent fork of react-native. See https://exponentjs.com/help`);
      return;
    }

    if (!pkg.exp || !pkg.exp.sdkVersion) {
      this.emit('stderr', `Error: Can't find key exp.sdkVersion in package.json. See https://exponentjs.com/help`);
      return;
    }

    let sdkVersion = pkg.exp.sdkVersion;
    if (sdkVersion === 'UNVERSIONED') {
      this.emit('stderr', `Warning: Using unversioned Exponent SDK. Do not publish until you set sdkVersion in package.json`);
      return;
    }

    let reactNativeTag = reactNative.substring(reactNative.lastIndexOf('#') + 1);

    let sdkVersions = await Api.callPathAsync('/--/sdk-versions');
    if (!sdkVersions) {
      this.emit('stderr', `Error: Couldn't connect to server`);
      return;
    }

    if (!sdkVersions[sdkVersion]) {
      this.emit('stderr', `Error: Invalid sdkVersion. Valid options are ${_.keys(sdkVersions).join(', ')}`);
      return;
    }

    let sdkVersionObject = sdkVersions[sdkVersion];
    if (sdkVersionObject['exponent-react-native-tag'] !== reactNativeTag) {
      this.emit('stderr', `Error: Invalid version of react-native for sdkVersion ${sdkVersion}. Use github:exponentjs/react-native#${sdkVersionObject['exponent-react-native-tag']}`);
      return;
    }

    // Check any native module versions here
  }
}

module.exports = PackagerController;

function _rstrip(s) {
  if (s) {
    return s.replace(/\s*$/, '');
  } else {
    return s;
  }
}

PackagerController.testInstance = (opts) => {
  let pc = new PackagerController({
    absolutePath: path.resolve(__dirname, '../template'),
    // we just let entryPoint get determined automatically by the PackagerController
    ...opts,
  });
  pc.on('stdout', (line) => { crayon.green.log(_rstrip(line)); });
  pc.on('stderr', (line) => { crayon.red.log(_rstrip(line)); });
  pc.on('packager-stopped', () => {
    crayon.orange('packager-stopped');
  });
  return pc;


}
