// fetch() against a local node:http server: the headers it sends, request bodies, redirects,
// decoded and streamed responses, data: URLs, aborts and its errors.
import http from "node:http";
import zlib from "node:zlib";

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://localhost");
    const body = Buffer.concat(chunks).toString();
    switch (url.pathname) {
      case "/echo":
        res.setHeader("content-type", "application/json");
        res.setHeader("set-cookie", ["a=1", "b=2"]);
        res.end(JSON.stringify({ method: req.method, url: req.url, rawHeaders: req.rawHeaders, body }).replace(/127\.0\.0\.1:\d+/g, "HOST"));
        return;
      case "/redirect":
        res.writeHead(Number(url.searchParams.get("status") ?? 302), { location: url.searchParams.get("to") ?? "/echo" });
        res.end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      case "/encoded": {
        const text = "decoded " + "text ".repeat(50);
        const coding = url.searchParams.get("coding");
        const encoded = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, "deflate-raw": zlib.deflateRawSync, br: zlib.brotliCompressSync,
          zstd: zlib.zstdCompressSync, "gzip, br": (t) => zlib.brotliCompressSync(zlib.gzipSync(t)) }[coding](text);
        res.writeHead(200, { "content-encoding": coding === "deflate-raw" ? "deflate" : coding });
        res.end(encoded);
        return;
      }
      case "/chunks": {
        let n = 0;
        const timer = setInterval(() => {
          res.write(`chunk ${n}\n`);
          if (++n === 3) {
            clearInterval(timer);
            res.end();
          }
        }, 10);
        return;
      }
      case "/slow":
        setTimeout(() => res.end("late"), 1000);
        return;
      case "/no-content":
        res.writeHead(204);
        res.end();
        return;
      default:
        res.writeHead(404, "Not Here");
        res.end("missing");
    }
  });
});

const describeError = (e) => {
  const cause = e.cause && { name: e.cause.name, message: e.cause.message.replace(/:\d+$/, ":PORT"), code: e.cause.code };
  return { name: e.name, message: e.message, cause };
};

const describeResponse = async (r) => ({
  status: r.status,
  statusText: r.statusText,
  ok: r.ok,
  redirected: r.redirected,
  type: r.type,
  url: r.url.replace(/:\d+\//, ":PORT/"),
  headers: [...r.headers].filter(([name]) => name !== "date" && name !== "keep-alive"),
  body: (await r.text()).replace(/:\d+\//g, ":PORT/"),
});

const show = async (label, request) => {
  try {
    console.log(label, await describeResponse(await request));
  } catch (e) {
    console.log(label, "rejected", describeError(e));
  }
};

server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(typeof fetch, fetch.name, fetch.length);

  /* what's sent */
  await show("GET", fetch(base + "/echo?x=1#frag"));
  await show("POST text", fetch(base + "/echo", { method: "POST", body: "hello", headers: { "X-Custom": "yes", Accept: "text/plain" } }));
  await show("POST params", fetch(new URL("/echo", base), { method: "post", body: new URLSearchParams({ a: "1", b: "two" }) }));
  await show("PUT bytes", fetch(base + "/echo", { method: "PUT", body: new Uint8Array([104, 105]) }));
  await show("POST blob", fetch(base + "/echo", { method: "POST", body: new Blob(["blob body"], { type: "text/x-blob" }) }));
  await show("POST empty", fetch(base + "/echo", { method: "POST" }));
  await show("DELETE", fetch(base + "/echo", { method: "DELETE" }));
  await show("PATCH stream", fetch(base + "/echo", {
    method: "PATCH",
    duplex: "half",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed "));
        controller.enqueue(new TextEncoder().encode("body"));
        controller.close();
      },
    }),
  }));
  await show("Request", fetch(new Request(base + "/echo", { method: "POST", body: "from a Request", headers: [["x-list", "1"]] })));
  await show("HEAD", fetch(base + "/echo", { method: "HEAD" }));
  await show("Headers object", fetch(base + "/echo", { headers: new Headers({ "user-agent": "mine", "accept-encoding": "identity" }) }));

  /* redirects */
  await show("302 POST", fetch(base + "/redirect", { method: "POST", body: "dropped" }));
  await show("303 PUT", fetch(base + "/redirect?status=303", { method: "PUT", body: "dropped" }));
  await show("307 POST", fetch(base + "/redirect?status=307", { method: "POST", body: "kept" }));
  await show("308 query", fetch(base + "/redirect?status=308&to=%2Fecho%3Fmoved%3D1"));
  await show("manual", fetch(base + "/redirect", { redirect: "manual" }));
  await show("error", fetch(base + "/redirect", { redirect: "error" }));
  await show("loop", fetch(base + "/loop"));
  await show("to ftp", fetch(base + "/redirect?to=ftp%3A%2F%2Fexample.com%2F"));

  /* responses */
  for (const coding of ["gzip", "deflate", "deflate-raw", "br", "zstd", "gzip, br"]) await show(coding, fetch(base + "/encoded?coding=" + encodeURIComponent(coding)));
  await show("404", fetch(base + "/missing"));
  await show("204", fetch(base + "/no-content"));
  const json = await fetch(base + "/echo", { method: "POST", body: JSON.stringify({ n: 1 }) });
  console.log("json", (await json.json()).body, json.bodyUsed, json.headers.getSetCookie());
  const streamed = await fetch(base + "/chunks");
  const pieces = [];
  for await (const chunk of streamed.body) pieces.push(new TextDecoder().decode(chunk));
  console.log("stream", pieces.join("").split("\n"), streamed.bodyUsed);
  const cloned = await fetch(base + "/chunks");
  const copy = cloned.clone();
  console.log("clone", await cloned.text() === await copy.text());
  const bytes = await (await fetch(base + "/encoded?coding=gzip")).bytes();
  console.log("bytes", bytes.constructor.name, bytes.length);
  try {
    await json.text();
  } catch (e) {
    console.log("reused", describeError(e));
  }

  /* data: URLs */
  await show("data base64", fetch("data:text/plain;base64,aGVsbG8gd29ybGQ="));
  await show("data plain", fetch("data:,Hello%2C%20World%21"));
  await show("data mime", fetch("data:Text/HTML;Charset=UTF-8,<b>hi</b>"));

  /* aborts */
  await show("timeout", fetch(base + "/slow", { signal: AbortSignal.timeout(50) }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await show("abort", fetch(base + "/slow", { signal: controller.signal }));
  try {
    await fetch(base + "/echo", { signal: AbortSignal.abort("my reason") });
  } catch (e) {
    console.log("abort reason", e);
  }
  const mid = new AbortController();
  const reading = await fetch(base + "/chunks", { signal: mid.signal });
  mid.abort();
  try {
    await reading.text();
  } catch (e) {
    console.log("abort body", describeError(e));
  }

  /* failures */
  await show("bad URL", fetch("not a url"));
  await show("credentials", fetch("http://user:pass@127.0.0.1/"));
  await show("GET body", fetch(base + "/echo", { body: "x" }));
  await show("bad method", fetch(base + "/echo", { method: "bad method" }));
  await show("CONNECT", fetch(base + "/echo", { method: "CONNECT" }));
  await show("bad port", fetch("http://127.0.0.1:6000/"));
  await show("unknown scheme", fetch("ftp://example.com/"));
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = closed.address().port;
  closed.close();
  await show("refused", fetch(`http://127.0.0.1:${closedPort}/`));

  server.close();
  server.closeAllConnections();
});
