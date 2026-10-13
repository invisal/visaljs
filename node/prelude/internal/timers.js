// node:timers' core: Timeout and Immediate on the runtime's timers (timerStart and
// friends, runtime/src/jobs.c). Each object holds one native one-shot timer, armed under one id
// (also its primitive), which an interval re-arms after its callback. node:timers and
// node:timers/promises build on it; a program that uses them gets them as its globals too
// (timers_global.js).
import { timerClear, timerRef, timerStart } from "visaljs:host";
import { validateFunction } from "./errors.js";

export const TIMEOUT_MAX = 2 ** 31 - 1;

export const kId = Symbol("timerId");          /* its native timer's id, which is also its primitive */
export const kFire = Symbol("fire");           /* the native timer's callback: one per object */
export const kPending = Symbol("pending");     /* a native timer is armed */
export const kRefed = Symbol("refed");
const kHasPrimitive = Symbol("kHasPrimitive");

/* the ids of timers whose primitive was taken: clearTimeout(id) finds them (Node's knownTimersById) */
const knownTimersById = new Map();
/* every armed Timeout: a number that names one whose primitive wasn't taken clears nothing */
export const armed = new Map();

function emitWarning(message, type) {
  if (typeof process.emitWarning === "function") process.emitWarning(message, type);
}

/* Node 24 also warns, once each, about a negative delay and one that isn't a number */
let warnedNegativeNumber = false;
let warnedNotNumber = false;

/* the delay as Node takes it: 1 when below 1 ms, not a number or past 2^31 - 1 */
export function duration(after) {
  after *= 1;
  if (!(after >= 1 && after <= TIMEOUT_MAX)) {
    if (after > TIMEOUT_MAX) {
      emitWarning(`${after} does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.`, "TimeoutOverflowWarning");
    } else if (after < 0 && !warnedNegativeNumber) {
      warnedNegativeNumber = true;
      emitWarning(`${after} is a negative number.\nTimeout duration was set to 1.`, "TimeoutNegativeWarning");
    } else if (Number.isNaN(after) && !warnedNotNumber) {
      warnedNotNumber = true;
      emitWarning(`${after} is not a number.\nTimeout duration was set to 1.`, "TimeoutNaNWarning");
    }
    after = 1;
  }
  return after;
}

/* (re)arms the native timer under the item's id: a pending one starts over */
export function arm(item, refed) {
  item[kId] = timerStart(item[kFire], item._idleTimeout, refed, item[kId] ?? 0);
  item[kPending] = true;
  armed.set(item[kId], item);
}

function disarm(item) {
  if (item[kPending]) timerClear(item[kId]);
  item[kPending] = false;
  armed.delete(item[kId]);
}

export class Timeout {
  constructor(callback, after, args, isRepeat, isRefed) {
    after = duration(after);
    this._idleTimeout = after;
    this._idlePrev = this;
    this._idleNext = this;
    this._idleStart = null;
    this._onTimeout = callback;
    this._timerArgs = args;
    this._repeat = isRepeat ? after : null;
    this._destroyed = false;
    this[kRefed] = isRefed;
    this[kHasPrimitive] = false;
    this[kPending] = false;
    this[kFire] = () => fireTimeout(this);
  }

  /* the timer starts over from now; one that already fired runs again */
  refresh() {
    if (this._idleTimeout >= 0) {
      this._destroyed = false;
      arm(this, this[kRefed]);
    }
    return this;
  }

  unref() {
    if (this[kRefed]) {
      this[kRefed] = false;
      if (this[kPending]) timerRef(this[kId], false);
    }
    return this;
  }

  ref() {
    if (!this[kRefed]) {
      this[kRefed] = true;
      if (this[kPending]) timerRef(this[kId], true);
    }
    return this;
  }

  hasRef() {
    return this[kRefed];
  }

  close() {
    clearTimeout(this);
    return this;
  }

  [Symbol.toPrimitive]() {
    const id = this[kId];
    if (!this[kHasPrimitive]) {
      this[kHasPrimitive] = true;
      knownTimersById.set(id, this);
    }
    return id;
  }
}
if (typeof Symbol.dispose === "symbol") {
  Timeout.prototype[Symbol.dispose] = function () {
    clearTimeout(this);
  };
}

function fireTimeout(timer) {
  timer[kPending] = false;
  armed.delete(timer[kId]);
  const args = timer._timerArgs;
  try {
    if (args === undefined) timer._onTimeout();
    else Reflect.apply(timer._onTimeout, timer, args);
  } finally {
    if (timer._repeat && timer._idleTimeout !== -1) {
      timer._idleTimeout = timer._repeat;
      if (!timer[kPending]) arm(timer, timer[kRefed]);
    } else if (!timer[kPending] && !timer._destroyed) {  /* not refreshed by its callback */
      timer._destroyed = true;
      if (timer[kHasPrimitive]) knownTimersById.delete(timer[kId]);
    }
  }
}

export function unenrollTimeout(item) {
  if (item._destroyed) return;
  item._destroyed = true;
  if (item[kHasPrimitive]) knownTimersById.delete(item[kId]);
  disarm(item);
  item._idleTimeout = -1;
}

export function setTimeout(callback, after, ...args) {
  validateFunction(callback, "callback");
  const timeout = new Timeout(callback, after, args.length ? args : undefined, false, true);
  arm(timeout, true);
  return timeout;
}

export function setInterval(callback, repeat, ...args) {
  validateFunction(callback, "callback");
  const timeout = new Timeout(callback, repeat, args.length ? args : undefined, true, true);
  arm(timeout, true);
  return timeout;
}

/* a Timeout, a primitive one gave, or a native timer's id (the runtime's and the prelude's) */
export function clearTimeout(timer) {
  if (timer && timer._onTimeout) {
    timer._onTimeout = null;
    unenrollTimeout(timer);
    return;
  }
  if (typeof timer === "number" || typeof timer === "string") {
    const known = knownTimersById.get(Number(timer));
    if (known !== undefined) {
      known._onTimeout = null;
      unenrollTimeout(known);
    } else if (typeof timer === "number" && !armed.has(timer)) {
      timerClear(timer);
    }
  }
}

export function clearInterval(timer) {
  clearTimeout(timer);
}

export class Immediate {
  constructor(callback, args) {
    this._idleNext = null;
    this._idlePrev = null;
    this._onImmediate = callback;
    this._argv = args;
    this._destroyed = false;
    this[kRefed] = true;
    this[kId] = timerStart(() => runImmediate(this), -1, true, 0);
  }

  ref() {
    if (this[kRefed] === false) {
      this[kRefed] = true;
      timerRef(this[kId], true);
    }
    return this;
  }

  unref() {
    if (this[kRefed] === true) {
      this[kRefed] = false;
      timerRef(this[kId], false);
    }
    return this;
  }

  hasRef() {
    return !!this[kRefed];
  }
}
if (typeof Symbol.dispose === "symbol") {
  Immediate.prototype[Symbol.dispose] = function () {
    clearImmediate(this);
  };
}

function runImmediate(immediate) {
  immediate._destroyed = true;
  immediate[kRefed] = null;
  const argv = immediate._argv;
  if (argv === undefined) immediate._onImmediate();
  else immediate._onImmediate(...argv);
}

export function setImmediate(callback, ...args) {
  validateFunction(callback, "callback");
  return new Immediate(callback, args.length ? args : undefined);
}

export function clearImmediate(immediate) {
  if (!immediate || immediate._destroyed) return;
  immediate._destroyed = true;
  immediate[kRefed] = null;
  immediate._onImmediate = null;
  timerClear(immediate[kId]);
}
