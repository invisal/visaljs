// node:domain (deprecated): Domain, create and active, as Node's for what runs inside run() and
// through bind(): an error thrown there is uncaught, as in Node, and when it reaches the top the
// domain's 'error' listeners get it (process's 'uncaughtException', which domains take first);
// intercept() gives a callback's error to them. Errors from asynchronous callbacks started inside a
// domain aren't routed to it.
import { EventEmitter } from "./events.js";
import "./internal/process_events.js";

const stack = [];
export let active = null;

export class Domain extends EventEmitter {
  constructor() {
    super();
    this.members = [];
  }

  enter() {
    stack.push(this);
    active = stack.at(-1);
    process.domain = active;
  }

  exit() {
    const index = stack.lastIndexOf(this);
    if (index !== -1) stack.length = index;
    active = stack.at(-1);  /* undefined once the stack empties, as Node's */
    process.domain = active;
  }

  add(emitter) {
    if (emitter.domain === this) return;
    if (emitter.domain) emitter.domain.remove(emitter);
    emitter.domain = this;
    this.members.push(emitter);
  }

  remove(emitter) {
    emitter.domain = null;
    const index = this.members.indexOf(emitter);
    if (index !== -1) this.members.splice(index, 1);
  }

  /* an error thrown inside the domain: marked as its, and thrown on to the top */
  run(fn, ...args) {
    this.enter();
    try {
      return fn.apply(this, args);
    } catch (err) {
      if (err !== null && typeof err === "object" && this.listenerCount("error") > 0) {
        err.domain = this;
        err.domainThrown = true;
      }
      throw err;
    } finally {
      this.exit();
    }
  }

  bind(fn) {
    const run = (thisArg, args) => this.run(() => fn.apply(thisArg, args));
    const bound = function (...args) {
      return run(this, args);
    };
    bound.domain = this;
    return bound;
  }

  /** A callback whose first argument, an error, goes to the domain instead. */
  intercept(fn) {
    const onError = (err) => {
      if (typeof err === "object") {
        err.domainBound = fn;
        err.domainThrown = false;
        err.domain = this;
      }
      this.emit("error", err);
    };
    const run = (thisArg, args) => this.run(() => fn.apply(thisArg, args));
    const intercepted = function (err, ...args) {
      if (err) return onError(err);
      return run(this, args);
    };
    intercepted.domain = this;
    return intercepted;
  }

  dispose() {
    this.exit();
    this.members.length = 0;
  }
}

/* an uncaught error a domain marked: its 'error' listeners have it, and the program goes on */
const baseEmit = process.emit;
process.emit = function emit(type, ...args) {
  const err = args[0];
  if (type === "uncaughtException" && err?.domain instanceof Domain && err.domain.listenerCount("error") > 0) {
    err.domain.emit("error", err);
    return true;
  }
  return baseEmit.call(this, type, ...args);
};

export function create() {
  return new Domain();
}
export const createDomain = create;

export default {
  Domain, create, createDomain,
  get active() {
    return active;
  },
};
