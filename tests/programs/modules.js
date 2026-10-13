// visaljs-flags: --no-bundle
// An ES module: what the bundler produces, compiled as one file.

// strict mode; `this` is undefined; top-level bindings are the module's, not the global object's
var counter = 0;
function bump() { return ++counter; }
print([typeof this, typeof globalThis.counter, typeof globalThis.bump, (function () { return this; })()].join(" "));
try { undeclared = 1; } catch (e) { print("strict: " + e.name); }

// exports: nothing imports them (the module is the whole program), but they're declared and run
export const name = "modules";
export function twice(x) { return x * 2; }
export class Point { constructor(x, y) { this.x = x; this.y = y; } }
export default function () { return "anonymous default"; }
export { bump as increment, counter };
print(name + " " + twice(bump() + bump()) + " " + new Point(1, 2).y);

// top-level await: the module body runs as an async function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
print("before await");
await sleep(5);
print("after await " + (await Promise.resolve(counter)));
for await (const x of [Promise.resolve("a"), "b"]) print("for await " + x);

// the code after a top-level await still runs before later timers and after earlier microtasks
setTimeout(() => print("timer"), 0);
Promise.resolve().then(() => print("microtask"));
await null;
print("end of module");
