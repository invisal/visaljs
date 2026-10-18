// Inline caches on long prototype chains: adds that shadow a prototype's data property, the
// property turning read-only or into a setter under the cache, and instances whose
// constructors (their own and their bases') add more properties than the base can count.
"use strict";
// shadowing a prototype's writable data property, then the property changing under the cache
function Base() {}
Base.prototype.x = 0;
function make() { const o = new Base(); try { o.x = 1; } catch (e) { return e.constructor.name; } return Object.getOwnPropertyNames(o).join() + "=" + o.x; }
const out = [];
for (let i = 0; i < 3; i++) out.push(make());
Object.defineProperty(Base.prototype, "x", { writable: false });
out.push(make());
Object.defineProperty(Base.prototype, "x", { set(v) { this._seen = v; }, configurable: true });
out.push(make());
delete Base.prototype.x;
out.push(make());
console.log(out.join(" | "));

// deep chains: 7 levels, adds and shadowing at each
class A { constructor() { this.a = 1; } }
A.prototype.s = "proto";
class B extends A { constructor() { super(); this.b = 2; } }
class C extends B { constructor() { super(); this.c = 3; } }
class D extends C { constructor() { super(); for (let i = 0; i < 30; i++) this["p" + i] = i; this.s = "own"; } }
class E extends D {}
class F extends E { constructor() { super(); this.f = 6; } }
const objs = [];
for (let i = 0; i < 5; i++) objs.push(new F());
console.log(objs.map((o) => Object.keys(o).length + ":" + o.s + ":" + o.p29 + ":" + o.f).join(" "));
A.prototype.s = "changed";
Object.defineProperty(C.prototype, "c", { set(v) { this._c = v * 10; }, configurable: true });
const g = new F();
console.log(g.c, g._c, Object.keys(g).includes("c"), g.s);

// a constructor returning another object; a class growing past 64 properties
class R { constructor() { this.a = 1; return { other: true }; } }
class S extends R { constructor() { super(); this.z = 1; } }
console.log(JSON.stringify(new S()), JSON.stringify(new S()));
class Big { constructor() { for (let i = 0; i < 100; i++) this["k" + i] = i; } }
class Bigger extends Big { constructor() { super(); this.last = "L"; } }
for (let i = 0; i < 3; i++) { const b = new Bigger(); console.log(Object.keys(b).length, b.k0, b.k99, b.last); }
// Reflect.construct with another new.target
class P { constructor() { this.p = 1; this.q = 2; this.r = 3; this.t = 4; this.u = 5; } }
function Q() {}
Q.prototype = { tag: "Q" };
for (let i = 0; i < 3; i++) { const o = Reflect.construct(P, [], Q); console.log(o.tag, Object.keys(o).join()); }
