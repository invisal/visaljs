// Optional chaining (§13.3.9): ?. on members, calls and private names, short-circuiting the chain
const o = { a: { b: { c: 1 } }, f() { return this === o; }, n: null, arr: [10, 20] };
let count = 0;
const side = () => { count++; return "c"; };
console.log(o?.a.b.c, o.n?.b.c, o.missing?.b[side()].x, count);
console.log(o.f?.(), o.nope?.(), o?.f(), (o?.f)(), o.arr?.[1], o.n?.[side()], count);
console.log(null?.x, undefined?.[0], (void 0)?.());
console.log(delete o?.a.b.c, o.a.b, delete o.n?.x);
const fn = null;
console.log(fn?.(side()), count, typeof o.n?.x);
class P { #x = 7; static get(p) { return p?.#x; } }
console.log(P.get(new P()), P.get(null));
try { o.nope.x?.y; } catch (e) { console.log(e.constructor.name); }
try { o.a?.notfn(); } catch (e) { console.log(e.message); }
console.log(o.a?.b?.c ?? "dflt", o.n?.b ?? "dflt");
function g(x) { return x?.length; }
console.log(g("abc"), g(null), [1, null, "ab"].map((v) => v?.toString?.()));
