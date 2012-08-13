#!/usr/bin/env node
var fs = require('fs'),
    util = require('util'),
    childProcess = require('child_process'),
    dirs = [],
    path = require('path'),
    exists = fs.exists || path.exists, // yay, exists moved from path to fs in 0.7.x ... :-\
    existsSync = fs.existsSync || path.existsSync,
    spawn = childProcess.spawn,
    meta = JSON.parse(fs.readFileSync(__dirname + '/package.json')),
    exec = childProcess.exec,
    flag = './.monitor',
    child = null,
    monitor = null,
    ignoreFilePath = './.nodemonignore',
    oldIgnoreFilePath = './nodemon-ignore',
    ignoreFiles = [],
    reIgnoreFiles = null,
    timeout = 1000, // check every 1 second
    restartDelay = 0, // controlled through arg --delay 10 (for 10 seconds)
    restartTimer = null,
    lastStarted = +new Date,
    statOffset = 0, // stupid fix for https://github.com/joyent/node/issues/2705
    platform = process.platform,
    isWindows = platform === 'win32',
    noWatch = (platform !== 'win32') || !fs.watch, //  && platform !== 'linux' - removed linux fs.watch usage #72
    watchFile = platform === 'darwin' ? fs.watchFile : fs.watch, // lame :(
    watchWorks = true, // whether or not fs.watch actually works on this platform, tested and set later before starting
    // create once, reuse as needed
    reEscComments = /\\#/g,
    reUnescapeComments = /\^\^/g, // note that '^^' is used in place of escaped comments
    reComments = /#.*$/,
    reTrim = /^(\s|\u00A0)+|(\s|\u00A0)+$/g,
    reEscapeChars = /[.|\-[\]()\\]/g,
    reAsterisk = /\*/g,
    // Flag to distinguish an app crash from intentional killing (used on Windows only for now)
    killedAfterChange = false,
    // Make this the last call so it can use the variables defined above (specifically isWindows)
    program = getNodemonArgs(),
    watched = [];



// test to see if the version of find being run supports searching by seconds (-mtime -1s -print)
var testAndStart = function() {
  if (noWatch) {
    exec('find -L /dev/null -type f -mtime -1s -print', function(error, stdout, stderr) {
      if (error) {
        if (!fs.watch) {
          util.error('\x1B[1;31mThe version of node you are using combined with the version of find being used does not support watching files. Upgrade to a newer version of node, or install a version of find that supports search by seconds.\x1B[0m');
          process.exit(1);
        } else {
          noWatch = false;
          watchFileChecker.check(function(success) {
            watchWorks = success;
            startNode();
          });
        }
      } else {
        // Find is compatible with -1s
        startNode();
      }
    });
  } else {
    watchFileChecker.check(function(success) {
      watchWorks = success;
      startNode();
    });
  }
}

// This is a fallback function if fs.watch does not work
function changedSince(time, dir, callback) {
  callback || (callback = dir);
  var changed = [],
      i = 0,
      j = 0,
      dir = dir && typeof dir !== 'function' ? [dir] : dirs,
      dlen = dir.length,
      todo = 0,
      flen = 0,
      done = function () {
        todo--;
        if (todo === 0) callback(changed);
      };

  dir.forEach(function (dir) {
    todo++;
    fs.readdir(dir, function (err, files) {
      if (err) return;

      files.forEach(function (file) {
        if (program.includeHidden == true || !program.includeHidden && file.indexOf('.') !== 0) {
          todo++;
          file = path.resolve(dir + '/' + file);
          var stat = fs.stat(file, function (err, stat) {
            if (stat) {
              if (stat.isDirectory()) {
                todo++;
                changedSince(time, file, function (subChanged) {
                  if (subChanged.length) changed = changed.concat(subChanged);
                  done();
                });
              } else if (stat.mtime > time) {
                changed.push(file);
              }
            }
            done();
          });
        }
      });
      done();
    });    
  });
}

// Attempts to see if fs.watch will work. On some platforms, it doesn't.
// See: http://nodejs.org/api/fs.html#fs_caveats  
// Sends the callback true if fs.watch will work, false if it won't
//
// Caveats:
// If there is no writable tmp directory, it will also return true, although
// a warning message will be displayed.
//
var watchFileChecker = {};
watchFileChecker.check = function(cb) {
  var tmpdir,
      seperator = '/';

  this.cb = cb;
  this.changeDetected = false;
  if (isWindows) {
    seperator = '\\';
    tmpdir = process.env.TEMP;
  } else if (process.env.TMPDIR) {
    tmpdir = process.env.TMPDIR
  } else {
    tmpdir = '/tmp';
  }
  var watchFileName = tmpdir + seperator + 'nodemonCheckFsWatch'
  var watchFile = fs.openSync(watchFileName, 'w');
  if (!watchFile) {
    util.log('\x1B[32m[nodemon] Unable to write to temp directory. If you experience problems with file reloading, ensure ' + tmpdir + ' is writable.\x1B[0m');
    cb(true);
    return;
  }  
  fs.watch(watchFileName, function(event, filename) {
    if (watchFileChecker.changeDetected) { return; }
    watchFileChecker.changeDetected = true;
    cb(true);
  });
  // This should trigger fs.watch, if it works
  fs.writeSync(watchFile, '1');
  fs.unlinkSync(watchFileName);

  setTimeout(function() { watchFileChecker.verify() }, 250);
};

// Verifies that fs.watch was not triggered and sends false to the callback
watchFileChecker.verify = function() {
  if (!this.changeDetected) {
    this.cb(false);
  }
};



function startNode() {
  util.log('\x1B[32m[nodemon] starting `' + program.options.exec + ' ' + program.args.join(' ') + '`\x1B[0m');

  child = spawn(program.options.exec, program.args);

  lastStarted = +new Date;

  child.stdout.on('data', function (data) {
    util.print(data);
  });

  child.stderr.on('data', function (data) {
    process.stderr.write(data);
  });

  child.on('exit', function (code, signal) {
    // In case we killed the app ourselves, set the signal thusly
    if (killedAfterChange) {
      killedAfterChange = false;
      signal = 'SIGUSR2';
    }
    // this is nasty, but it gives it windows support
    if (isWindows && signal == 'SIGTERM') signal = 'SIGUSR2';
    // exit the monitor, but do it gracefully
    if (signal == 'SIGUSR2') {
      // restart
      startNode();
    } else if (code === 0) { // clean exit - wait until file change to restart
      util.log('\x1B[32m[nodemon] clean exit - waiting for changes before restart\x1B[0m');
      child = null;
    } else if (program.options.exitcrash) {
      util.log('\x1B[1;31m[nodemon] app crashed\x1B[0m');
      process.exit(0);
    } else {
      util.log('\x1B[1;31m[nodemon] app crashed - waiting for file changes before starting...\x1B[0m');
      child = null;
    }
  });

  // pinched from https://github.com/DTrejo/run.js - pipes stdin to the child process - cheers DTrejo ;-)
  if (program.options.stdin) {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.pipe(child.stdin);
  }

  setTimeout(startMonitor, timeout);
}

function startMonitor() {
  var changeFunction;

  if (noWatch) {
    // if native fs.watch doesn't work the way we want, we keep polling find command (mac only oddly)
    changeFunction = function (lastStarted, callback) {
      var cmds = [],
          changed = [];

      dirs.forEach(function(dir) {
        cmds.push('find -L "' + dir + '" -type f -mtime -' + ((+new Date - lastStarted)/1000|0) + 's -print');
      });

      exec(cmds.join(';'), function (error, stdout, stderr) {
        var files = stdout.split(/\n/);
        files.pop(); // remove blank line ending and split
        callback(files);
      });
    }
  } else if (watchWorks) {
    changeFunction = function (lastStarted, callback) {
      // recursive watch - watch each directory and it's subdirectories, etc, etc
      var watch = function (err, dir) {
        try {
          fs.watch(dir, { persistent: false }, function (event, filename) {
            var filepath = path.join(dir, filename);
            callback([filepath]);
          });

          fs.readdir(dir, function (err, files) {
            if (!err) {
              files = files.
                map(function (file ) { return path.join(dir, file); }).
                filter(ignoredFilter);
              files.forEach(function (file) {
                if (-1 === watched.indexOf(file)) {
                  watched.push(file);
                  fs.stat(file, function (err, stat) {
                    if (!err && stat) {
                      if (stat.isDirectory()) {
                        fs.realpath(file, watch);
                      }
                    }
                  });
                }
              });
            }
          });
        } catch (e) {
          if ('EMFILE' === e.code) {
            console.error('EMFILE: Watching too many files.');
          }
          // ignoring this directory, likely it's "My Music"
          // or some such windows fangled stuff
        }
      }
      dirs.forEach(function (dir) {
        fs.realpath(dir, watch);
      });
    }  
  } else {
    // changedSince, the fallback for when both the find method and fs.watch don't work, 
    // is not compatible with the way changeFunction works. If we have reached this point,
    // changeFunction should not be called from herein out. 
    changeFunction = function() { util.error("Nodemon error: changeFunction called when it shouldn't be.") }
  }

  // filter ignored files
  var ignoredFilter = function (file) {
    // If we are in a Windows machine
    if (isWindows) {
      // Break up the file by slashes
      var fileParts = file.split(/\\/g);

      // Remove the first piece (C:)
      fileParts.shift();

      // Join the parts together with Unix slashes
      file = '/' + fileParts.join('/');
    }
    return !reIgnoreFiles.test(file);
  };

  var isWindows = process.platform === 'win32';
  if ((noWatch || watchWorks) && !program.options.forceLegacyWatch) {
    changeFunction(lastStarted, function (files) {
      if (files.length) {
        files = files.filter(ignoredFilter);
        if (files.length) {
          if (restartTimer !== null) clearTimeout(restartTimer);
          restartTimer = setTimeout(function () {
            if (program.options.verbose) util.log('[nodemon] restarting due to changes...');
            files.forEach(function (file) {
              if (program.options.verbose) util.log('[nodemon] ' + file);
            });
            if (program.options.verbose) util.print('\n\n');

            killNode();
            
          }, restartDelay);
          return;
        }
      }

      if (noWatch) setTimeout(startMonitor, timeout);
    });
  } else {
    // Fallback for when both find and fs.watch don't work
    changedSince(lastStarted, function (files) {
      if (files.length) {
        // filter ignored files
        if (ignoreFiles.length) {
          files = files.filter(function(file) {
            return !reIgnoreFiles.test(file);
          });
        }

        if (files.length) {
          if (restartTimer !== null) clearTimeout(restartTimer);
          restartTimer = setTimeout(function () {
            if (program.options.verbose) util.log('[nodemon] restarting due to changes...');
            files.forEach(function (file) {
              if (program.options.verbose) util.log('[nodemon] ' + file);
            });
            if (program.options.verbose) util.print('\n\n');

            killNode();
            
          }, restartDelay);
          return;
        }
      }

      setTimeout(startMonitor, timeout);
    });
  }
}

function killNode() {
  if (child !== null) {
    // When using CoffeeScript under Windows, child's process is not node.exe
    // Instead coffee.cmd is launched, which launches cmd.exe, which starts node.exe as a child process
    // child.kill() would only kill cmd.exe, not node.exe
    // Therefore we use the Windows taskkill utility to kill the process and all its children (/T for tree)
    if (isWindows) {
      // For the on('exit', ...) handler above the following looks like a crash, so we set the killedAfterChange flag
      killedAfterChange = true;
      // Force kill (/F) the whole child tree (/T) by PID (/PID 123)
      exec('taskkill /pid '+child.pid+' /T /F');
    } else {
      child.kill('SIGUSR2');
    }
  } else {
    startNode();
  }
}

function addIgnoreRule(line, noEscape) {
  // remove comments and trim lines
  // this mess of replace methods is escaping "\#" to allow for emacs temp files
  if (!noEscape) {
    if (line = line.replace(reEscComments, '^^').replace(reComments, '').replace(reUnescapeComments, '#').replace(reTrim, '')) {
       ignoreFiles.push(line.replace(reEscapeChars, '\\$&').replace(reAsterisk, '.*'));
    }
  } else if (line = line.replace(reTrim, '')) {
    ignoreFiles.push(line);
  }
  reIgnoreFiles = new RegExp(ignoreFiles.join('|'));
}

function readIgnoreFile(curr, prev) {
  // unless the ignore file was actually modified, do no re-read it
  if(curr && prev && curr.mtime.valueOf() === prev.mtime.valueOf()) return;

  if (platform === 'darwin') fs.unwatchFile(ignoreFilePath);

  // Check if ignore file still exists. Vim tends to delete it before replacing with changed file
  exists(ignoreFilePath, function(exists) {
    if (program.options.verbose) util.log('[nodemon] reading ignore list');

    // ignoreFiles = ignoreFiles.concat([flag, ignoreFilePath]);
    // addIgnoreRule(flag);
    addIgnoreRule(ignoreFilePath.substring(2)); // ignore the ./ part of the filename
    fs.readFileSync(ignoreFilePath).toString().split(/\n/).forEach(function (rule, i) {
      addIgnoreRule(rule);
    });

    watchFile(ignoreFilePath, { persistent: false }, readIgnoreFile);
  });
}

// attempt to shutdown the wrapped node instance and remove
// the monitor file as nodemon exists
function cleanup() {
  child && child.kill();
  // fs.unlink(flag);
}

function getNodemonArgs() {
  var args = process.argv,
      len = args.length,
      i = 2,
      dir = process.cwd(),
      indexOfApp = -1,
      app = null;

  for (; i < len; i++) {
    if (existsSync(path.resolve(dir, args[i]))) {
      // double check we didn't use the --watch or -w opt before this arg
      if (args[i-1] && (args[i-1] == '-w' || args[i-1] == '--watch')) {
        // ignore
      } else {
        indexOfApp = i;
        break;
      }
    }
  }

  if (indexOfApp !== -1) {
    // not found, so assume we're reading the package.json and thus swallow up all the args
    // indexOfApp = len;
    app = process.argv[i];
    indexOfApp++;
  } else {
    indexOfApp = len;
  }

  var appargs = [], //process.argv.slice(indexOfApp),
      // app = appargs[0],
      nodemonargs = process.argv.slice(2, indexOfApp - (app ? 1 : 0)),
      arg,
      options = {
        delay: 1,
        watch: [],
        ext: "js,coffee",
        exec: 'node',
        verbose: true,
        js: false, // becomes the default anyway...
        includeHidden: false,
        exitcrash: false,
        watchAll: false,
        forceLegacyWatch: false, // forces nodemon to use the slowest but most compatible method for watching for file changes
        stdin: true
        // args: []
      };

  // process nodemon args
  args.splice(0, 2);
  while (arg = args.shift()) {
    if (arg === '--help' || arg === '-h' || arg === '-?') {
      return help(); // exits program
    } else if (arg === '--version' || arg == '-v') {
      return version(); // also exits
    } else if (arg == '--js') {
      options.js = true;
    } else if (arg == '--quiet' || arg == '-q') {
      options.verbose = false;
    } else if (arg == '--hidden') {
      options.includeHidden = true;
    } else if (arg === '--watch' || arg === '-w') {
      options.watch.push(args.shift());
    } else if (arg === '--all' || arg === '-a') {
      options.watchAll = true;
    } else if (arg === '--ext' || arg === '-t') {
      options.ext = args.shift();
    }else if (arg === '--exitcrash') {
      options.exitcrash = true;
    } else if (arg === '--delay' || arg === '-d') {
      options.delay = parseInt(args.shift());
    } else if (arg === '--exec' || arg === '-x') {
      options.exec = args.shift();
    } else if (arg == '--legacy-watch' || arg == '-L') {
      options.forceLegacyWatch = true;
    } else if (arg === '--no-stdin' || arg === '-I') {
      options.stdin = false;
    } else { //if (arg === "--") {
      // Remaining args are node arguments
      appargs.push(arg);
    }
  }

  var program = { options: options, args: appargs, app: app };

  getAppScript(program);

  return program;
}

function getAppScript(program) {
  var hokeycokey = false;
  if (!program.args.length || program.app === null) {
    // try to get the app from the package.json
    // doing a try/catch because we can't use the path.exist callback pattern
    // or we could, but the code would get messy, so this will do exactly
    // what we're after - if the file doesn't exist, it'll throw.
    try {
      // note: this isn't nodemon's package, it's the user's cwd package
      program.app = JSON.parse(fs.readFileSync('./package.json').toString()).main;
      if (program.app === undefined) {
        // no app found to run - so give them a tip and get the feck out
        help();
      }
      program.args.unshift(program.app);
      hokeycokey = true;
    } catch (e) {}
  }

  if (!program.app) {
    program.app = program.args[0];
  }

  program.app = path.basename(program.app);
  program.ext = path.extname(program.app);

  if (program.options.exec.indexOf(' ') !== -1) {
    var execOptions = program.options.exec.split(' ');
    program.options.exec = execOptions.splice(0, 1)[0];
    program.args = execOptions.concat(program.args);
  }

  if (program.options.exec === 'node' && program.ext == '.coffee') {
    program.options.exec = 'coffee';
  }

  if (program.options.exec === 'coffee') {
    if (hokeycokey) {
      program.args.push(program.args.shift());
    }
    //coffeescript requires --nodejs --debug
    var debugIndex = program.args.indexOf('--debug');
    if (debugIndex === -1) debugIndex = program.args.indexOf('--debug-brk');
    if (debugIndex !== -1 && program.args.indexOf('--nodejs') === -1) {
      program.args.splice(debugIndex, 0, '--nodejs');
    }
    // monitor both types - TODO possibly make this an option?
    program.ext = '.coffee|.js';
    if (!program.options.exec || program.options.exec == 'node') program.options.exec = 'coffee';

    // because windows can't find 'coffee', it needs the real file 'coffee.cmd'
    if (isWindows) program.options.exec += '.cmd';
  }
}

function findStatOffset() {
  var filename = './.stat-test';
  fs.writeFile(filename, function (err) {
    if (err) return;
    fs.stat(filename, function (err, stat) {
      if (err) return;

      statOffset = stat.mtime.getTime() - new Date().getTime();
      fs.unlink(filename);
    });
  });
}

function version() {
  console.log(meta.version);
  process.exit(0);
}

function help() {
  util.print([
    '',
    ' Usage: nodemon [options] [script.js] [args]',
    '',
    ' Options:',
    '',
    '  -d, --delay n      throttle restart for "n" seconds',
    '  -w, --watch dir    watch directory "dir". use once for each',
    '                     directory to watch',
    '  -a, --all          watch all files in the watch directory',
    '  -t, --ext          comma seperated file extensions to watch',
    '  -x, --exec app     execute script with "app", ie. -x "python -v"',
    '  -I, --no-stdin     don\'t try to read from stdin',
    '  -q, --quiet        minimise nodemon messages to start/stop only',
    '  --exitcrash        exit on crash, allows use of nodemon with',
    '                     daemon tools like forever.js',
    '  -L, --legacy-watch Forces node to use the most compatible',
    '                     version for watching file changes',
    '  -v, --version      current nodemon version',
    '  -h, --help         you\'re looking at it',
    '',
    ' Note: if the script is omitted, nodemon will try to read ',
    ' "main" from package.json and without a .nodemonignore, nodemon',
    ' will monitor .js and .coffee by default unless the --all flag is set.',
    '',
    ' Examples:',
    '',
    '  $ nodemon server.js',
    '  $ nodemon -w ../foo server.js apparg1 apparg2',
    '  $ PORT=8000 nodemon --debug-brk server.js',
    '  $ nodemon --exec python app.py',
    '',
    ' For more details see http://github.com/remy/nodemon/',
    ''
  ].join('\n') + '\n');
  process.exit(0);
}

// this little bit of hoop jumping is because sometimes the file can't be
// touched properly, and it send nodemon in to a loop of restarting.
// this way, the .monitor file is removed entirely, and recreated with
// permissions that anyone can remove it later (i.e. if you run as root
// by accident and then try again later).
// if (path.existsSync(flag)) fs.unlinkSync(flag);
// fs.writeFileSync(flag, '.'); // requires some content https://github.com/remy/nodemon/issues/36
// fs.chmodSync(flag, '666');

// remove the flag file on exit
process.on('exit', function (code) {
  if (program.options.verbose) util.log('[nodemon] exiting');
  cleanup();
});

if (!isWindows) { // because windows borks when listening for the SIG* events
  // usual suspect: ctrl+c exit
  process.on('SIGINT', function () {
    child && child.kill('SIGINT');
    cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', function () {
    cleanup();
    process.exit(0);
  });
}

// TODO on a clean exit, we could continue to monitor the directory and reboot the service

// on exception *inside* nodemon, shutdown wrapped node app
process.on('uncaughtException', function (err) {
  util.log('[nodemon] exception in nodemon killing node');
  util.error(err.stack);
  cleanup();
});


if (program.options.delay) {
  restartDelay = program.options.delay * 1000;
}

// this is the default - why am I making it a cmd line opt?
if (program.options.js) {
  addIgnoreRule('^((?!\.js|\.coffee$).)*$', true); // ignores everything except JS
}


if (program.options.watch && program.options.watch.length > 0) {
  program.options.watch.forEach(function (dir) {
    dirs.push(path.resolve(dir));
  });
} else {
  dirs.unshift(process.cwd());
}

if (!program.app) {
  help();
}

if (program.options.verbose) util.log('[nodemon] v' + meta.version);

// this was causing problems for a lot of people, so now not moving to the subdirectory
// process.chdir(path.dirname(app));
dirs.forEach(function(dir) {
  if (program.options.verbose) util.log('\x1B[32m[nodemon] watching: ' + dir + '\x1B[0m');
});

// findStatOffset();

exists(ignoreFilePath, function (exist) {
  // watch it: "exist" not to be confused with "exists"....
  if (!exist) {
    // try the old format
    exists(oldIgnoreFilePath, function (exist) {
      if (exist) {
        if (program.options.verbose) util.log('[nodemon] detected old style .nodemonignore');
        ignoreFilePath = oldIgnoreFilePath;
      } else {
        // don't create the ignorefile, just ignore the flag & JS
        // addIgnoreRule(flag);
        if(program.options.watchAll){
          addIgnoreRule('^((?!\..$).)*$', true); // ignores everything except JS
        }
        else if(program.options.ext){
          var mon = program.options.ext.split(',').map(function(ext){
            return '\.' + ext;
          }).join('|');
          addIgnoreRule('^((?!' + mon + '$).)*$', true);
        }else{
          var ext = program.ext.replace(/\./g, '\\.');
          if (ext) {
            addIgnoreRule('^((?!' + ext + '$).)*$', true);
          } else {
            addIgnoreRule('^((?!\.js|\.coffee$).)*$', true); // ignores everything except JS
          }
        }
      }
    });
  } else {
    readIgnoreFile();
  }
});

testAndStart();
