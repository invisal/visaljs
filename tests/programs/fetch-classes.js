// Request and Response, as Node's (undici's): construction, bodies, headers, the statics,
// cloning, errors and inspection. fetch() itself isn't provided yet.
const err = async (f) => {
  try {
    await f();
    return "no error";
  } catch (e) {
    return `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
  }
};

const r = new Response("hi", { status: 201, headers: { "X-A": "1" } });
console.log(r);
console.log(r.status, r.ok, r.statusText, r.type, r.url, r.redirected, r.bodyUsed, r.headers.get("content-type"));
console.log(await r.text(), r.bodyUsed, await err(() => r.text()), await err(() => r.clone()));

const q = new Request("http://x.test/a?b", { method: "post", body: '{"a":1}', headers: { "content-type": "application/json" } });
console.log(q);
console.log(q.method, q.url, q.mode, q.credentials, q.cache, q.redirect, q.referrer, q.keepalive, q.duplex, q.signal.aborted);
console.log(await q.json(), q.bodyUsed, await err(() => q.text()));

/* bodies */
console.log(await new Response(new Uint8Array([104, 105])).text(), JSON.stringify(await new Response(null).text()), new Response().body, new Response("x").body);
console.log(await new Response(new Blob(["b"], { type: "a/b" })).headers.get("content-type"), new Response(new URLSearchParams("a=1")).headers.get("content-type"));
console.log(await new Response(new URLSearchParams("a=1&b=2")).text(), await new Response(new ArrayBuffer(2)).arrayBuffer());
console.log(await new Response("xyz").blob(), await new Response("ab").arrayBuffer(), await new Response("ab").bytes());
const streamed = new Response(new ReadableStream({
  start(c) {
    c.enqueue(new TextEncoder().encode("str"));
    c.enqueue(new TextEncoder().encode("eam"));
    c.close();
  },
}));
console.log(streamed.headers.get("content-type"), await streamed.text());
const body = new Response("chunks").body;
const reader = body.getReader();
console.log(await reader.read(), await reader.read());
const used = new Response("u");
used.body.getReader();
console.log(await err(() => used.text()), used.bodyUsed);

/* statics */
const j = Response.json({ a: 1 }, { status: 202, headers: { "x-j": "1" } });
console.log(j.status, j.headers.get("content-type"), j.headers.get("x-j"), await j.text());
console.log(Response.json("s", { headers: { "content-type": "text/x" } }).headers.get("content-type"));
const red = Response.redirect("http://x.test/b", 301);
console.log(red.status, red.headers.get("location"), await err(() => red.headers.set("a", "b")));
const e = Response.error();
console.log(e.type, e.status, e.ok, await err(() => e.headers.append("a", "b")));

/* clones */
const c = new Response("abc");
const c2 = c.clone();
console.log(await c.text(), await c2.text());
const sc = new Response(new ReadableStream({ start(k) { k.enqueue(new Uint8Array([65])); k.close(); } }));
const sc2 = sc.clone();
console.log(await sc.text(), await sc2.text());
const q2 = new Request(q.url, { method: "PUT", body: "x" });
const q3 = new Request(q2);
console.log(q3.method, q3.url, await q3.text(), q2.bodyUsed, await err(() => new Request(q2)));
const qc = new Request("http://x/", { method: "POST", body: "cloned" }).clone();
console.log(await qc.text(), new Request("http://x/", { method: "Get" }).method, new Request("http://x/", { method: "delete" }).method);

/* signals follow the given one */
const ac = new AbortController();
const qs = new Request("http://x/", { signal: ac.signal });
ac.abort("why");
console.log(qs.signal !== ac.signal, qs.signal.aborted, qs.signal.reason);

/* errors */
console.log(await err(() => new Response("x", { status: 99 })), "|", await err(() => new Response("x", { status: 204 })));
console.log(await err(() => new Request("/rel")), "|", await err(() => new Request("http://x/", { method: "GET", body: "x" })));
console.log(await err(() => new Request("http://x/", { method: "CONNECT" })), "|", await err(() => new Request("http://x/", { method: "bad method" })));
console.log(await err(() => new Request("http://x/", { method: "POST", body: new ReadableStream() })), "|", await err(() => Response()));
console.log(await err(() => Response.redirect("http://x/", 200)), "|", await err(() => Response.json(undefined)), "|", await err(() => new Request()));

/* subclasses (frameworks extend them) */
class MyResponse extends Response {
  get extra() {
    return this.status * 2;
  }
}
const mr = new MyResponse("m", { status: 210 });
console.log(mr.extra, mr instanceof Response, await mr.text());
class MyRequest extends Request {}
console.log(new MyRequest("http://x/y").url, Object.keys(Response.prototype), Object.keys(Request.prototype).length);
