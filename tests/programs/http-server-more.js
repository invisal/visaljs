// node:http, the server's remaining pieces: trailers both ways, headersTimeout and
// requestTimeout, requireHostHeader, maxHeaderSize, joinDuplicateHeaders, and header validation
import http from "node:http";
import net from "node:net";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const closed = (server) => new Promise((resolve) => server.close(resolve));
const dated = (s) => s.replace(/\r\nDate: [^\r]*/g, "\r\nDate: <date>");
const caught = (fn) => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e.name + " " + e.code + ": " + e.message;
  }
};

/* sends `data` in parts (`gap` ms apart), collects the reply until the server closes or `until` matches */
function exchange(port, parts, until, gap = 0) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", async () => {
      for (const part of [].concat(parts)) {
        socket.write(part);
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
    });
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

async function trailers() {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      console.log("trailers in:", JSON.stringify(req.trailers), JSON.stringify(req.rawTrailers));
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("Trailer", "Content-MD5, X-Count");
      res.write("body");
      res.addTrailers({ "Content-MD5": "abc", "X-Count": ["1", "2"] });
      res.end();
    });
  });
  const port = await listen(server);
  console.log(JSON.stringify(await exchange(port,
    "POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n0\r\nX-Sum: 6\r\nX-Note: a\r\nx-note: b\r\n\r\n")));
  await closed(server);
}

async function timeouts() {
  const server = http.createServer({ headersTimeout: 100, requestTimeout: 250, connectionsCheckingInterval: 20 }, (req, res) => {
    req.on("data", () => {});
    req.on("end", () => res.end("done"));
  });
  console.log("timeouts:", server.headersTimeout, server.requestTimeout, server.connectionsCheckingInterval);
  const port = await listen(server);
  let start = Date.now();
  console.log("head too slow:", JSON.stringify(await exchange(port, "GET / HTTP/1.1\r\nHost: x\r\n")), Date.now() - start >= 90);
  start = Date.now();
  console.log("body too slow:", JSON.stringify(await exchange(port, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc")),
    Date.now() - start >= 240);
  console.log("in time:", JSON.stringify(await exchange(port,
    ["POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 6\r\nConnection: close\r\n\r\n", "abc", "def"], null, 20)));
  await closed(server);
  console.log(caught(() => http.createServer({ headersTimeout: 10, requestTimeout: 5 })));
  console.log(caught(() => http.createServer({ requestTimeout: -1 })));
  console.log(caught(() => http.createServer({ requireHostHeader: "yes" })));
}

async function heads() {
  const server = http.createServer((req, res) => res.end(JSON.stringify(req.headers["user-agent"])));
  const port = await listen(server);
  console.log("no host:", JSON.stringify(await exchange(port, "GET / HTTP/1.1\r\n\r\n")));
  console.log("too big:", JSON.stringify(await exchange(port, "GET / HTTP/1.1\r\nHost: x\r\nX-Big: " + "a".repeat(20000) + "\r\n\r\n")));
  const twice = "GET / HTTP/1.1\r\nHost: x\r\nUser-Agent: a\r\nUser-Agent: b\r\nConnection: close\r\n\r\n";
  console.log("first kept:", JSON.stringify(await exchange(port, twice)));
  await closed(server);
  const joining = http.createServer({ joinDuplicateHeaders: true }, (req, res) => res.end(JSON.stringify(req.headers["user-agent"])));
  const joinPort = await listen(joining);
  console.log("joined:", JSON.stringify(await exchange(joinPort, twice)));
  await closed(joining);
  const small = http.createServer({ maxHeaderSize: 100 }, (req, res) => res.end("ok"));
  const smallPort = await listen(small);
  console.log("over maxHeaderSize:", JSON.stringify(await exchange(smallPort, "GET / HTTP/1.1\r\nHost: x\r\nX-Pad: " + "p".repeat(120) + "\r\n\r\n")));
  await closed(small);
}

async function validation() {
  const server = http.createServer((req, res) => {
    const results = [
      caught(() => res.setHeader("Bad Name", "x")),
      caught(() => res.setHeader("X-Ok", "line\nbreak")),
      caught(() => res.setHeader("X-Ok", undefined)),
      caught(() => res.addTrailers({ "X-T": "bad\r\n" })),
      caught(() => res.getHeader(1)),
    ];
    res.setHeader("X-Ok", "fine");
    res.end("ok");
    results.push(caught(() => res.setHeader("X-Late", "1")), caught(() => res.removeHeader("X-Ok")), caught(() => res.appendHeader("X-Late", "1")));
    console.log(results.join("\n"));
    console.log("raw names:", JSON.stringify(res.getRawHeaderNames()));
  });
  const port = await listen(server);
  await exchange(port, "GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  await closed(server);
  console.log(caught(() => http.validateHeaderName("a b")));
  console.log(caught(() => http.validateHeaderValue("x", "\u0000")));
  console.log(caught(() => http.validateHeaderName("ok")), caught(() => http.validateHeaderValue("x", "ok")));
  console.log(http.maxHeaderSize, typeof http.OutgoingMessage, new http.ServerResponse(new http.IncomingMessage(null)) instanceof http.OutgoingMessage);
  console.log(caught(() => http.setMaxIdleHTTPParsers(0)), caught(() => http.setMaxIdleHTTPParsers(1)));
}

await trailers();
await timeouts();
await heads();
await validation();
