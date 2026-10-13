// node:https: a server and clients in one program: requests through the global agent and one of
// their own, keep-alive (the TLS socket reused, and its session), request bodies both ways, a
// chunked response, https.get, a request with its own SNI name, verification failures, an
// upgrade, a client error, and https.Server's http settings.
import { readFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import tls from "node:tls";

const file = (name) => readFileSync(join(import.meta.dirname, "data", "tls", name));
const ca = file("ca.pem");

const server = https.createServer({ key: file("server.key"), cert: file("server.pem") }, (req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.url === "/chunked") {
      res.write("first ");
      res.end("second");
      return;
    }
    res.setHeader("content-type", "text/plain");
    const host = req.headers.host.replace(/:\d+$/, ":PORT");
    res.end(`${req.method} ${req.url} ${host} body=${body} encrypted=${req.socket.encrypted} alpn=${req.socket.alpnProtocol}`);
  });
});
server.on("upgrade", (req, socket, head) => {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
  socket.on("data", (chunk) => socket.end("echo: " + chunk));
  if (head.length) socket.write("head: " + head);
});
server.on("clientError", (err, socket) => {
  print("clientError: " + err.code + (err.reason ? " " + err.reason : ""));
  socket.destroy();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
print("server: " + (server instanceof https.Server) + " " + server.requestTimeout + " " + server.keepAliveTimeout + " " + server.headersTimeout);

/* a request; resolves with "status body" */
function call(options, body) {
  return new Promise((resolve) => {
    const req = https.request({ host: "localhost", port, ca, ...options }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve(`${res.statusCode} ${res.headers["content-type"] ?? "-"} ${text}`));
    });
    req.on("error", (err) => resolve("error " + err.code));
    req.end(body);
  });
}

print(await call({ path: "/one" }));
print(await call({ method: "POST", path: "/post" }, "hello"));
print(await call({ path: "/chunked" }));

/* keep-alive: the global agent's free socket serves the next request */
{
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  const sockets = [];
  const one = () => new Promise((resolve) => {
    const req = https.request({ host: "localhost", port, ca, agent, path: "/ka" }, (res) => {
      sockets.push(req.socket);
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.end();
  });
  print("keep-alive: " + (await one()) + " " + (await one()) + " same socket " + (sockets[0] === sockets[1]) + " port " + agent.defaultPort + " " + agent.protocol);
  agent.destroy();
}

/* a new agent's second connection resumes the first one's session */
{
  const agent = new https.Agent({ maxSockets: 1 });
  const resumed = [];
  const one = () => new Promise((resolve) => {
    const req = https.get({ host: "localhost", port, ca, agent, path: "/s" }, (res) => {
      resumed.push(req.socket.isSessionReused());
      res.resume();
      res.on("end", resolve);
    });
  });
  await one();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await one();
  print("session reused: " + resumed.join(" "));
}

/* get with a URL, and the Host header naming the server (SNI) */
print(await new Promise((resolve) => {
  https.get(new URL(`https://localhost:${port}/url?q=1`), { ca }, (res) => {
    let text = "";
    res.on("data", (chunk) => (text += chunk));
    res.on("end", () => resolve("get: " + res.statusCode + " " + text));
  });
}));
print(await call({ host: "127.0.0.1", headers: { host: "localhost" }, path: "/sni" }));

/* verification: no CA, the wrong name */
print("no ca: " + (await call({ ca: undefined, path: "/" })));
print("wrong name: " + (await call({ servername: "other.example", path: "/" })));
print("rejectUnauthorized false: " + (await call({ ca: undefined, rejectUnauthorized: false, path: "/insecure" })));

/* an upgrade over TLS */
print(await new Promise((resolve) => {
  const req = https.request({ host: "localhost", port, ca, headers: { connection: "Upgrade", upgrade: "echo" } });
  req.on("upgrade", (res, socket) => {
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => resolve("upgrade: " + res.statusCode + " " + text));
    socket.write("ping");
  });
  req.end();
}));

/* bytes that aren't HTTP: the parser's error, over TLS */
await new Promise((resolve) => {
  const socket = tls.connect({ host: "localhost", port, ca }, () => socket.write("NOT HTTP AT ALL\r\n\r\n"));
  socket.on("close", resolve);
  socket.on("error", () => {});
  socket.resume();
});

https.globalAgent.destroy();
server.close(() => print("closed"));
