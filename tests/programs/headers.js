// Headers, as Node's (undici's): combining, Set-Cookie, sorted iteration, validation, inspection.
const err = (f) => {
  try {
    f();
    return "no error";
  } catch (e) {
    return `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
  }
};

const h = new Headers({ "Content-Type": "text/plain", "X-B": " v1 " });
h.append("x-b", "v2");
h.append("Set-Cookie", "a=1");
h.append("set-cookie", "b=2");
console.log(h);
console.log([...h], h.get("x-b"), h.get("nope"), h.has("CONTENT-type"), h.getSetCookie(), [...h.keys()], [...h.values()]);
console.log(new Headers([["a", "1"], ["b", "2"]]), new Headers(h).get("x-b"), new Headers(), new Headers({ a: 1, b: null, c: undefined }));
console.log(new Headers(new Map([["m", "v"]])).get("m"), new Headers([["A", "1"], ["a", "2"]]).get("a"));

h.delete("x-b");
h.set("Z", "1");
h.set("content-type", "text/html");
h.forEach(function (v, k, o) {
  console.log("each", k, v, o === h, this.tag);
}, { tag: "this" });
const it = h.keys();
h.set("a", "1");
console.log([...it], Object.prototype.toString.call(h), Object.prototype.toString.call(h.entries()), typeof h[Symbol.iterator]);
console.log(h.entries().next(), h[Symbol.iterator] === h.entries, Object.keys(Headers.prototype));
for (const [k, v] of new Headers({ b: "2", a: "1" })) console.log("for-of", k, v);

/* values are trimmed of HTTP whitespace; names and values are checked */
const t = new Headers();
t.set("x", "\t padded \n");
console.log(JSON.stringify(t.get("x")));
console.log(err(() => new Headers([["a"]])), "|", err(() => h.append("bad name", "x")), "|", err(() => h.append("a", "x\ny")));
console.log(err(() => Headers()), "|", err(() => new Headers(5)), "|", err(() => h.get()), "|", err(() => h.append("a")));
console.log(err(() => h.set("é", "1")), "|", err(() => h.append("a", "€")), "|", err(() => Headers.prototype.get.call({}, "a")));

/* subclassing */
class MyHeaders extends Headers {
  extra() {
    return this.get("k");
  }
}
const mine = new MyHeaders({ k: "v" });
console.log(mine.extra(), mine instanceof Headers, mine);
