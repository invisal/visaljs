// Node APIs a framework's production server uses (Next.js's): require.extensions, node:inspector
// loaded without a debugger,
// process.hrtime.bigint, depd's deprecation wrapper (new Function), an async iterable as a fetch
// body, and the head a response sends through its own writeHead (on-headers, compression).
import fs from "node:fs";
import http from "node:http";
import inspector from "node:inspector";
import { createRequire } from "node:module";
import net from "node:net";
import { Readable } from "node:stream";

/* deprecated, but read: Next.js's require hook saves the old loader */
const require = createRequire(import.meta.url);
print(`require.extensions: ${typeof require.extensions}, its .js: ${typeof require.extensions[".js"]}`);
print(`inspector.url(): ${inspector.url()}`);
const t = process.hrtime.bigint();
print(`hrtime.bigint: ${typeof t}, positive: ${t > 0n}`);

/* depd's wrapfunction, as depd (and Next's vendored send) writes it */
function wrapfunction(fn, message) {
  const site = "here";
  return new Function("fn", "log", "deprecate", "message", "site",
    '"use strict"\nreturn function (a, b) {' + "log.call(deprecate, message, site)\nreturn fn.apply(this, arguments)\n}")(
    fn, (m) => print(`deprecated: ${m}`), {}, message, site);
}
print(`wrapped: ${wrapfunction((a, b) => a + b, "add() is old")(2, 3)}`);

/* bodies as undici takes them: a Node Readable, an async generator */
async function* parts() {
  yield new TextEncoder().encode('{"a":');
  yield "1}";
}
print(`Request(Readable): ${JSON.stringify(await new Request("http://x/", { method: "POST", body: Readable.from([Buffer.from('{"b":2}')]), duplex: "half" }).json())}`);
print(`Request(async generator): ${await new Request("http://x/", { method: "POST", body: parts(), duplex: "half" }).text()}`);
print(`Response(Readable): ${await new Response(Readable.from([Buffer.from("hi")])).text()}`);

/* a writeHead wrapper (on-headers) runs for the implicit head, and _implicitHeader sends it */
function onHeaders(res, listener) {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    listener.call(this);
    return writeHead.apply(this, args);
  };
}
const server = http.createServer((req, res) => {
  if (req.url !== "/plain") onHeaders(res, function () { this.setHeader("Vary", "Accept-Encoding"); });
  res.setHeader("Content-Type", "text/plain");
  if (req.url === "/write") {
    res.write("a");
    res.end("b");
  } else if (req.url === "/implicit") {
    res.statusCode = 202;
    res._implicitHeader();
    res.end("ok");
  } else if (req.url === "/flush") {
    res.flushHeaders();
    res.end("flushed");
  } else if (req.url === "/no-message") {
    res.statusMessage = "";  /* Next.js's route handlers: the standard one goes out */
    res.end("{}");
  } else if (req.url === "/empty") {
    res.statusCode = 204;
    res.end();
  } else {
    res.end("ab");
  }
});
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
for (const path of ["/write", "/end", "/implicit", "/flush", "/no-message", "/empty", "/plain"]) {
  const raw = await new Promise((resolve) => {
    let data = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    socket.on("data", (d) => (data += d));
    socket.on("end", () => resolve(data));
  });
  print(`${path} ${JSON.stringify(raw.replace(/\r\nDate: [^\r]*/, ""))}`);
}
server.close();

/* a Stats date is its milliseconds rounded, as Node's (send's ETag is made from mtime) */
fs.writeFileSync("mtime.txt", "x");
fs.utimesSync("mtime.txt", 1.0006, 1.0006);
print(`mtime: ${fs.statSync("mtime.txt").mtime.getTime()}`);
