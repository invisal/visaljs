// node:net, the rest: socket timeouts, unref, Unix domain sockets, local addresses, resets,
// maxConnections, a server's blockList, onread, abort signals, BlockList and SocketAddress
import net from "node:net";
import os from "node:os";
import path from "node:path";
import util from "node:util";

const listen = (server, ...args) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(...args, () => resolve(server.address()));
});
const closed = (server) => new Promise((resolve) => server.close(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const caught = (fn) => {
  try {
    fn();
    return "no error";
  } catch (e) {
    return e.name + " " + e.code + ": " + e.message;
  }
};

// setTimeout: 'timeout' after the idle time, pushed back by activity, and off with 0
async function timeouts() {
  const server = net.createServer((socket) => socket.on("data", () => {}));
  const { port } = await listen(server, 0, "127.0.0.1");
  const log = [];
  await new Promise((resolve) => {
    const client = net.connect(port, "127.0.0.1");
    const start = Date.now();
    let writes = 0;
    client.setTimeout(40, () => {
      const elapsed = Date.now() - start;
      log.push("timeout after " + writes + " writes, late enough: " + (elapsed >= 100) + ", timeout " + client.timeout);
      client.setTimeout(0);
      client.destroy();
    });
    client.on("connect", () => {
      const iv = setInterval(() => {
        client.write("x");
        if (++writes === 5) clearInterval(iv);
      }, 20);
    });
    client.on("close", resolve);
  });
  await closed(server);
  console.log(log.join(" | "));
  console.log(caught(() => new net.Socket().setTimeout(-1)));
  console.log(caught(() => new net.Socket().setTimeout("1")));
}

// unref: an unref'd socket still reads while a timer keeps the program running; an unref'd
// server alone doesn't keep it running (checked last)
async function unref() {
  const server = net.createServer((socket) => setTimeout(() => socket.end("late data"), 10));
  const { port } = await listen(server, 0, "127.0.0.1");
  let got = "";
  const client = net.connect(port, "127.0.0.1");
  client.unref();
  client.on("data", (d) => (got += d));
  await sleep(150);
  console.log("unref'd socket read:", JSON.stringify(got));
  client.destroy();
  await closed(server);
}

// Unix domain sockets: listen and connect on a path; errors name the path
async function pipes() {
  const file = path.join(os.tmpdir(), "visaljs-net-" + process.pid + "-" + Math.floor(Math.random() * 1e9) + ".sock");
  const shown = (s) => String(s).split(file).join("<path>");
  const server = net.createServer((socket) => {
    console.log("pipe connection:", socket.remoteAddress, JSON.stringify(socket.address()));
    socket.on("data", (d) => socket.end(String(d).toUpperCase()));
  });
  const address = await listen(server, file);
  console.log("pipe address:", shown(address), server.listening);
  const second = net.createServer();
  await listen(second, file).catch((e) => console.log("pipe listen:", e.code, e.syscall, shown(e.address), e.port, shown(e.message)));
  await new Promise((resolve) => {
    const client = net.connect(file, () => client.write("over a pipe"));
    let text = "";
    client.on("data", (d) => (text += d));
    client.on("close", () => {
      console.log("pipe client:", text, client.remoteAddress, client.readyState);
      resolve();
    });
  });
  await closed(server);
  await new Promise((resolve) => {
    const client = net.connect({ path: file });
    client.on("error", (e) => console.log("pipe connect:", e.code, e.syscall, shown(e.address), shown(e.message)));
    client.on("close", resolve);
  });
}

// localAddress, and a client's reset: the server reads ECONNRESET
async function localAndReset() {
  const events = [];
  let serverDone;
  const serverClosed = new Promise((resolve) => (serverDone = resolve));
  const server = net.createServer((socket) => {
    events.push("server: from " + socket.remoteAddress);
    socket.on("error", (e) => events.push("server: error " + e.code + " " + e.syscall));
    socket.on("close", (hadError) => {
      events.push("server: close " + hadError);
      serverDone();
    });
  });
  const { port } = await listen(server, 0, "127.0.0.1");
  await new Promise((resolve) => {
    const client = net.connect({ port, host: "127.0.0.1", localAddress: "127.0.0.1" }, () => {
      events.push("client: from " + client.localAddress);
      setTimeout(() => client.resetAndDestroy(), 10);
    });
    client.on("close", (hadError) => {
      events.push("client: close " + hadError);
      resolve();
    });
  });
  await serverClosed;
  await closed(server);
  console.log(events.join(" | "));
  console.log(caught(() => net.connect({ port, localAddress: "nope" })));
  await new Promise((resolve) => {
    const unconnected = new net.Socket();
    unconnected.on("error", (e) => console.log("reset unconnected:", e.code));
    unconnected.on("close", resolve);
    unconnected.resetAndDestroy();
  });
}

// maxConnections: the next connection is dropped with its addresses; a blockList closes it
async function limits() {
  const server = net.createServer((socket) => socket.on("data", () => {}));
  server.maxConnections = 1;
  server.on("drop", (data) => console.log("drop:", data.localAddress, data.remoteAddress, data.localFamily, typeof data.remotePort));
  const { port } = await listen(server, 0, "127.0.0.1");
  const first = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => first.on("connect", resolve));
  await new Promise((resolve) => {
    const second = net.connect(port, "127.0.0.1");
    second.on("error", () => {});
    second.on("close", resolve);
  });
  first.destroy();
  await closed(server);

  const blockList = new net.BlockList();
  blockList.addAddress("127.0.0.1");
  const guarded = net.createServer({ blockList }, () => console.log("never"));
  const address = await listen(guarded, 0, "127.0.0.1");
  await new Promise((resolve) => {
    const client = net.connect(address.port, "127.0.0.1");
    client.on("error", () => {});
    client.on("close", () => {
      console.log("blocked: closed");
      resolve();
    });
  });
  await closed(guarded);
  console.log(caught(() => net.createServer({ blockList: [] })));
}

// onread: bytes go to the given buffer, a buffer's worth at a time, not to 'data'
async function onread() {
  const server = net.createServer((socket) => socket.end("hello world"));
  const { port } = await listen(server, 0, "127.0.0.1");
  const parts = [];
  await new Promise((resolve) => {
    const client = net.connect({
      port, host: "127.0.0.1",
      onread: { buffer: Buffer.alloc(4), callback: (n, buf) => void parts.push(buf.toString("latin1", 0, n)) },
    });
    client.on("data", () => parts.push("data?"));
    client.on("close", resolve);
  });
  await closed(server);
  console.log("onread:", parts.join("|"));
}

// an abort signal closes the server
async function abort() {
  const controller = new AbortController();
  const server = net.createServer();
  await listen(server, { port: 0, host: "127.0.0.1", signal: controller.signal });
  const done = new Promise((resolve) => server.on("close", resolve));
  controller.abort();
  await done;
  console.log("aborted: listening", server.listening);
  console.log(caught(() => server.listen({ host: "127.0.0.1" })));
}

function blockLists() {
  const list = new net.BlockList();
  list.addAddress("10.0.0.1");
  list.addRange("192.168.1.10", "192.168.1.20");
  list.addSubnet("8.8.0.0", 16);
  list.addSubnet("2001:db8::", 32, "ipv6");
  list.addAddress(new net.SocketAddress({ address: "::1", family: "ipv6" }));
  console.log(list.rules);
  console.log(util.inspect(list));
  for (const [address, family] of [["10.0.0.1"], ["10.0.0.2"], ["192.168.1.15"], ["192.168.1.21"], ["8.8.4.4"], ["8.9.0.0"],
    ["2001:db8:1::5", "ipv6"], ["2001:db9::", "ipv6"], ["::1", "ipv6"], ["::ffff:10.0.0.1", "ipv6"], ["not an address"]]) {
    console.log("check", address, list.check(address, family));
  }
  console.log(caught(() => list.addRange("10.0.0.9", "10.0.0.1")));
  console.log(caught(() => list.addSubnet("10.0.0.0", 33)));
  console.log(caught(() => list.addAddress(42)));
  console.log(net.BlockList.isBlockList(list), net.BlockList.isBlockList({}), JSON.stringify(list));
}

function socketAddresses() {
  const a = new net.SocketAddress();
  console.log(a.address, a.port, a.family, a.flowlabel, util.inspect(a));
  const b = new net.SocketAddress({ address: "2001:DB8:0:0:0:0:0:1", port: 443, family: "IPv6", flowlabel: 7 });
  console.log(JSON.stringify(b), String(new net.SocketAddress({ family: "ipv6" }).address));
  for (const text of ["::ffff:1.2.3.4", "1:0:0:2:0:0:0:3", "0:0:0:0:0:0:0:0", "fe80::1%eth0"]) {
    console.log(text, "->", new net.SocketAddress({ address: text, family: "ipv6" }).address);
  }
  console.log(JSON.stringify(net.SocketAddress.parse("1.2.3.4:80")), JSON.stringify(net.SocketAddress.parse("[::1]:8080")),
    net.SocketAddress.parse("not:an:address:at:all"));
  console.log(caught(() => new net.SocketAddress({ address: "1.2.3" })));
  console.log(caught(() => new net.SocketAddress({ family: "ipv5" })));
  console.log(caught(() => new net.SocketAddress({ port: 70000 })));
  console.log(net.SocketAddress.isSocketAddress(a), net.SocketAddress.isSocketAddress({}));
}

function defaults() {
  console.log(caught(() => net.setDefaultAutoSelectFamily("yes")));
  console.log(caught(() => net.setDefaultAutoSelectFamilyAttemptTimeout(0)));
  net.setDefaultAutoSelectFamilyAttemptTimeout(5);
  console.log("attempt timeout:", net.getDefaultAutoSelectFamilyAttemptTimeout());
  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
}

await timeouts();
await unref();
await pipes();
await localAndReset();
await limits();
await onread();
await abort();
blockLists();
socketAddresses();
defaults();

// last: an unref'd listening server doesn't keep the program running
const idle = net.createServer();
idle.listen(0, "127.0.0.1", () => {
  idle.unref();
  console.log("unref'd server: the program ends");
});
