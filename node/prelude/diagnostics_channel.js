// node:diagnostics_channel: named channels a library publishes on and tools
// subscribe to, and TracingChannel's start / end / asyncStart / asyncEnd / error around a call.
// Node's algorithm: a channel with neither subscribers nor bound stores is inactive (publish does
// nothing, hasSubscribers is false) and held weakly; subscribing swaps in ActiveChannel's
// prototype. A subscriber's error doesn't stop the others: it is thrown on the next tick, as an
// uncaught exception.
import { invalidArgType, validateFunction } from "./internal/errors.js";

/* name → channel: weakly held, except while it has subscribers or stores (Node's WeakRefMap) */
class WeakRefMap {
  #entries = new Map();

  get(key) {
    return this.#entries.get(key)?.ref.deref();
  }

  set(key, value) {
    this.#entries.set(key, { ref: new WeakRef(value), strong: undefined, count: 0 });
  }

  incRef(key) {
    const entry = this.#entries.get(key);
    if (entry && entry.count++ === 0) entry.strong = entry.ref.deref();
  }

  decRef(key) {
    const entry = this.#entries.get(key);
    if (entry && --entry.count === 0) entry.strong = undefined;
  }
}

const channels = new WeakRefMap();

function uncaught(err) {
  process.nextTick(() => {
    throw err;
  });
}

function markActive(channel) {
  Object.setPrototypeOf(channel, ActiveChannel.prototype);
  channel._subscribers = [];
  channel._stores = new Map();
}

function maybeMarkInactive(channel) {
  if (!channel._subscribers.length && !channel._stores.size) {
    Object.setPrototypeOf(channel, Channel.prototype);
    channel._subscribers = undefined;
    channel._stores = undefined;
  }
}

function defaultTransform(data) {
  return data;
}

/* next() run in the store's context: store.run(transform(data), next) */
function wrapStoreRun(store, data, next, transform = defaultTransform) {
  return () => {
    let context;
    try {
      context = transform(data);
    } catch (err) {
      uncaught(err);
      return next();
    }
    return store.run(context, next);
  };
}

class ActiveChannel {
  subscribe(subscription) {
    validateFunction(subscription, "subscription");
    this._subscribers = [...this._subscribers, subscription];  /* a publish under way keeps its list */
    channels.incRef(this.name);
  }

  unsubscribe(subscription) {
    const index = this._subscribers.indexOf(subscription);
    if (index === -1) return false;
    this._subscribers = [...this._subscribers.slice(0, index), ...this._subscribers.slice(index + 1)];
    channels.decRef(this.name);
    maybeMarkInactive(this);
    return true;
  }

  bindStore(store, transform) {
    if (!this._stores.has(store)) channels.incRef(this.name);
    this._stores.set(store, transform);
  }

  unbindStore(store) {
    if (!this._stores.has(store)) return false;
    this._stores.delete(store);
    channels.decRef(this.name);
    maybeMarkInactive(this);
    return true;
  }

  get hasSubscribers() {
    return true;
  }

  publish(data) {
    const subscribers = this._subscribers;
    for (let i = 0; i < (subscribers?.length || 0); i++) {
      try {
        const onMessage = subscribers[i];
        onMessage(data, this.name);
      } catch (err) {
        uncaught(err);
      }
    }
  }

  runStores(data, fn, thisArg, ...args) {
    let run = () => {
      this.publish(data);
      return Reflect.apply(fn, thisArg, args);
    };
    for (const [store, transform] of this._stores.entries()) run = wrapStoreRun(store, data, run, transform);
    return run();
  }
}

export class Channel {
  constructor(name) {
    this._subscribers = undefined;
    this._stores = undefined;
    this.name = name;
    this._index = undefined;
    channels.set(name, this);
  }

  /* an active channel's prototype is ActiveChannel's: it is a Channel still */
  /* Object.getPrototypeOf throws on undefined, as Node's: tracingChannel({}) reports that */
  static [Symbol.hasInstance](instance) {
    const prototype = Object.getPrototypeOf(instance);
    return prototype === Channel.prototype || prototype === ActiveChannel.prototype;
  }

  subscribe(subscription) {
    validateFunction(subscription, "subscription");
    markActive(this);
    this.subscribe(subscription);
  }

  unsubscribe() {
    return false;
  }

  bindStore(store, transform) {
    markActive(this);
    this.bindStore(store, transform);
  }

  unbindStore() {
    return false;
  }

  get hasSubscribers() {
    return false;
  }

  publish() {}

  runStores(data, fn, thisArg, ...args) {
    return Reflect.apply(fn, thisArg, args);
  }
}

export function channel(name) {
  const existing = channels.get(name);
  if (existing) return existing;
  if (typeof name !== "string" && typeof name !== "symbol") throw invalidArgType("channel", "one of type string or symbol", name);
  return new Channel(name);
}

export function subscribe(name, subscription) {
  channel(name).subscribe(subscription);
}

export function unsubscribe(name, subscription) {
  return channel(name).unsubscribe(subscription);
}

export function hasSubscribers(name) {
  const existing = channels.get(name);
  return existing ? existing.hasSubscribers : false;
}

/* ---- TracingChannel ------------------------------------------------------------------ */

const traceEvents = ["start", "end", "asyncStart", "asyncEnd", "error"];

function tracingChannelFrom(nameOrChannels, name) {
  if (typeof nameOrChannels === "string") return channel(`tracing:${nameOrChannels}:${name}`);
  if (typeof nameOrChannels === "object" && nameOrChannels !== null) {
    const found = nameOrChannels[name];
    if (!(found instanceof Channel)) throw invalidArgType(`nameOrChannels.${name}`, "an instance of Channel", found);
    return found;
  }
  throw invalidArgType("nameOrChannels", "of type string or an instance of TracingChannel or Object", nameOrChannels);
}

class TracingChannel {
  constructor(nameOrChannels) {
    for (const eventName of traceEvents) {
      Object.defineProperty(this, eventName, { value: tracingChannelFrom(nameOrChannels, eventName) });
    }
  }

  get hasSubscribers() {
    return this.start.hasSubscribers || this.end.hasSubscribers || this.asyncStart.hasSubscribers ||
      this.asyncEnd.hasSubscribers || this.error.hasSubscribers;
  }

  subscribe(handlers) {
    for (const name of traceEvents) {
      if (!handlers[name]) continue;
      this[name]?.subscribe(handlers[name]);
    }
  }

  unsubscribe(handlers) {
    let done = true;
    for (const name of traceEvents) {
      if (!handlers[name]) continue;
      if (!this[name]?.unsubscribe(handlers[name])) done = false;
    }
    return done;
  }

  traceSync(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const { start, end, error } = this;
    return start.runStores(context, () => {
      try {
        const result = Reflect.apply(fn, thisArg, args);
        context.result = result;
        return result;
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }

  tracePromise(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const { start, end, asyncStart, asyncEnd, error } = this;
    function reject(err) {
      context.error = err;
      error.publish(context);
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return Promise.reject(err);
    }
    function resolve(result) {
      context.result = result;
      asyncStart.publish(context);
      asyncEnd.publish(context);
      return result;
    }
    return start.runStores(context, () => {
      try {
        let promise = Reflect.apply(fn, thisArg, args);
        if (!(promise instanceof Promise)) promise = Promise.resolve(promise);  /* a thenable, a value */
        return promise.then(resolve, reject);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }

  /* the callback at args[position] (-1: the last) reports the async half */
  traceCallback(fn, position = -1, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const { start, end, asyncStart, asyncEnd, error } = this;
    function wrappedCallback(err, res) {
      if (err) {
        context.error = err;
        error.publish(context);
      } else {
        context.result = res;
      }
      asyncStart.runStores(context, () => {
        try {
          return Reflect.apply(callback, this, arguments);
        } finally {
          asyncEnd.publish(context);
        }
      });
    }
    const callback = args.at(position);
    validateFunction(callback, "callback");
    args.splice(position, 1, wrappedCallback);
    return start.runStores(context, () => {
      try {
        return Reflect.apply(fn, thisArg, args);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }
}

export function tracingChannel(nameOrChannels) {
  return new TracingChannel(nameOrChannels);
}

export default { channel, hasSubscribers, subscribe, tracingChannel, unsubscribe, Channel };
