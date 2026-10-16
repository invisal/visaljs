// visaljs's stand-in for Node's test/common: the helpers Node's own tests use, without what
// needs Node's internals (internalBinding, --expose-internals, V8 flags, re-spawning node).
// Each helper behaves as Node's does; a test that needs one that isn't here doesn't build.
'use strict';

const assert = require('assert');
const path = require('path');
const { inspect } = require('util');

const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const isFreeBSD = process.platform === 'freebsd';
const isOpenBSD = process.platform === 'openbsd';
const isSunOS = process.platform === 'sunos';
const isAIX = process.platform === 'aix';
const isIBMi = process.platform === 'os400';

function noop() {}

const mustCallChecks = [];

function runCallChecks(exitCode) {
  if (exitCode !== 0) return;

  const failed = mustCallChecks.filter(function(context) {
    if ('minimum' in context) {
      context.messageSegment = `at least ${context.minimum}`;
      return context.actual < context.minimum;
    }
    context.messageSegment = `exactly ${context.exact}`;
    return context.actual !== context.exact;
  });

  failed.forEach(function(context) {
    console.log('Mismatched %s function calls. Expected %s, actual %d.',
                context.name,
                context.messageSegment,
                context.actual);
  });

  if (failed.length) process.exit(1);
}

function _mustCallInner(fn, criteria = 1, field) {
  if (typeof fn === 'number') {
    criteria = fn;
    fn = noop;
  } else if (fn === undefined) {
    fn = noop;
  }

  if (typeof criteria !== 'number')
    throw new TypeError(`Invalid ${field} value: ${criteria}`);

  const context = {
    [field]: criteria,
    actual: 0,
    name: fn.name || '<anonymous>',
  };

  // Add the exit listener only once to avoid listener leak warnings
  if (mustCallChecks.length === 0) process.on('exit', runCallChecks);

  mustCallChecks.push(context);

  const _return = function() {
    context.actual++;
    return fn.apply(this, arguments);
  };
  Object.defineProperties(_return, {
    name: { value: fn.name, writable: false, enumerable: false, configurable: true },
    length: { value: fn.length, writable: false, enumerable: false, configurable: true },
  });
  return _return;
}

function mustCall(fn, exact) {
  return _mustCallInner(fn, exact, 'exact');
}

function mustCallAtLeast(fn, minimum) {
  return _mustCallInner(fn, minimum, 'minimum');
}

function mustSucceed(fn, exact) {
  return mustCall(function(err, ...args) {
    assert.ifError(err);
    if (typeof fn === 'function')
      return fn.apply(this, args);
  }, exact);
}

function mustNotCall(msg) {
  return function mustNotCall(...args) {
    const argsInfo = args.length > 0 ?
      `\ncalled with arguments: ${args.map((arg) => inspect(arg)).join(', ')}` : '';
    assert.fail(`${msg || 'function should not have been called'}${argsInfo}`);
  };
}

function expectsError(validator, exact) {
  return mustCall((...args) => {
    if (args.length !== 1) {
      assert.fail(`Expected one argument, got ${inspect(args)}`);
    }
    const error = args.pop();
    // The error message should be non-enumerable
    assert.strictEqual(Object.prototype.propertyIsEnumerable.call(error, 'message'), false);

    assert.throws(() => { throw error; }, validator);
    return true;
  }, exact);
}

function invalidArgTypeHelper(input) {
  if (input == null) {
    return ` Received ${input}`;
  }
  if (typeof input === 'function') {
    return ` Received function ${input.name}`;
  }
  if (typeof input === 'object') {
    if (input.constructor?.name) {
      return ` Received an instance of ${input.constructor.name}`;
    }
    return ` Received ${inspect(input, { depth: -1 })}`;
  }

  let inspected = inspect(input, { colors: false });
  if (inspected.length > 28) { inspected = `${inspected.slice(inspected, 0, 25)}...`; }

  return ` Received type ${typeof input} (${inspected})`;
}

function getArrayBufferViews(buf) {
  const { buffer, byteOffset, byteLength } = buf;

  const out = [];

  const arrayBufferViews = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    DataView,
  ];

  for (const type of arrayBufferViews) {
    const { BYTES_PER_ELEMENT = 1 } = type;
    if (byteLength % BYTES_PER_ELEMENT === 0) {
      out.push(new type(buffer, byteOffset, byteLength / BYTES_PER_ELEMENT));
    }
  }
  return out;
}

function getBufferSources(buf) {
  return [...getArrayBufferViews(buf), new Uint8Array(buf).buffer];
}

function skip(msg) {
  console.log(`1..0 # Skipped: ${msg}`);
  process.exit(0);
}

function platformTimeout(ms) {
  return ms;
}

function canCreateSymLink() {
  /* Node's: creating a symlink needs privileges on Windows only */
  if (isWindows) {
    const whoamiPath = path.join(process.env.SystemRoot, 'System32', 'whoami.exe');
    try {
      const { execSync } = require('child_process');
      const output = execSync(`${whoamiPath} /priv`, { timeout: 1000 });
      return output.includes('SeCreateSymbolicLinkPrivilege');
    } catch {
      return false;
    }
  }
  return true;
}

const _mustNotMutateObjectDeepProxies = new WeakMap();

function mustNotMutateObjectDeep(original) {
  if (original === null || typeof original !== 'object') {
    return original;
  }
  const cachedProxy = _mustNotMutateObjectDeepProxies.get(original);
  if (cachedProxy) {
    return cachedProxy;
  }
  const handler = {
    __proto__: null,
    defineProperty(target, property) {
      assert.fail(`Expected no side effects, got ${inspect(property)} defined`);
    },
    deleteProperty(target, property) {
      assert.fail(`Expected no side effects, got ${inspect(property)} deleted`);
    },
    get(target, prop, receiver) {
      return mustNotMutateObjectDeep(Reflect.get(target, prop, receiver));
    },
    preventExtensions(target) {
      assert.fail('Expected no side effects, got extensions prevented on ' + inspect(target));
    },
    set(target, property, value) {
      assert.fail(`Expected no side effects, got ${inspect(value)} assigned to ${inspect(property)}`);
    },
    setPrototypeOf(target, prototype) {
      assert.fail(`Expected no side effects, got set prototype to ${prototype}`);
    },
  };
  const proxy = new Proxy(original, handler);
  _mustNotMutateObjectDeepProxies.set(original, proxy);
  return proxy;
}

function _expectWarning(name, expected, code) {
  if (typeof expected === 'string') {
    expected = [[expected, code]];
  } else if (!Array.isArray(expected)) {
    expected = Object.entries(expected).map(([a, b]) => [b, a]);
  } else if (expected.length !== 0 && !Array.isArray(expected[0])) {
    expected = [[expected[0], expected[1]]];
  }
  if (name === 'DeprecationWarning') {
    expected.forEach(([, code]) => assert(code, `Missing deprecation code: ${expected}`));
  }
  return mustCall((warning) => {
    const expectedProperties = expected.shift();
    if (!expectedProperties) {
      assert.fail(`Unexpected extra warning received: ${warning}`);
    }
    const [message, code] = expectedProperties;
    assert.strictEqual(warning.name, name);
    if (typeof message === 'string') {
      assert.strictEqual(warning.message, message);
    } else {
      assert.match(warning.message, message);
    }
    assert.strictEqual(warning.code, code);
  }, expected.length);
}

let catchWarning;

function expectWarning(nameOrMap, expected, code) {
  if (catchWarning === undefined) {
    catchWarning = {};
    process.on('warning', (warning) => {
      if (!catchWarning[warning.name]) {
        throw new TypeError(`"${warning.name}" was triggered without being expected.\n` + inspect(warning));
      }
      catchWarning[warning.name](warning);
    });
  }
  if (typeof nameOrMap === 'string') {
    catchWarning[nameOrMap] = _expectWarning(nameOrMap, expected, code);
  } else {
    Object.keys(nameOrMap).forEach((name) => {
      catchWarning[name] = _expectWarning(name, nameOrMap[name]);
    });
  }
}

/* a command for a POSIX shell with its values passed through the environment (Node's) */
function escapePOSIXShell(cmdParts, ...args) {
  if (isWindows) {
    return [String.raw({ raw: cmdParts }, ...args)];
  }
  const env = { ...process.env };
  let cmd = cmdParts[0];
  for (let i = 0; i < args.length; i++) {
    const envVarName = `ESCAPED_${i}`;
    env[envVarName] = args[i];
    cmd += '${' + envVarName + '}' + cmdParts[i + 1];
  }
  return [cmd, { env }];
}

module.exports = {
  canCreateSymLink,
  escapePOSIXShell,
  expectWarning,
  mustNotMutateObjectDeep,
  allowGlobals: noop,
  expectsError,
  getArrayBufferViews,
  getBufferSources,
  invalidArgTypeHelper,
  isAIX,
  isFreeBSD,
  isIBMi,
  isLinux,
  isMacOS,
  isOpenBSD,
  isSunOS,
  isWindows,
  mustCall,
  mustCallAtLeast,
  mustNotCall,
  mustSucceed,
  platformTimeout,
  skip,
  get localhostIPv4() { return '127.0.0.1'; },
  get PORT() { return 12346; },
  /* Node's: a Unix socket in the test's tmpdir (a named pipe on Windows), relative to the cwd */
  get PIPE() {
    const tmpdir = require('./tmpdir');
    const localRelative = path.relative(process.cwd(), `${tmpdir.path}/`);
    const pipePrefix = isWindows ? '\\\\.\\pipe\\' : localRelative;
    return path.join(pipePrefix, `node-test.${process.pid}.sock`);
  },
  get hasCrypto() { return true; },
  get hasIntl() { return true; },
  get fixturesDir() { return path.join(__dirname, '..', 'fixtures'); },
  /* Node's: characters in the test directory's path some tests can't cope with */
  get isInsideDirWithUnusualChars() {
    return __dirname.includes('%') ||
           (!isWindows && __dirname.includes('\\')) ||
           __dirname.includes('$') ||
           __dirname.includes('\n') ||
           __dirname.includes('\r') ||
           __dirname.includes('\t');
  },
};
