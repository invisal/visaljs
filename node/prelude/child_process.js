// node:child_process: Node's lib/child_process.js and the ChildProcess of
// lib/internal/child_process.js (MIT; Node v22.22.2), ported: spawn, exec and execFile, their
// synchronous forms, and ChildProcess with its events (spawn, exit, close, error), kill, ref and
// stdio. A child's stdio pipes are net.Sockets on pipe handles, as in Node; the process and the
// synchronous runs are libuv's (src/host_process.c). Not here: fork() and the 'ipc' stdio, which
// start a Node with a channel to it (a compiled program has no Node to start), and handles of
// UDP sockets as stdio. Node's notice for lib/child_process.js:
//
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
import {
  errnoName, netOpen, netReadStop, osConstants, processClose, processKillChild, processRef, processSpawn, processSpawnSync,
  utilInspect as inspect,
} from "visaljs:host";
import { Buffer } from "./buffer.js";
import { EventEmitter } from "./events.js";
import { codeError, errnoException, invalidArgType, invalidArgValue, notSupported, outOfRange, validateFunction, validateString } from "./internal/errors.js";
import { Socket } from "./net.js";
import { isArrayBufferView } from "./util_types.js";

const MAX_BUFFER = 1024 * 1024;
const kIsUsedAsStdio = Symbol("kIsUsedAsStdio");
const kCustomPromisify = Symbol.for("nodejs.util.promisify.custom");

/* "SIGTERM" ↔ 15, as os.constants.signals; libuv's errno numbers by name */
const signals = Object.create(null);
const signalNames = Object.create(null);
const errnos = Object.create(null);
{
  const [signalTable, errnoTable] = osConstants();
  for (let i = 0; i < signalTable.length; i += 2) {
    signals[signalTable[i]] = signalTable[i + 1];
    signalNames[signalTable[i + 1]] ??= signalTable[i];
  }
  for (let i = 0; i < errnoTable.length; i += 2) errnos[errnoTable[i]] = -errnoTable[i + 1];
}
const UV_EACCES = errnos.EACCES, UV_EAGAIN = errnos.EAGAIN, UV_EMFILE = errnos.EMFILE, UV_ENFILE = errnos.ENFILE;
const UV_ENOENT = errnos.ENOENT, UV_EINVAL = errnos.EINVAL, UV_ENOSYS = errnos.ENOSYS, UV_ESRCH = errnos.ESRCH;

// ---- Node's errors and validators ---------------------------------------------------------

/** Node's ErrnoException: `spawn x ENOENT`, with errno, code and syscall. */
const ErrnoException = (err, syscall) => errnoException(err, syscall);

function genericNodeError(message, errorProperties) {
  const err = new Error(message);
  Object.assign(err, errorProperties);
  return err;
}

function convertToValidSignal(signal) {
  if (typeof signal === "number" && signalNames[signal] !== undefined) return signal;
  if (typeof signal === "string") {
    const signalName = signals[signal.toUpperCase()];
    if (signalName) return signalName;
  }
  throw codeError(TypeError, "ERR_UNKNOWN_SIGNAL", `Unknown signal: ${signal}`);
}

function validateObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidArgType(name, "of type object", value);
}

function validateArray(value, name) {
  if (!Array.isArray(value)) throw invalidArgType(name, "an instance of Array", value);
}

function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw invalidArgType(name, "of type boolean", value);
}

function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
}

function validateArgumentNullCheck(arg, propName) {
  if (typeof arg === "string" && arg.includes("\u0000")) {
    throw invalidArgValue(propName, "must be a string without null bytes", arg);
  }
}

function validateArgumentsNullCheck(args, propName) {
  for (let i = 0; i < args.length; ++i) {
    validateArgumentNullCheck(args[i], `${propName}[${i}]`);
  }
}

function validateTimeout(timeout) {
  if (timeout != null && !(Number.isInteger(timeout) && timeout >= 0)) {
    throw outOfRange("timeout", "an unsigned integer", timeout);
  }
}

function validateMaxBuffer(maxBuffer) {
  if (maxBuffer != null && !(typeof maxBuffer === "number" && maxBuffer >= 0)) {
    throw outOfRange("options.maxBuffer", "a positive number", maxBuffer);
  }
}

function sanitizeKillSignal(killSignal) {
  if (typeof killSignal === "string" || typeof killSignal === "number") {
    return convertToValidSignal(killSignal);
  } else if (killSignal != null) {
    throw invalidArgType("options.killSignal", "of type string or number", killSignal);
  }
}

/** Node's getValidatedPath: a string, a Buffer or a file: URL, without null bytes. */
function getValidatedPath(path, name) {
  if (path instanceof URL) {
    if (path.protocol !== "file:") throw codeError(TypeError, "ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
    path = decodeURIComponent(path.pathname);
  } else if (isArrayBufferView(path)) {
    path = Buffer.from(path.buffer, path.byteOffset, path.byteLength).toString();
  } else if (typeof path !== "string") {
    throw invalidArgType(name, "of type string or an instance of Buffer or URL", path);
  }
  if (path.includes("\u0000")) throw invalidArgValue(name, "must be a string, Uint8Array, or URL without null bytes", path);
  return path;
}

const isInt32 = (value) => value === (value | 0);

// ---- ChildProcess (lib/internal/child_process.js) -----------------------------------------

function stdioStringToArray(stdio, channel) {
  const options = [];

  switch (stdio) {
    case "ignore":
    case "overlapped":
    case "pipe": options.push(stdio, stdio, stdio); break;
    case "inherit": options.push(0, 1, 2); break;
    default:
      throw invalidArgValue("stdio", "is invalid", stdio);
  }

  if (channel) options.push(channel);

  return options;
}

/* a pipe the child is given: a node:net pipe handle, a net.Socket's once the child has it */
class Pipe {
  constructor() {
    this.id = netOpen(true, undefined);
  }

  close() {
    new Socket({ handle: this.id, _isPipe: true, readable: false }).destroy();
  }
}

/* a net.Socket (or a stream with one) whose handle the child inherits */
const socketHandle = (stdio) => (stdio instanceof Socket && stdio._handle !== null ? stdio._handle : undefined);

function getValidStdio(stdio, sync) {

  // Replace shortcut with an array
  if (typeof stdio === "string") {
    stdio = stdioStringToArray(stdio);
  } else if (!Array.isArray(stdio)) {
    throw invalidArgValue("stdio", "is invalid", stdio);
  }

  // At least 3 stdio will be created
  while (stdio.length < 3) stdio.push(undefined);

  // Translate stdio into C-readable form (i.e. pipes or fds)
  stdio = stdio.reduce((acc, stdio, i) => {
    function cleanup() {
      for (let i = 0; i < acc.length; i++) {
        if (acc[i].type === "pipe" && acc[i].handle) acc[i].handle.close();
      }
    }

    // Defaults
    stdio ??= i < 3 ? "pipe" : "ignore";

    if (stdio === "ignore") {
      acc.push({ type: "ignore" });
    } else if (stdio === "pipe" || stdio === "overlapped" || (typeof stdio === "number" && stdio < 0)) {
      const a = {
        type: stdio === "overlapped" ? "overlapped" : "pipe",
        readable: i === 0,
        writable: i !== 0,
      };

      if (!sync) a.handle = new Pipe();

      acc.push(a);
    } else if (stdio === "ipc") {
      cleanup();
      throw notSupported(sync ? "spawnSync()'s 'ipc' stdio" : "The 'ipc' stdio");
    } else if (stdio === "inherit") {
      acc.push({ type: "inherit", fd: i });
    } else if (typeof stdio === "number" || typeof stdio.fd === "number") {
      acc.push({ type: "fd", fd: typeof stdio === "number" ? stdio : stdio.fd });
    } else if (socketHandle(stdio) !== undefined || socketHandle(stdio.handle) !== undefined || socketHandle(stdio._handle) !== undefined) {
      const socket = socketHandle(stdio) !== undefined ? stdio : socketHandle(stdio.handle) !== undefined ? stdio.handle : stdio._handle;
      acc.push({ type: "wrap", handle: socket._handle, wrapped: socket, _stdio: stdio });  /* not the child's own stream: stdin… stay null, as Node's */
    } else if (isArrayBufferView(stdio) || typeof stdio === "string") {
      if (!sync) {
        cleanup();
        throw codeError(TypeError, "ERR_INVALID_SYNC_FORK_INPUT", `Asynchronous forks do not support Buffer, TypedArray, DataView or string input: ${inspect(stdio)}`);
      }
    } else {
      // Cleanup
      cleanup();
      throw invalidArgValue("stdio", "is invalid", stdio);
    }

    return acc;
  }, []);

  return { stdio };
}

/* stdio as the host takes it: [kind, value] each */
function hostStdio(stdio) {
  return stdio.map((s) => {
    switch (s.type) {
      case "pipe": return [1, s.handle?.id ?? s.input ?? null];
      case "overlapped": return [2, s.handle?.id ?? s.input ?? null];
      case "inherit":
      case "fd": return [3, s.fd];
      case "wrap": return [4, s.handle];
      default: return [0, null];
    }
  });
}

function spawnFlags(options) {
  return (options.detached ? 1 : 0) | (options.windowsHide ? 2 : 0) | (options.windowsVerbatimArguments ? 4 : 0);
}

/** A child process: Node's ChildProcess. */
export function ChildProcess() {
  EventEmitter.call(this);

  this._closesNeeded = 1;
  this._closesGot = 0;
  this.connected = false;

  this.signalCode = null;
  this.exitCode = null;
  this.killed = false;
  this.spawnfile = null;

  this._handle = { id: -1, pid: 0 };
  this._onexit = (exitCode, signalCode) => {
    if (signalCode) {
      this.signalCode = signalCode;
    } else {
      this.exitCode = exitCode;
    }

    if (this.stdin) {
      this.stdin.destroy();
    }

    if (this._handle?.id >= 0) processClose(this._handle.id);
    this._handle = null;

    if (exitCode < 0) {
      const syscall = this.spawnfile ? "spawn " + this.spawnfile : "spawn";
      const err = ErrnoException(exitCode, syscall);

      if (this.spawnfile) err.path = this.spawnfile;

      err.spawnargs = this.spawnargs.slice(1);
      this.emit("error", err);
    } else {
      this.emit("exit", this.exitCode, this.signalCode);
    }

    // If any of the stdio streams have not been touched,
    // then pull all the data through so that it can get the
    // eof and emit a 'close' event.
    // Do it on nextTick so that the user has one last chance
    // to consume the output, if for example they only want to
    // start reading the data once the process exits.
    process.nextTick(flushStdio, this);

    maybeClose(this);
  };
}
Object.setPrototypeOf(ChildProcess.prototype, EventEmitter.prototype);
Object.setPrototypeOf(ChildProcess, EventEmitter);

function flushStdio(subprocess) {
  const stdio = subprocess.stdio;

  if (stdio == null) return;

  for (let i = 0; i < stdio.length; i++) {
    const stream = stdio[i];
    if (!stream || !stream.readable || stream[kIsUsedAsStdio]) {
      continue;
    }
    stream.resume();
  }
}

function createSocket(pipe, readable) {
  return new Socket({ handle: pipe.id, _isPipe: true, readable });
}

ChildProcess.prototype.spawn = function spawn(options) {
  let i;

  validateObject(options, "options");

  // If no `stdio` option was given - use default
  let stdio = options.stdio || "pipe";

  stdio = getValidStdio(stdio, false);

  stdio = options.stdio = stdio.stdio;

  if (options.serialization !== undefined && options.serialization !== "json" && options.serialization !== "advanced") {
    throw invalidArgValue("options.serialization", "must be one of: undefined, 'json', 'advanced'", options.serialization);
  }

  validateString(options.file, "options.file");
  this.spawnfile = options.file;

  if (options.args === undefined) {
    this.spawnargs = [];
  } else {
    validateArray(options.args, "options.args");
    this.spawnargs = options.args;
  }

  const result = processSpawn(options.file, this.spawnargs, options.envPairs ?? null, options.cwd ?? null, hostStdio(stdio),
    spawnFlags(options), options.uid ?? -1, options.gid ?? -1,
    (exitStatus, termSignal) => this._onexit(exitStatus, termSignal ? signalNames[termSignal] ?? termSignal : null));
  const err = result[0];
  if (err === 0) {
    this._handle.id = result[1];
    this._handle.pid = result[2];
  }

  // Run-time errors should emit an error, not throw an exception.
  if (err === UV_EACCES || err === UV_EAGAIN || err === UV_EMFILE || err === UV_ENFILE || err === UV_ENOENT) {
    process.nextTick(onErrorNT, this, err);

    // There is no point in continuing when we've hit EMFILE or ENFILE
    // because we won't be able to set up the stdio file descriptors.
    if (err === UV_EMFILE || err === UV_ENFILE) return err;
  } else if (err) {
    // Close all opened fds on error
    for (i = 0; i < stdio.length; i++) {
      const stream = stdio[i];
      if (stream.type === "pipe") {
        stream.handle.close();
      }
    }

    this._handle = null;
    throw ErrnoException(err, "spawn");
  } else {
    process.nextTick(onSpawnNT, this);
  }

  this.pid = this._handle.pid || undefined;

  for (i = 0; i < stdio.length; i++) {
    const stream = stdio[i];
    if (stream.type === "ignore") continue;

    // The stream is already cloned and piped, thus stop its readable side,
    // otherwise we might attempt to read from the stream when at the same time
    // the child process does.
    if (stream.type === "wrap") {
      if (stream.wrapped._handle !== null) {
        stream.wrapped._reading = false;
        netReadStop(stream.wrapped._handle);
      }
      stream._stdio.pause();
      stream._stdio.readableFlowing = false;
      stream._stdio._readableState.reading = false;
      stream._stdio[kIsUsedAsStdio] = true;
      continue;
    }

    if (stream.handle) {
      if (this._handle.pid !== 0) {
        stream.socket = createSocket(stream.handle, i > 0);
      } else {
        stream.handle.close();
        stream.socket = new Socket({ readable: i > 0 });
      }

      if (i > 0 && this._handle.pid !== 0) {
        this._closesNeeded++;
        stream.socket.on("close", () => {
          maybeClose(this);
        });
      }
    }
  }

  this.stdin = stdio.length >= 1 && stdio[0].socket !== undefined ? stdio[0].socket : null;
  this.stdout = stdio.length >= 2 && stdio[1].socket !== undefined ? stdio[1].socket : null;
  this.stderr = stdio.length >= 3 && stdio[2].socket !== undefined ? stdio[2].socket : null;

  this.stdio = [];

  for (i = 0; i < stdio.length; i++) this.stdio.push(stdio[i].socket === undefined ? null : stdio[i].socket);

  return err;
};

function onErrorNT(self, err) {
  self._onexit(err);
}

function onSpawnNT(self) {
  self.emit("spawn");
}

ChildProcess.prototype.kill = function kill(sig) {
  const signal = sig === 0 ? sig : convertToValidSignal(sig === undefined ? "SIGTERM" : sig);

  if (this._handle) {
    const err = processKillChild(this._handle.id, signal);
    if (err === 0) {
      /* Success. */
      this.killed = true;
      return true;
    }
    if (err === UV_ESRCH) {
      /* Already dead. */
    } else if (err === UV_EINVAL || err === UV_ENOSYS) {
      /* The underlying platform doesn't support this signal. */
      throw ErrnoException(err, "kill");
    } else {
      /* Other error, almost certainly EPERM. */
      this.emit("error", ErrnoException(err, "kill"));
    }
  }

  /* Kill didn't succeed. */
  return false;
};

if (typeof Symbol.dispose === "symbol") {
  ChildProcess.prototype[Symbol.dispose] = function () {
    if (!this.killed) {
      this.kill();
    }
  };
}

ChildProcess.prototype.ref = function ref() {
  if (this._handle) processRef(this._handle.id, true);
};

ChildProcess.prototype.unref = function unref() {
  if (this._handle) processRef(this._handle.id, false);
};

ChildProcess.prototype.send = function send() {
  throw codeError(Error, "ERR_IPC_CHANNEL_CLOSED", "Channel closed");
};

ChildProcess.prototype.disconnect = function disconnect() {
  this.emit("error", codeError(Error, "ERR_IPC_DISCONNECTED", "IPC channel is already disconnected"));
};

function maybeClose(subprocess) {
  subprocess._closesGot++;

  if (subprocess._closesGot === subprocess._closesNeeded) {
    subprocess.emit("close", subprocess.exitCode, subprocess.signalCode);
  }
}

// ---- The module (lib/child_process.js) ----------------------------------------------------

/** Node's fork(): a Node running a module, with a channel to it. */
/* Node's fork, as far as its checks: the arguments are validated as Node's (a bad one is the same
 * error), then it can't start the Node it needs. Its body starts with the throw so that
 * tests/compat/node.ts counts it a stub. */
export function fork(modulePath, args = [], options) {
  throw notSupported(validateFork(modulePath, args, options));
}

function validateFork(modulePath, args, options) {
  modulePath = getValidatedPath(modulePath, "modulePath");
  if (args == null) {
    args = [];
  } else if (typeof args === "object" && !Array.isArray(args)) {
    options = args;
    args = [];
  } else {
    validateArray(args, "args");
  }
  if (options != null) validateObject(options, "options");
  options = { __proto__: null, ...options, shell: false };
  options.execPath ||= process.execPath;
  validateArgumentNullCheck(options.execPath, "options.execPath");
  const execArgv = options.execArgv || process.execArgv;
  validateArgumentsNullCheck(execArgv, "options.execArgv");
  normalizeSpawnArguments(options.execPath, [...execArgv, modulePath, ...args], options);
  return "child_process.fork() (it starts a Node, which a compiled program doesn't have)";
}

export function _forkChild() {
  throw notSupported("child_process._forkChild()");
}

function normalizeExecArgs(command, options, callback) {
  validateString(command, "command");
  validateArgumentNullCheck(command, "command");

  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }

  // Make a shallow copy so we don't clobber the user's options object.
  options = { __proto__: null, ...options };
  options.shell = typeof options.shell === "string" ? options.shell : true;

  return { file: command, options, callback };
}

/** Spawns a shell executing the given command; callback(error, stdout, stderr). */
export function exec(command, options, callback) {
  const opts = normalizeExecArgs(command, options, callback);
  return execFile(opts.file, opts.options, opts.callback);
}

const customPromiseExecFunction = (orig) => {
  const fn = function (...args) {
    const { promise, resolve, reject } = Promise.withResolvers();

    promise.child = orig(...args, (err, stdout, stderr) => {
      if (err !== null) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });

    return promise;
  };
  Object.defineProperty(fn, "name", { value: orig.name });
  return fn;
};

Object.defineProperty(exec, kCustomPromisify, { enumerable: false, value: customPromiseExecFunction(exec) });

function normalizeExecFileArgs(file, args, options, callback) {
  if (Array.isArray(args)) {
    args = args.slice();
  } else if (args != null && typeof args === "object") {
    callback = options;
    options = args;
    args = null;
  } else if (typeof args === "function") {
    callback = args;
    options = null;
    args = null;
  }

  args ??= [];

  if (typeof options === "function") {
    callback = options;
  } else if (options != null) {
    validateObject(options, "options");
  }

  options ??= {};

  if (callback != null) {
    validateFunction(callback, "callback");
  }

  // Validate argv0, if present.
  if (options.argv0 != null) {
    validateString(options.argv0, "options.argv0");
    validateArgumentNullCheck(options.argv0, "options.argv0");
  }

  return { file, args, options, callback };
}

/** Spawns a file (or a command, with options.shell); callback(error, stdout, stderr). */
export function execFile(file, args, options, callback) {
  ({ file, args, options, callback } = normalizeExecFileArgs(file, args, options, callback));

  options = {
    __proto__: null,
    encoding: "utf8",
    timeout: 0,
    maxBuffer: MAX_BUFFER,
    killSignal: "SIGTERM",
    cwd: null,
    env: null,
    shell: false,
    ...options,
  };

  // Validate the timeout, if present.
  validateTimeout(options.timeout);

  // Validate maxBuffer, if present.
  validateMaxBuffer(options.maxBuffer);

  options.killSignal = sanitizeKillSignal(options.killSignal);

  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    gid: options.gid,
    shell: options.shell,
    signal: options.signal,
    uid: options.uid,
    windowsHide: !!options.windowsHide,
    windowsVerbatimArguments: !!options.windowsVerbatimArguments,
  });

  let encoding;
  const _stdout = [];
  const _stderr = [];
  if (options.encoding !== "buffer" && Buffer.isEncoding(options.encoding)) {
    encoding = options.encoding;
  } else {
    encoding = null;
  }
  let stdoutLen = 0;
  let stderrLen = 0;
  let killed = false;
  let exited = false;
  let timeoutId;

  let ex = null;

  let cmd = file;

  function exithandler(code, signal) {
    if (exited) return;
    exited = true;

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (!callback) return;

    // merge chunks
    let stdout;
    let stderr;
    if (encoding || child.stdout?.readableEncoding) {
      stdout = _stdout.join("");
    } else {
      stdout = Buffer.concat(_stdout);
    }
    if (encoding || child.stderr?.readableEncoding) {
      stderr = _stderr.join("");
    } else {
      stderr = Buffer.concat(_stderr);
    }

    if (!ex && code === 0 && signal === null) {
      callback(null, stdout, stderr);
      return;
    }

    if (args?.length) cmd += ` ${args.join(" ")}`;

    ex ||= genericNodeError(`Command failed: ${cmd}\n${stderr}`, {
      code: code < 0 ? errnoName(code) : code,
      killed: child.killed || killed,
      signal: signal,
    });

    ex.cmd = cmd;
    callback(ex, stdout, stderr);
  }

  function errorhandler(e) {
    ex = e;

    if (child.stdout) child.stdout.destroy();

    if (child.stderr) child.stderr.destroy();

    exithandler();
  }

  function kill() {
    if (child.stdout) child.stdout.destroy();

    if (child.stderr) child.stderr.destroy();

    killed = true;
    try {
      child.kill(options.killSignal);
    } catch (e) {
      ex = e;
      exithandler();
    }
  }

  if (options.timeout > 0) {
    timeoutId = setTimeout(function delayedKill() {
      kill();
      timeoutId = null;
    }, options.timeout);
  }

  if (child.stdout) {
    if (encoding) child.stdout.setEncoding(encoding);

    child.stdout.on("data", function onChildStdout(chunk) {
      // Do not need to count the length
      if (options.maxBuffer === Infinity) {
        _stdout.push(chunk);
        return;
      }
      const encoding = child.stdout.readableEncoding;
      const length = encoding ? Buffer.byteLength(chunk, encoding) : chunk.length;
      const slice = encoding ? (s, ...args) => s.slice(...args) : (buf, ...args) => buf.slice(...args);
      stdoutLen += length;

      if (stdoutLen > options.maxBuffer) {
        const truncatedLen = options.maxBuffer - (stdoutLen - length);
        _stdout.push(slice(chunk, 0, truncatedLen));

        ex = codeError(RangeError, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "stdout maxBuffer length exceeded");
        kill();
      } else {
        _stdout.push(chunk);
      }
    });
  }

  if (child.stderr) {
    if (encoding) child.stderr.setEncoding(encoding);

    child.stderr.on("data", function onChildStderr(chunk) {
      // Do not need to count the length
      if (options.maxBuffer === Infinity) {
        _stderr.push(chunk);
        return;
      }
      const encoding = child.stderr.readableEncoding;
      const length = encoding ? Buffer.byteLength(chunk, encoding) : chunk.length;
      stderrLen += length;

      if (stderrLen > options.maxBuffer) {
        const truncatedLen = options.maxBuffer - (stderrLen - length);
        _stderr.push(chunk.slice(0, truncatedLen));

        ex = codeError(RangeError, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "stderr maxBuffer length exceeded");
        kill();
      } else {
        _stderr.push(chunk);
      }
    });
  }

  child.addListener("close", exithandler);
  child.addListener("error", errorhandler);

  return child;
}

Object.defineProperty(execFile, kCustomPromisify, { enumerable: false, value: customPromiseExecFunction(execFile) });

function normalizeSpawnArguments(file, args, options) {
  validateString(file, "file");
  validateArgumentNullCheck(file, "file");

  if (file.length === 0) throw invalidArgValue("file", "cannot be empty", file);

  if (Array.isArray(args)) {
    args = args.slice();
  } else if (args == null) {
    args = [];
  } else if (typeof args !== "object") {
    throw invalidArgType("args", "of type object", args);
  } else {
    options = args;
    args = [];
  }

  validateArgumentsNullCheck(args, "args");

  if (options === undefined) options = {};
  else validateObject(options, "options");

  options = { __proto__: null, ...options };
  let cwd = options.cwd;

  // Validate the cwd, if present.
  if (cwd != null) {
    cwd = getValidatedPath(cwd, "options.cwd");
  }

  // Validate detached, if present.
  if (options.detached != null) {
    validateBoolean(options.detached, "options.detached");
  }

  // Validate the uid, if present.
  if (options.uid != null && !isInt32(options.uid)) {
    throw invalidArgType("options.uid", "of type int32", options.uid);
  }

  // Validate the gid, if present.
  if (options.gid != null && !isInt32(options.gid)) {
    throw invalidArgType("options.gid", "of type int32", options.gid);
  }

  // Validate the shell, if present.
  if (options.shell != null && typeof options.shell !== "boolean" && typeof options.shell !== "string") {
    throw invalidArgType("options.shell", "of type boolean or string", options.shell);
  }

  // Validate argv0, if present.
  if (options.argv0 != null) {
    validateString(options.argv0, "options.argv0");
    validateArgumentNullCheck(options.argv0, "options.argv0");
  }

  // Validate windowsHide, if present.
  if (options.windowsHide != null) {
    validateBoolean(options.windowsHide, "options.windowsHide");
  }

  // Validate windowsVerbatimArguments, if present.
  let { windowsVerbatimArguments } = options;
  if (windowsVerbatimArguments != null) {
    validateBoolean(windowsVerbatimArguments, "options.windowsVerbatimArguments");
  }

  if (options.shell) {
    validateArgumentNullCheck(options.shell, "options.shell");

    const command = args.length > 0 ? `${file} ${args.join(" ")}` : file;
    // Set the shell, switches, and commands.
    if (process.platform === "win32") {
      if (typeof options.shell === "string") file = options.shell;
      else file = process.env.comspec || "cmd.exe";
      // '/d /s /c' is used only for cmd.exe.
      if (/^(?:.*\\)?cmd(?:\.exe)?$/i.exec(file) !== null) {
        args = ["/d", "/s", "/c", `"${command}"`];
        windowsVerbatimArguments = true;
      } else {
        args = ["-c", command];
      }
    } else {
      if (typeof options.shell === "string") file = options.shell;
      else if (process.platform === "android") file = "/system/bin/sh";
      else file = "/bin/sh";
      args = ["-c", command];
    }
  }

  if (typeof options.argv0 === "string") {
    args.unshift(options.argv0);
  } else {
    args.unshift(file);
  }

  // Shallow copy to guarantee changes won't impact process.env
  const env = options.env || { ...process.env };
  const envPairs = [];

  let envKeys = [];
  // Prototype values are intentionally included.
  for (const key in env) {
    envKeys.push(key);
  }

  if (process.platform === "win32") {
    // On Windows env keys are case insensitive. Filter out duplicates,
    // keeping only the first one (in lexicographic order)
    const sawKey = new Set();
    envKeys = envKeys.sort().filter((key) => {
      const uppercaseKey = key.toUpperCase();
      if (sawKey.has(uppercaseKey)) {
        return false;
      }
      sawKey.add(uppercaseKey);
      return true;
    });
  }

  for (const key of envKeys) {
    const value = env[key];
    if (value !== undefined) {
      validateArgumentNullCheck(key, `options.env['${key}']`);
      validateArgumentNullCheck(value, `options.env['${key}']`);
      envPairs.push(`${key}=${value}`);
    }
  }

  return {
    // Make a shallow copy so we don't clobber the user's options object.
    __proto__: null,
    ...options,
    args,
    cwd,
    detached: !!options.detached,
    envPairs,
    file,
    windowsHide: !!options.windowsHide,
    windowsVerbatimArguments: !!windowsVerbatimArguments,
  };
}

function abortChildProcess(child, killSignal, reason) {
  if (!child) return;
  try {
    if (child.kill(killSignal)) {
      const err = new Error("The operation was aborted", { cause: reason });
      err.code = "ABORT_ERR";
      err.name = "AbortError";
      child.emit("error", err);
    }
  } catch (err) {
    child.emit("error", err);
  }
}

/** Spawns a new process using the given `file`. */
export function spawn(file, args, options) {
  options = normalizeSpawnArguments(file, args, options);
  validateTimeout(options.timeout);
  validateAbortSignal(options.signal, "options.signal");
  const killSignal = sanitizeKillSignal(options.killSignal);
  const child = new ChildProcess();

  child.spawn(options);

  if (options.timeout > 0) {
    let timeoutId = setTimeout(() => {
      if (timeoutId) {
        try {
          child.kill(killSignal);
        } catch (err) {
          child.emit("error", err);
        }
        timeoutId = null;
      }
    }, options.timeout);

    child.once("exit", () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    });
  }

  if (options.signal) {
    const signal = options.signal;
    if (signal.aborted) {
      process.nextTick(onAbortListener);
    } else {
      signal.addEventListener("abort", onAbortListener, { once: true });
      child.once("exit", () => signal.removeEventListener("abort", onAbortListener));
    }

    function onAbortListener() {
      abortChildProcess(child, killSignal, options.signal.reason);
    }
  }

  return child;
}

/* lib/internal/child_process.js's spawnSync: the host's result as Node's */
function spawnSyncResult(options) {
  const [error, pid, status, termSignal, output] = processSpawnSync(options.file, options.args, options.envPairs ?? null,
    options.cwd ?? null, hostStdio(options.stdio), spawnFlags(options), options.uid ?? -1, options.gid ?? -1,
    options.timeout ?? 0, options.maxBuffer ?? MAX_BUFFER, options.killSignal ?? signals.SIGTERM);
  /* Node's SyncProcessRunner's result: the error first, when there is one; status, signal and
     output null when the child never ran */
  const result = {};
  if (error !== 0) result.error = error;
  result.status = status === null || termSignal ? null : status;
  result.signal = termSignal ? signalNames[termSignal] ?? termSignal : null;
  result.output = status === null ? null : output.map((bytes) => (bytes === null ? null : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
  result.pid = pid;
  if (result.output && options.encoding && options.encoding !== "buffer") {
    for (let i = 0; i < result.output.length; i++) {
      if (!result.output[i]) continue;
      result.output[i] = result.output[i].toString(options.encoding);
    }
  }

  result.stdout = result.output?.[1];
  result.stderr = result.output?.[2];

  if (result.error) {
    result.error = ErrnoException(result.error, "spawnSync " + options.file);
    result.error.path = options.file;
    result.error.spawnargs = options.args.slice(1);
  }

  return result;
}

/** Spawns a new process synchronously using the given `file`. */
export function spawnSync(file, args, options) {
  options = {
    __proto__: null,
    maxBuffer: MAX_BUFFER,
    ...normalizeSpawnArguments(file, args, options),
  };

  // Validate the timeout, if present.
  validateTimeout(options.timeout);

  // Validate maxBuffer, if present.
  validateMaxBuffer(options.maxBuffer);

  // Validate and translate the kill signal, if present.
  options.killSignal = sanitizeKillSignal(options.killSignal);

  options.stdio = getValidStdio(options.stdio || "pipe", true).stdio;

  if (options.input) {
    const stdin = options.stdio[0] = { ...options.stdio[0] };
    stdin.input = options.input;
  }

  // We may want to pass data in on any given fd, ensure it is a valid buffer
  for (let i = 0; i < options.stdio.length; i++) {
    const input = options.stdio[i]?.input;
    if (input != null) {
      const pipe = options.stdio[i] = { ...options.stdio[i] };
      if (isArrayBufferView(input)) {
        pipe.input = input;
      } else if (typeof input === "string") {
        pipe.input = Buffer.from(input, options.encoding);
      } else {
        throw invalidArgType(`options.stdio[${i}]`, "of type string or an instance of Buffer, TypedArray, or DataView", input);
      }
    }
  }

  return spawnSyncResult(options);
}

function checkExecSyncError(ret, args, cmd) {
  let err;
  if (ret.error) {
    err = ret.error;
    Object.assign(err, ret);
  } else if (ret.status !== 0) {
    let msg = "Command failed: ";
    msg += cmd || args.join(" ");
    if (ret.stderr && ret.stderr.length > 0) msg += `\n${ret.stderr.toString()}`;
    err = genericNodeError(msg, ret);
  }
  return err;
}

/** Spawns a file synchronously: its stdout, or an error when it fails. */
export function execFileSync(file, args, options) {
  ({ file, args, options } = normalizeExecFileArgs(file, args, options));

  const inheritStderr = !options.stdio;
  const ret = spawnSync(file, args, options);

  if (inheritStderr && ret.stderr) process.stderr.write(ret.stderr);

  const errArgs = [options.argv0 || file];
  errArgs.push(...args);
  const err = checkExecSyncError(ret, errArgs);

  if (err) throw err;

  return ret.stdout;
}

/** Spawns a shell executing the given command synchronously: its stdout, or an error. */
export function execSync(command, options) {
  const opts = normalizeExecArgs(command, options, null);
  const inheritStderr = !opts.options.stdio;

  const ret = spawnSync(opts.file, opts.options);

  if (inheritStderr && ret.stderr) process.stderr.write(ret.stderr);

  const err = checkExecSyncError(ret, undefined, command);

  if (err) throw err;

  return ret.stdout;
}

export default { _forkChild, ChildProcess, exec, execFile, execFileSync, execSync, fork, spawn, spawnSync };
