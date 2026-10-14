// Features linked only into programs whose code names them (implicitModules in node/index.ts):
// each one's module sets its implementation here when it runs, and the public function looks it
// up. A feature named only at run time (computed, never in the code's text) isn't there: its
// function throws ERR_VISALJS_UNSUPPORTED.
import { notSupported } from "./errors.js";

export const features = Object.create(null);

/** A feature's implementation, or ERR_VISALJS_UNSUPPORTED. */
export function feature(name) {
  const f = features[name];
  if (f === undefined) throw notSupported(`${name} (named only at run time)`);
  return f;
}

/** A function of a feature's, which calls the implementation the feature's module set. */
export function lazyFunction(name, length = 0) {
  const f = function (...args) {
    return feature(name).apply(this, args);
  };
  Object.defineProperty(f, "name", { value: name });
  Object.defineProperty(f, "length", { value: length });
  return f;
}

/** A class the program may construct, as a function the feature's module gives its prototype:
 *  `new Wrapper(…)` builds the feature's class, and instanceof holds. */
export function lazyClass(name) {
  const Wrapper = function (...args) {
    if (!new.target) throw new TypeError(`Class constructor ${name} cannot be invoked without 'new'`);
    return Reflect.construct(feature(name), args, new.target);
  };
  Object.defineProperty(Wrapper, "name", { value: name });
  return Wrapper;
}

/** A constructor function (not a class) of a feature's, as Node's stream classes are: `new Ctor(…)`,
 *  a class extending it, and the pre-class `Ctor.call(this, …)` with util.inherits all reach the
 *  feature's function, with `this` as given. Its prototype is the feature's (provideClass). */
export function lazyConstructor(name, length = 1) {
  const Wrapper = function (...args) {
    return Reflect.apply(feature(name), this, args);
  };
  Object.defineProperty(Wrapper, "name", { value: name });
  Object.defineProperty(Wrapper, "length", { value: length });
  return Wrapper;
}

/** Called by a feature's module for a lazyClass: the wrapper takes the class's prototype. */
export function provideClass(Wrapper, Class) {
  features[Wrapper.name] = Class;
  Wrapper.prototype = Class.prototype;
  Object.defineProperty(Class.prototype, "constructor", { value: Wrapper, writable: true, configurable: true });
  Object.setPrototypeOf(Wrapper, Object.getPrototypeOf(Class));
}
