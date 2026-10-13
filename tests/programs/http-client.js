// node:http's client: request/get, the bytes it sends, responses (bodies, HEAD, chunked with
// trailers, 1xx), keep-alive reuse through the agent, maxSockets, errors, timeouts, upgrades
import http from "node:http";
import net from "node:net";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const closed = (server) => new Promise((resolve) => server.close(resolve));
const caught = (fn) => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e.name + " " + e.code + ": " + e.message;
  }
};

/* a raw server: logs each request's bytes (port masked), answers with `reply(n)` */
async function rawServer(reply) {
  let n = 0;
  const server = net.createServer((socket) => {
    let buf = "";
    socket.setEncoding("latin1");
    socket.on("data", (d) => {
      buf += d;
      for (;;) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.slice(0, end + 4);
        const length = /content-length: (\d+)/i.exec(head);
        let total = end + 4 + (length ? +length[1] : 0);
        if (/transfer-encoding: chunked/i.test(head)) {
          const last = buf.indexOf("0\r\n\r\n", end + 4);
          if (last < 0) return;
          total = last + 5;
        }
        if (buf.length < total) return;
        console.log("  sent:", JSON.stringify(buf.slice(0, total).replace(/127\.0\.0\.1:\d+/, "127.0.0.1:<port>")));
        buf = buf.slice(total);
        const r = reply(n++, socket);
        if (r !== undefined) socket.write(r);
      }
    });
    socket.on("error", () => {});
  });
  const port = await listen(server);
  return { server, port };
}

const ok = (body = "ok", extra = "") => `HTTP/1.1 200 OK\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

function collect(res) {
  return new Promise((resolve) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (d) => (body += d));
    res.on("end", () => resolve(body));
  });
}

async function requests() {
  const { server, port } = await rawServer(() => ok("hello", "X-Reply: yes\r\n"));
  const base = { host: "127.0.0.1", port };
  await new Promise((resolve) => {
    const events = [];
    const req = http.request(base, async (res) => {
      events.push("response " + res.statusCode + " " + res.statusMessage + " " + res.httpVersion);
      console.log("  headers:", JSON.stringify(res.headers), JSON.stringify(res.rawHeaders));
      events.push("body " + (await collect(res)));
    });
    req.on("socket", (socket) => events.push("socket " + (socket instanceof net.Socket)));
    req.on("finish", () => events.push("finish"));
    req.on("close", () => {
      events.push("close");
      console.log("  events:", events.join(", "));
      resolve();
    });
    req.end();
  });
  const send = (options, body, write) => new Promise((resolve) => {
    const req = http.request({ ...base, ...options }, (res) => collect(res).then(resolve));
    if (write) req.write(write);
    req.end(body);
  });
  await send({ method: "POST" }, "a body");
  await send({ method: "post", headers: { "Content-Type": "text/plain" } }, undefined, "streamed");
  await send({ method: "PUT", path: "/p?q=1", auth: "user:pass", headers: { "X-A": ["1", "2"] } }, Buffer.from("bytes"));
  await send({ headers: [["X-Raw", "1"], ["Host", "example"]] });
  await send({ agent: false, setHost: false });
  await new Promise((resolve) => http.get(`http://user:pw@127.0.0.1:${port}/from/url?x=1`, (res) => collect(res).then(resolve)));
  await new Promise((resolve) => http.get(new URL(`http://127.0.0.1:${port}/url-object`), { headers: { "X-Extra": "1" } }, (res) => collect(res).then(resolve)));
  await closed(server);
  http.globalAgent.destroy();
}

async function responses() {
  const replies = [
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n",  /* to a HEAD: no body follows */
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Sum\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\nX-Sum: 5\r\n\r\n",
    "HTTP/1.1 103 Early Hints\r\nLink: </style.css>\r\n\r\nHTTP/1.1 100 Continue\r\n\r\n" + ok("after hints"),
    "HTTP/1.1 404 Not Found\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 4\r\n\r\nnope",
    "HTTP/1.0 200 OK\r\n\r\nuntil the end",
  ];
  const { server, port } = await rawServer((n, socket) => {
    if (n === 4) {
      socket.end(replies[4]);
      return undefined;
    }
    return replies[n];
  });
  const base = { host: "127.0.0.1", port };
  const head = await new Promise((resolve) => http.request({ ...base, method: "HEAD" }, (res) => collect(res).then((b) => resolve([res.headers["content-length"], b]))).end());
  console.log("  HEAD:", JSON.stringify(head));
  const chunked = await new Promise((resolve) => http.get(base, (res) => collect(res).then((b) => resolve([b, res.trailers, res.rawTrailers]))));
  console.log("  chunked:", JSON.stringify(chunked));
  const info = [];
  const informational = await new Promise((resolve) => {
    const req = http.get(base, (res) => collect(res).then((b) => resolve(res.statusCode + " " + b)));
    req.on("information", (i) => info.push(i.statusCode + " " + i.statusMessage + " " + JSON.stringify(i.headers)));
    req.on("continue", () => info.push("continue"));
  });
  console.log("  1xx:", info.join(" | "), "->", informational);
  const notFound = await new Promise((resolve) => http.get(base, (res) => collect(res).then((b) => resolve([res.statusCode, res.headers["set-cookie"], b]))));
  console.log("  404:", JSON.stringify(notFound));
  const http10 = await new Promise((resolve) => http.get(base, (res) => collect(res).then((b) => resolve([res.httpVersion, b, res.complete]))));
  console.log("  HTTP/1.0:", JSON.stringify(http10));
  await closed(server);
  http.globalAgent.destroy();
}

// keep-alive: the second request reuses the first's socket; the idle socket doesn't keep the program running
async function keepAlive() {
  const server = http.createServer((req, res) => res.end(req.url));
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const sockets = [];
  const order = [];
  await Promise.all(["/a", "/b", "/c"].map((path) => new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent }, (res) => collect(res).then((b) => {
      order.push(b + (req.reusedSocket ? " (reused)" : ""));
      resolve();
    }));
    req.on("socket", (s) => sockets.push(s));
  })));
  await new Promise((r) => setImmediate(r));
  console.log("  maxSockets 1:", order.join(", "), "one socket:", sockets.every((s) => s === sockets[0]),
    "free:", Object.keys(agent.freeSockets).length, "in use:", Object.keys(agent.sockets).length);
  console.log("  name:", agent.getName({ host: "h", port: 1, localAddress: "l", family: 4 }));
  agent.destroy();
  server.closeAllConnections();
  await closed(server);
}

async function failures() {
  const probe = net.createServer();
  const free = await listen(probe);
  await closed(probe);
  await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: free });
    req.on("error", (e) => console.log("  refused:", e.code, e.syscall, e.message.replace(/:\d+$/, ":<port>")));
    req.on("close", resolve);
  });
  const { server, port } = await rawServer((n, socket) => {
    if (n === 0) socket.destroy();          /* no response at all */
    if (n === 1) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort");  /* the body cut short */
    if (n === 3) return "BROKEN\r\n\r\n";
    return undefined;                       /* n === 2: never answers */
  });
  const base = { host: "127.0.0.1", port, agent: false };
  await new Promise((resolve) => {
    const req = http.get(base);
    req.on("error", (e) => console.log("  hang up:", e.code, e.message));
    req.on("close", resolve);
  });
  await new Promise((resolve) => {
    http.get(base, (res) => {
      res.on("data", () => {});
      res.on("aborted", () => console.log("  response aborted"));
      res.on("error", (e) => console.log("  response error:", e.code, e.message));
      res.on("close", () => resolve());
    });
  });
  await new Promise((resolve) => {
    const req = http.get(base);
    req.setTimeout(30, () => {
      console.log("  timeout");
      req.destroy();
    });
    req.on("error", (e) => console.log("  after timeout:", e.code, e.message));
    req.on("close", resolve);
  });
  await new Promise((resolve) => {
    const req = http.get(base);
    req.on("error", (e) => console.log("  parse error:", e.code, e.message));
    req.on("close", resolve);
  });
  await closed(server);
  console.log(caught(() => http.request("https://example.com/")));
  console.log(caught(() => http.request({ method: "BAD METHOD" })));
  console.log(caught(() => http.request({ path: "/a b" })));
  console.log(caught(() => http.request({ agent: 5 })));
}

async function upgrades() {
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\nfrom server");
    socket.on("data", (d) => socket.end("echo " + d));
  });
  server.on("connect", (req, socket) => socket.end("HTTP/1.1 200 Connection Established\r\n\r\ntunnel open"));
  const port = await listen(server);
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, headers: { Connection: "Upgrade", Upgrade: "echo" } });
    req.on("upgrade", (res, socket, head) => {
      console.log("  upgrade:", res.statusCode, res.headers.upgrade, JSON.stringify(String(head)));
      let text = "";
      socket.on("data", (d) => (text += d));
      socket.on("close", () => {
        console.log("  upgraded socket:", JSON.stringify(text));
        resolve();
      });
      socket.write("ping");
    });
    req.end();
  });
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: "example.com:443" });
    req.on("connect", (res, socket, head) => {
      console.log("  connect:", res.statusCode, res.statusMessage, JSON.stringify(String(head)));
      socket.on("data", () => {});
      socket.on("close", resolve);
    });
    req.end();
  });
  await closed(server);
}

console.log("requests:");
await requests();
console.log("responses:");
await responses();
console.log("keep-alive:");
await keepAlive();
console.log("failures:");
await failures();
console.log("upgrades:");
await upgrades();
console.log(typeof http.Agent, http.globalAgent instanceof http.Agent, http.globalAgent.keepAlive, http.globalAgent.options.timeout,
  typeof http.ClientRequest);
