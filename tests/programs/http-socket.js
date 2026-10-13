// node:http on net.Socket: a request's socket, upgrades and CONNECT, parse errors, timeouts and
// the keep-alive timeout. The client side is raw net sockets, so the bytes are exact.
import http from "node:http";
import net from "node:net";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const closed = (server) => new Promise((resolve) => server.close(resolve));
const dated = (s) => s.replace(/\r\nDate: [^\r]*/g, "\r\nDate: <date>");

/* sends `data`, collects what comes back until the server closes (or `until` matches) */
function exchange(port, data, until) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(data));
    let text = "";
    socket.setEncoding("latin1");
    socket.on("data", (d) => {
      text += d;
      if (until && until.test(text)) socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve(dated(text)));
  });
}

async function sockets() {
  const server = http.createServer((req, res) => {
    const s = req.socket;
    res.end([s instanceof net.Socket, s === res.socket, s.remoteAddress, s.remoteFamily, typeof s.remotePort, s.localPort === port,
      req.connection === s, s.readyState].join(" "));
  });
  let connections = 0;
  server.on("connection", (socket) => {
    connections++;
    console.log("connection:", socket instanceof net.Socket, socket.remoteAddress);
  });
  const port = await listen(server);
  console.log(JSON.stringify(await exchange(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")));
  await closed(server);
  console.log("connections:", connections, server instanceof net.Server);
}

async function upgrades() {
  const server = http.createServer((req, res) => res.end("plain " + req.upgrade));
  server.on("upgrade", (req, socket, head) => {
    console.log("upgrade:", req.method, req.url, req.headers.upgrade, JSON.stringify(String(head)), socket instanceof net.Socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
    if (head.length) socket.write("echo: " + head);
    socket.on("data", (d) => {
      if (String(d).includes("bye")) socket.end("echo: " + d);
      else socket.write("echo: " + d);
    });
  });
  server.on("connect", (req, socket, head) => {
    console.log("connect:", req.url, JSON.stringify(String(head)));
    socket.end("HTTP/1.1 200 Connection Established\r\n\r\ntunnel");
  });
  const port = await listen(server);
  const upgraded = await new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () =>
      socket.write("GET /chat HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\nfirst"));
    let text = "";
    socket.setEncoding("latin1");
    socket.on("data", (d) => {
      text += d;
      if (text.endsWith("echo: first")) socket.write("second");
      else if (text.endsWith("echo: second")) socket.write("bye");
    });
    socket.on("close", () => resolve(text));
  });
  console.log(JSON.stringify(upgraded));
  console.log(JSON.stringify(await exchange(port, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nhello")));
  server.removeAllListeners("upgrade");
  console.log(JSON.stringify(await exchange(port,
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, close\r\nUpgrade: echo\r\n\r\n")));
  await closed(server);
}

async function errors() {
  const server = http.createServer((req, res) => res.end("ok"));
  const port = await listen(server);
  console.log(JSON.stringify(await exchange(port, "NOT HTTP\r\n\r\n")));
  server.on("clientError", (err, socket) => {
    console.log("clientError:", err.code, err.message, err.reason);
    socket.end("HTTP/1.1 400 Custom\r\nConnection: close\r\n\r\n");
  });
  console.log(JSON.stringify(await exchange(port, "GET / HTTP/1.1\r\nHost x\r\n\r\n")));
  await closed(server);
}

async function timeouts() {
  const server = http.createServer(() => {});  /* never answers */
  server.setTimeout(30, (socket) => {
    console.log("server timeout:", socket instanceof net.Socket);
    socket.end("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n");
  });
  const port = await listen(server);
  console.log(JSON.stringify(await exchange(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n")));
  server.removeAllListeners("timeout");
  server.removeAllListeners("request");
  server.on("request", (req, res) => res.setTimeout(20, () => res.end("late")));
  console.log(JSON.stringify(await exchange(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")));
  server.closeAllConnections();
  await closed(server);
}

// idle keep-alive connections close after keepAliveTimeout; close() closes the idle ones at once
async function keepAlive() {
  const server = http.createServer((req, res) => res.end("hi"));
  server.keepAliveTimeout = 2000;
  const port = await listen(server);
  console.log(JSON.stringify(await exchange(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", /hi$/)));
  server.keepAliveTimeout = 40;
  const start = Date.now();
  const text = await exchange(port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
  console.log(JSON.stringify(text), "closed by the server after the timeout:", Date.now() - start >= 35);
  const idle = await new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    socket.on("data", () => {
      server.keepAliveTimeout = 0;
      server.close(() => resolve("server closed"));
    });
    socket.on("close", () => console.log("idle connection closed by close()"));
  });
  console.log(idle);
}

await sockets();
await upgrades();
await errors();
await timeouts();
await keepAlive();
