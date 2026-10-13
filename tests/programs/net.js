// node:net: TCP servers and sockets in one process (each side logs its own events), and dns.lookup
import dns from "node:dns";
import net from "node:net";

const listen = (server, ...args) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(...args, () => resolve(server.address()));
});
const closed = (server) => new Promise((resolve) => server.close(resolve));
const portless = (s) => s.replace(/:\d+$/, ":<port>");

// an echo server: data comes back upper-cased; the client ends, the server ends after it
async function echo() {
  const serverLog = [];
  const server = net.createServer((socket) => {
    serverLog.push("connection " + socket.remoteAddress + " " + socket.remoteFamily + " " + (socket.localPort === server.address().port));
    socket.setEncoding("utf8");
    socket.on("data", (d) => {
      serverLog.push("data " + JSON.stringify(d));
      socket.write(d.toUpperCase());
    });
    socket.on("end", () => serverLog.push("end"));
    socket.on("finish", () => serverLog.push("finish"));
    socket.on("close", (hadError) => serverLog.push("close " + hadError + " read " + socket.bytesRead + " written " + socket.bytesWritten));
  });
  const address = await listen(server, 0, "127.0.0.1");
  console.log("listening", address.address, address.family, typeof address.port, server.listening);
  const clientLog = [];
  await new Promise((resolve) => {
    const client = net.connect(address.port, "127.0.0.1");
    clientLog.push("readyState " + client.readyState + " pending " + client.pending);
    client.on("connect", () => {
      clientLog.push("connect " + (client.remotePort === address.port) + " " + client.readyState);
      client.write("hello, ");
      client.write(Buffer.from("world"));
    });
    client.on("ready", () => clientLog.push("ready"));
    let received = "";
    client.on("data", (d) => {
      received += d;
      if (received === "HELLO, WORLD") {
        clientLog.push("data " + received);
        client.end();
        clientLog.push("readyState after end() " + client.readyState);
      }
    });
    client.on("end", () => clientLog.push("end"));
    client.on("close", (hadError) => {
      clientLog.push("close " + hadError + " " + client.readyState + " destroyed " + client.destroyed);
      resolve();
    });
  });
  await closed(server);
  console.log("client:", clientLog.join(" | "));
  console.log("server:", serverLog.join(" | "));
}

// a megabyte each way: backpressure on both sides ('drain'), counted with bytesRead/bytesWritten
async function bulk() {
  const size = 1 << 20;
  const server = net.createServer({ pauseOnConnect: false }, (socket) => {
    let n = 0;
    socket.on("data", (d) => (n += d.length));
    socket.on("end", () => {
      const reply = Buffer.alloc(size, 7);
      socket.end(reply);
      console.log("server got", n, "bytes; bytesRead", socket.bytesRead);
    });
  });
  const { port } = await listen(server, 0, "127.0.0.1");
  await new Promise((resolve) => {
    const client = net.connect({ port, host: "127.0.0.1" }, () => {
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024, 1);
      const pump = () => {
        while (sent < size) {
          sent += chunk.length;
          if (!client.write(chunk)) {
            client.once("drain", pump);
            return;
          }
        }
        client.end();
        console.log("client wrote", client.bytesWritten, "bytes");
      };
      pump();
    });
    client.pause();  /* nothing is read for a while: the server's writes back up, then resume */
    setTimeout(() => client.resume(), 20);
    let got = 0;
    let sevens = true;
    client.on("data", (d) => {
      got += d.length;
      for (const b of d) if (b !== 7) sevens = false;
    });
    client.on("close", () => {
      console.log("client got", got, "bytes, all sevens:", sevens, "bytesRead", client.bytesRead);
      resolve();
    });
  });
  await closed(server);
}

// allowHalfOpen: the server still writes after the client's end, then ends itself
async function halfOpen() {
  const log = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", () => {});
    socket.on("end", () => {
      log.push("server: end, writable " + socket.writable);
      setTimeout(() => socket.end("late reply"), 5);
    });
  });
  const { port } = await listen(server, 0, "127.0.0.1");
  await new Promise((resolve) => {
    const client = net.connect(port, "127.0.0.1", () => client.end("bye"));
    client.setEncoding("utf8");
    client.on("finish", () => log.push("client: finish"));
    client.on("data", (d) => log.push("client: data " + d));
    client.on("end", () => log.push("client: end"));
    client.on("close", () => resolve());
  });
  await closed(server);
  console.log(log.join(" | "));
}

// errors: a refused connection, a port in use, closing a server that isn't running
async function errors() {
  const server = net.createServer();
  const { port } = await listen(server, 0, "127.0.0.1");
  const second = net.createServer();
  try {
    await listen(second, port, "127.0.0.1");
  } catch (e) {
    console.log("listen:", e.code, e.syscall, e.address, e.port === port, portless(e.message));
  }
  await closed(server);
  await new Promise((resolve) => {
    const client = net.connect(port, "127.0.0.1");
    const events = [];
    client.on("connect", () => events.push("connect"));
    client.on("error", (e) => {
      events.push("error");
      console.log("connect:", e.code, e.syscall, e.address, e.port === port, e.errno < 0, portless(e.message));
    });
    client.on("close", (hadError) => {
      events.push("close " + hadError);
      console.log("events:", events.join(", "), "destroyed", client.destroyed);
      resolve();
    });
  });
  await new Promise((resolve) => server.close((e) => {
    console.log("close again:", e.code, e.message);
    resolve();
  }));
  try {
    net.connect({ port: 70000 });
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}

// a host name: looked up, then connected (whichever address family answers)
async function byName() {
  const server = net.createServer((socket) => socket.end("hi from " + (socket.remoteFamily === "IPv6" ? "an IPv6" : "an IPv4") + " peer"));
  const { port } = await listen(server, 0);
  await new Promise((resolve) => {
    const client = net.createConnection({ port, host: "localhost" });
    let lookups = 0;
    client.on("lookup", (err, address, family, host) => {
      if (!err && net.isIP(address) === family && host === "localhost") lookups++;
    });
    let text = "";
    client.on("data", (d) => (text += d));
    client.on("close", () => {
      console.log("by name:", lookups > 0, /^hi from an IPv[46] peer$/.test(text));
      resolve();
    });
  });
  await closed(server);
}

async function lookups() {
  const one = await new Promise((resolve) => dns.lookup("127.0.0.1", (err, address, family) => resolve([err, address, family])));
  console.log("lookup ip:", one);
  const all = await dns.promises.lookup("localhost", { all: true });
  console.log("lookup localhost:", all.length > 0, all.every((a) => net.isIP(a.address) === a.family));
  const v4 = await dns.promises.lookup("localhost", { family: 4 });
  console.log("lookup localhost v4:", v4);
}

await echo();
await bulk();
await halfOpen();
await errors();
await byName();
await lookups();
console.log("defaults:", net.getDefaultAutoSelectFamily(), typeof net.Socket, new net.Socket().readyState);
