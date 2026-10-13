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

module.exports = {
  allowGlobals: noop,
  expectsError,
  getArrayBufferViews,
  getBufferSources,
  invalidArgTypeHelper,
  isAIX,
  isFreeBSD,
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
  get hasCrypto() { return true; },
  get hasIntl() { return true; },
  get fixturesDir() { return path.join(__dirname, '..', 'fixtures'); },
};
