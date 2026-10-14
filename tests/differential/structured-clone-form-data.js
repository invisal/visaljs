// visaljs-flags: --embed-source
// structuredClone and FormData: what clones and how, the errors, and FormData as a body (multipart
// out, multipart and urlencoded back in). --embed-source: a function's DataCloneError shows its source.
import util from "node:util";
const show = (label, f) => { try { const r = f(); console.log(label, util.inspect(r, { depth: 4, showHidden: false })); } catch (e) { console.log(label, "THROWS", e.name, e.code, JSON.stringify(e.message), e instanceof DOMException); } };
const circ = { a: 1 }; circ.self = circ;
show("circ", () => { const c = structuredClone(circ); return c.self === c; });
show("types", () => structuredClone({ d: new Date(0), r: /a/gi, m: new Map([[1, { x: 1 }]]), s: new Set([1, 2]), big: 10n, n: null, u: undefined, neg0: -0, nan: NaN, str: new String("s"), num: new Number(3), bool: new Boolean(false), bigobj: Object(5n) }));
show("arr", () => { const a = [1, , 3]; a.extra = "x"; return structuredClone(a); });
show("buffer", () => { const b = Buffer.from("hi"); const c = structuredClone(b); return [c.constructor.name, c]; });
show("typed", () => { const ab = new ArrayBuffer(8); const v = new Uint16Array(ab, 2, 2); const c = structuredClone({ v, w: new DataView(ab, 1, 3), ab }); return [c.v.buffer === c.ab, c.w.buffer === c.ab, c.v.byteOffset, c.w.byteOffset]; });
show("transfer", () => { const ab = new ArrayBuffer(4); const c = structuredClone(ab, { transfer: [ab] }); return [ab.byteLength, ab.detached, c.byteLength]; });
show("transfer twice", () => { const ab = new ArrayBuffer(4); return structuredClone(ab, { transfer: [ab, ab] }); });
show("transfer detached", () => { const ab = new ArrayBuffer(4); structuredClone(ab, { transfer: [ab] }); return structuredClone(ab); });
show("fn", () => structuredClone(() => {}));
show("fn named", () => structuredClone({ f: function foo() {} }));
show("sym", () => structuredClone(Symbol("x")));
show("weakmap", () => structuredClone(new WeakMap()));
show("promise", () => structuredClone(Promise.resolve()));
show("proxy", () => structuredClone(new Proxy({}, {})));
show("class", () => { class A { constructor() { this.x = 1; } get y() { return 2; } } const c = structuredClone(new A()); return [c, Object.getPrototypeOf(c) === Object.prototype]; });
show("getter", () => structuredClone({ get g() { return 5; } }));
show("nonenum", () => { const o = {}; Object.defineProperty(o, "h", { value: 1 }); o[Symbol("s")] = 2; return structuredClone(o); });
show("errors", () => { const e = new TypeError("bad", { cause: 1 }); e.extra = 1; e.code = "X"; const c = structuredClone(e); return [c.constructor.name, c.message, c.cause, c.extra, c.code, typeof c.stack, c.stack === e.stack]; });
show("custom err", () => { class MyErr extends Error {} const c = structuredClone(new MyErr("m")); return [c.constructor.name, c.name]; });
show("err name", () => { const e = new Error("m"); e.name = "RangeError"; const c = structuredClone(e); return [c.constructor.name, c.name]; });
show("err name2", () => { const e = new Error("m"); e.name = "Foo"; const c = structuredClone(e); return [c.constructor.name, c.name]; });
show("blob", () => { const b = new Blob(["abc"], { type: "text/x" }); const c = structuredClone(b); return [c.constructor.name, c.size, c.type]; });
show("file", () => { const c = structuredClone(new File(["a"], "f.txt", { type: "t/x", lastModified: 5 })); return [c.constructor.name, c.name, c.lastModified, c.type]; });
show("url", () => structuredClone(new URL("http://x")));
show("domex", () => { const c = structuredClone(new DOMException("m", "AbortError")); return [c.constructor.name, c.name, c.code]; });
show("missing", () => structuredClone());
show("opts bad", () => structuredClone(1, 1));
show("transfer non-transferable", () => structuredClone(1, { transfer: [{}] }));
show("transfer blob", () => { const b = new Blob(); return structuredClone(b, { transfer: [b] }); });
show("readable", () => { const r = new ReadableStream(); const c = structuredClone(r, { transfer: [r] }); return [r.locked, c.locked, c.constructor.name]; });
show("readable no transfer", () => structuredClone(new ReadableStream()));
show("sab", () => structuredClone(new Headers()));
show("arguments", () => (function () { return structuredClone(arguments); })(1, 2));
show("resizable", () => { const ab = new ArrayBuffer(2, { maxByteLength: 8 }); const c = structuredClone(ab); return [c.resizable, c.maxByteLength]; });
show("big typed", () => structuredClone(new BigInt64Array([1n])));
show("aggregate", () => { const c = structuredClone(new AggregateError([1], "agg")); return [c.constructor.name, c.errors]; });
show("eval err", () => structuredClone(new EvalError("e")).constructor.name);

/* FormData */

const showAsync = async (label, f) => { try { const r = await f(); console.log(label, typeof r === "string" ? JSON.stringify(r) : util.inspect(r, { depth: 3 })); } catch (e) { console.log(label, "THROWS", e.name, e.code, JSON.stringify(e.message)); } };
(async () => {
const fd = new FormData();
fd.append("a", "1"); fd.append("a", "2\r\nx\ny"); fd.append("b", new Blob(["blob!"], { type: "text/plain" })); fd.append("c", new Blob(["x"]), "name.txt");
fd.append("q\"\n", "esc");
fd.set("d", 5);
await showAsync("inspect", () => util.inspect(fd).replace(/lastModified: \d+/g, "lastModified: T"));
await showAsync("get", () => [fd.get("a"), fd.getAll("a"), fd.has("b"), fd.get("zz"), fd.get("b").constructor.name, fd.get("b").name, fd.get("c").name]);
await showAsync("entries", () => [...fd.keys()]);
await showAsync("append bad", () => fd.append("x", "y", "z"));
await showAsync("append 1 arg", () => fd.append("x"));
await showAsync("ctor form", () => new FormData({}));
await showAsync("toString", () => Object.prototype.toString.call(fd));
const r = new Response(fd);
await showAsync("ct", () => r.headers.get("content-type").replace(/\d+$/, "N"));
const text = await r.text();
await showAsync("body", () => text.replace(/formdata-undici-0\d+/g, "B"));
const r2 = new Response(text, { headers: { "content-type": "multipart/form-data; boundary=" + text.split("\r\n")[0].slice(2) } });
await showAsync("parse", async () => [...await r2.formData()].map(([k, v]) => [k, typeof v === "string" ? v : [v.constructor.name, v.name, v.type, v.size]]));
await showAsync("parse urlenc", async () => [...await new Response("a=1&b=%20x+y", { headers: { "content-type": "application/x-www-form-urlencoded" } }).formData()]);
await showAsync("parse bad", async () => new Response("x", { headers: { "content-type": "text/plain" } }).formData());
await showAsync("parse bad multipart", async () => new Response("garbage", { headers: { "content-type": "multipart/form-data; boundary=zz" } }).formData());
await showAsync("req", async () => [...await new Request("http://x", { method: "POST", body: fd }).formData()].length);
await showAsync("clone", () => { const c = new FormData(); c.append("k", "v"); return [...c.entries()]; });
await showAsync("delete", () => { fd.delete("a"); return [...fd.keys()]; });
await showAsync("foreach", () => { const out = []; fd.forEach((v, k, p) => out.push(k, p === fd)); return out; });
await showAsync("length", () => [FormData.length, FormData.prototype.append.length, FormData.prototype.set.length]);
})();
