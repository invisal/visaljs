// The async context: the value the runtime carries through jobs, timers and promise
// reactions, which node:async_hooks' AsyncLocalStorage keeps its stores in (a frame: a Map from
// each storage to its store, never changed once current). I/O callbacks run under none: the
// prelude binds each to the context it was registered in, as Node runs a handle's callbacks in
// the context of its resource.
import { asyncContextGet, asyncContextSet } from "visaljs:host";

export { asyncContextGet as currentContext, asyncContextSet as setContext };

/** fn.apply(thisArg, args) under `context`, then the current one again. */
export function runInContext(context, fn, thisArg, args) {
  const prior = asyncContextGet();
  if (prior === context) return Reflect.apply(fn, thisArg, args);
  asyncContextSet(context);
  try {
    return Reflect.apply(fn, thisArg, args);
  } finally {
    asyncContextSet(prior);
  }
}

/** A host callback (it runs under no context) that runs under the current one: fn itself when
 *  there's none. */
export function bindContext(fn) {
  const context = asyncContextGet();
  return context === undefined ? fn : (...args) => runInContext(context, fn, undefined, args);
}
