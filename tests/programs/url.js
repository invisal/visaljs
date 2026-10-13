// URL and URLSearchParams: the API around the parser (url-wpt.js runs the parser's cases)
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(e.name, e.code, e.message, e.input, e.base);
  }
};

const u = new URL("https://user:pw@EXAMPLE.com:8080/a/../b?x=1&y=2#frag");
console.log(u);
console.log([u], { u: new URL("http://münchen.de/ä?q=ü#é") });
console.log(String(u), JSON.stringify({ u }), u.toJSON(), u.origin, new URL("blob:https://a.com:443/x").origin, new URL("file:///x").origin);
console.log(new URL("/p?q", "http://h/a/b").href, new URL("//other/x", "https://h/").href, new URL("http://[0:0::1]:80/").host);
console.log(URL.canParse("x:y"), URL.canParse("/a"), URL.canParse("/a", "http://h"), URL.parse("bad"), URL.parse("/z", "http://h").href);

// setters
const s = new URL("http://example.com/path?q=1#h");
s.protocol = "https";
s.username = "me";
s.password = "p@ss";
s.port = "8443";
s.pathname = "/a b/ü";
s.search = "?x=y z";
s.hash = "top level";
console.log(s.href);
s.host = "other.org:99";
s.hostname = "[::1]";
console.log(s.href, s.host, s.hostname, s.port);
s.port = "443";
s.protocol = "ftp";
console.log(s.href);
s.href = "http://reset/";
console.log(s.href, s.search, s.hash);

// searchParams follows the URL, and the URL follows searchParams
const sp = s.searchParams;
console.log(sp === s.searchParams, sp.size, String(sp));
s.search = "?a=1&b=2&a=3";
console.log(sp.getAll("a"), sp.get("b"), sp.get("c"), sp.has("a"), sp.has("a", "3"), sp.has("a", "4"), sp.size);
sp.append("c", "x y&z");
sp.set("a", "one");
sp.delete("b");
console.log(s.href, [...sp]);
sp.sort();
console.log(s.search);
sp.delete("a");
sp.delete("c");
console.log(JSON.stringify(s.href), s.search, sp.size);

// URLSearchParams on its own
const p = new URLSearchParams("?a=1&b=2+3&c=%41%zz&=e&f&&g=h=i");
console.log([...p], p.toString(), p);
console.log(String(new URLSearchParams({ x: 1, y: [1, 2], "a b": "c&d" })), String(new URLSearchParams([["k", "v"], new Set(["s", "t"])])));
console.log(String(new URLSearchParams(p)), String(new URLSearchParams(new Map([["m", "n"]]))), new URLSearchParams(), new URLSearchParams(""));
console.log(String(new URLSearchParams("é=ü&💩=\ud800")), new URLSearchParams("q=%F0%9F%92%A9%FF").get("q"));
const order = new URLSearchParams("z=1&a=2&z=0&b=1&a=1");
order.sort();
console.log(order.toString());
const seen = [];
order.forEach(function (value, key, obj) {
  seen.push(`${key}=${value}:${obj === order}:${this.tag}`);
}, { tag: "T" });
console.log(seen.join(" "));
console.log(order.keys(), order.values(), order.entries(), [...order.keys()], Array.from(order.values()));
const it = order.entries();
it.next();
console.log(it, it.next(), Object.prototype.toString.call(it), Object.prototype.toString.call(order));
console.log(new URLSearchParams("aaaaaaaaaaaaaaaa=bbbbbbbbbbbbbbbbbbbbbb&cccccccccccccccccccccc=dddddddddddddddddddd&eeeeeeeeeeeeeeeeeeeeeeee=1"));
class MyParams extends URLSearchParams {}
console.log(new MyParams("a=1"), new MyParams("a=1") instanceof URLSearchParams);
class MyURL extends URL {}
console.log(new MyURL("http://h/").href, new MyURL("http://h/") instanceof URL);

// errors
t(() => new URL("nope"));
t(() => new URL("nope", "also bad"));
t(() => new URL());
t(() => URL("http://a"));
t(() => {
  s.href = "bad";
});
t(() => URL.canParse());
t(() => Reflect.get(URL.prototype, "href", {}));
t(() => p.append("a"));
t(() => p.get());
t(() => p.set("a"));
t(() => p.delete());
t(() => p.has());
t(() => p.getAll());
t(() => p.forEach());
t(() => p.forEach(5));
t(() => new URLSearchParams([[1]]));
t(() => new URLSearchParams([1]));
t(() => new URLSearchParams([["a", "b", "c"]]));
t(() => URLSearchParams.prototype.get.call({}, "a"));
t(() => URLSearchParams());
t(() => order.keys().next.call({}));

// the globals' attributes
const shown = (k) => Object.getOwnPropertyDescriptor(globalThis, k).enumerable;
console.log(shown("URL"), shown("URLSearchParams"), URL.length, URLSearchParams.length, Object.getOwnPropertyDescriptor(URL.prototype, "href").enumerable);
