// instanceof (§13.10.2): Symbol.hasInstance decides when the target has one; otherwise the
// prototype chain (OrdinaryHasInstance), through bound functions.
function W() {}
Object.defineProperty(W, Symbol.hasInstance, { value: (o) => o === 1 || (typeof o === "object" && o !== null && "marked" in o), configurable: true });
console.log(1 instanceof W, { marked: true } instanceof W, new W() instanceof W, {} instanceof W);
class Even {
  static [Symbol.hasInstance](n) {
    return n % 2 === 0;
  }
}
console.log(2 instanceof Even, 3 instanceof Even);
class Base {}
class Derived extends Base {}
const Bound = Derived.bind(null);
console.log(new Derived() instanceof Base, new Derived() instanceof Bound, new Base() instanceof Bound);
const plain = { [Symbol.hasInstance]: (v) => v === "yes" };
console.log("yes" instanceof plain, "no" instanceof plain);
const truthy = { [Symbol.hasInstance]: () => "a string" };
console.log(0 instanceof truthy);
const fp = Function.prototype[Symbol.hasInstance];
console.log(typeof fp, fp.name, fp.length, fp.call(Base, new Derived()), fp.call({}, {}), fp.call(Base, 1));
const d = Object.getOwnPropertyDescriptor(Function.prototype, Symbol.hasInstance);
console.log(d.writable, d.enumerable, d.configurable);
const attempt = (f) => {
  try {
    return f();
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
};
console.log(attempt(() => ({}) instanceof { [Symbol.hasInstance]: 1 }), "|", attempt(() => 1 instanceof {}), "|", attempt(() => 1 instanceof 2));
const getterCalls = [];
const spy = new Proxy(function () {}, { get: (t, k) => (getterCalls.push(String(k)), Reflect.get(t, k)) });
console.log({} instanceof spy, getterCalls);
