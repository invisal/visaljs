// node:tls: servers and clients in one program, pinned to TLS 1.2 (BearSSL has no
// TLS 1.3, so Node is asked for 1.2 too): handshakes with RSA and EC certificates, what each side
// sees (protocol, cipher, certificates, ALPN, SNI), verification failures, client certificates,
// session resumption, TLS over an existing socket (as pg upgrades its connection), protocol
// errors, and data both ways.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";

const file = (name) => readFileSync(join(import.meta.dirname, "data", "tls", name));
const ca = file("ca.pem"), caEc = file("ca-ec.pem");
const serverKey = file("server.key"), serverCert = file("server.pem");
const v12 = { maxVersion: "TLSv1.2" };

/* a server for one scenario; resolves with what it saw */
function serve(options, onSocket) {
  const events = [];
  const server = tls.createServer({ key: serverKey, cert: serverCert, ...v12, ...options }, (socket) => {
    events.push(`secureConnection authorized=${socket.authorized} error=${socket.authorizationError} servername=${socket.servername} alpn=${socket.alpnProtocol}`);
    if (onSocket) onSocket(socket, events);
    else socket.end("hello from server");
  });
  server.on("tlsClientError", (err) => events.push(`tlsClientError ${err.code}`));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, events })));
}

/* connects, collects what the client sees until the socket closes */
function client(port, options) {
  return new Promise((resolve) => {
    const events = [];
    const socket = tls.connect({ port, host: "localhost", servername: "localhost", ca, ...options }, () => {
      events.push(`secureConnect authorized=${socket.authorized} error=${socket.authorizationError} alpn=${socket.alpnProtocol}`);
    });
    let data = "";
    socket.on("data", (d) => (data += d));
    socket.on("end", () => events.push(`end ${JSON.stringify(data)}`));
    socket.on("error", (e) => events.push(`error ${e.code}${e.reason ? " (" + e.reason + ")" : ""}`));
    socket.on("close", () => resolve({ events, socket }));
  });
}

async function scenario(name, serverOptions, clientOptions, onSocket) {
  const { server, port, events } = await serve(serverOptions, onSocket);
  const c = await client(port, clientOptions);
  /* the server's side of the connection ends after the client's: let it, for its events */
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => server.close(r));
  console.log(`-- ${name}`);
  for (const e of c.events) console.log("  client:", e);
  for (const e of events) console.log("  server:", e);
  return c;
}

/* ---- the basics ---- */
{
  let serverSide;
  const { server, port } = await serve({}, (socket) => {
    serverSide = {
      protocol: socket.getProtocol(),
      cipher: socket.getCipher(),
      cert: socket.getCertificate().subject.CN,
      peer: socket.getPeerCertificate(),
      ekm: socket.exportKeyingMaterial(32, "label").toString("hex"),
      finished: [socket.getFinished()?.length, socket.getPeerFinished()?.length],
      ephemeral: socket.getEphemeralKeyInfo(),
    };
    socket.on("data", (d) => socket.end("echo:" + d));
  });
  const socket = tls.connect({ port, host: "localhost", servername: "localhost", ca });
  await new Promise((r) => socket.once("secureConnect", r));
  console.log("-- basics");
  console.log("encrypted", socket.encrypted, "authorized", socket.authorized, "servername", socket.servername);
  console.log("protocol", socket.getProtocol(), "cipher", socket.getCipher());
  console.log("ephemeral", socket.getEphemeralKeyInfo(), "reused", socket.isSessionReused());
  const peer = socket.getPeerCertificate(true);
  console.log("peer", peer.subject, peer.issuer.CN, peer.subjectaltname);
  console.log("peer", peer.valid_from, peer.valid_to, peer.serialNumber, peer.bits, peer.exponent, peer.raw.length, peer.ext_key_usage);
  console.log("peer infoAccess", peer.infoAccess);
  console.log("fingerprint256", peer.fingerprint256 === createHash("sha256").update(peer.raw).digest("hex").toUpperCase().replace(/(..)(?!$)/g, "$1:"));
  console.log("chain", peer.issuerCertificate.subject.CN, peer.issuerCertificate.issuerCertificate === peer.issuerCertificate, peer.issuerCertificate.ca);
  console.log("getCertificate (client has none)", JSON.stringify(socket.getCertificate()));
  console.log("finished", socket.getFinished().length, socket.getPeerFinished().length);
  const ekm = socket.exportKeyingMaterial(32, "label").toString("hex");
  socket.write("ping");
  let data = "";
  socket.on("data", (d) => (data += d));
  await new Promise((r) => socket.on("close", r));
  await new Promise((r) => server.close(r));
  console.log("data", data);
  console.log("server", serverSide.protocol, serverSide.cipher.name, serverSide.cert, JSON.stringify(serverSide.peer), serverSide.ephemeral);
  console.log("keying material agrees", ekm === serverSide.ekm, ekm.length);
  console.log("finished messages cross", serverSide.finished);
}

/* ---- certificates ---- */
await scenario("EC certificate", { key: file("server-ec.key"), cert: file("server-ec.pem") }, { ca: caEc });
await scenario("EC certificate, RSA CA only", { key: file("server-ec.key"), cert: file("server-ec.pem") }, {});
await scenario("default CAs (the bundled roots)", {}, { ca: undefined });
await scenario("self-signed", { key: file("self.key"), cert: file("self.pem") }, {});
await scenario("self-signed, trusted", { key: file("self.key"), cert: file("self.pem") }, { ca: file("self.pem") });
await scenario("expired", { key: file("expired.key"), cert: file("expired.pem") }, {});
await scenario("wrong host", { key: file("other.key"), cert: file("other.pem") }, {});
await scenario("wrong host, not rejected", { key: file("other.key"), cert: file("other.pem") }, { rejectUnauthorized: false });
await scenario("an IP address", {}, { host: "127.0.0.1", servername: undefined });
await scenario("an IP address not in the certificate", { key: file("other.key"), cert: file("other.pem") }, { host: "127.0.0.1", servername: undefined });
await scenario("a wildcard name", {}, { servername: "api.example.test" });
await scenario("a custom checkServerIdentity", { key: file("other.key"), cert: file("other.pem") },
  { checkServerIdentity: (host, cert) => (cert.subject.CN === "other.test" ? undefined : new Error("no")) });

/* ---- ALPN and SNI ---- */
await scenario("ALPN", { ALPNProtocols: ["h2", "http/1.1"] }, { ALPNProtocols: ["http/1.1", "h2"] });
await scenario("ALPN, the server has none", {}, { ALPNProtocols: ["h2"] });
await scenario("ALPN, no protocol in common", { ALPNProtocols: ["h2"] }, { ALPNProtocols: ["spdy/3"] });
await scenario("ALPNCallback", { ALPNCallback: ({ servername, protocols }) => (servername === "localhost" ? protocols.at(-1) : undefined) },
  { ALPNProtocols: ["a", "b", "c"] });
{
  const { server, port } = await serve({ SNICallback: undefined }, (socket) => socket.end(socket.servername));
  /* (Node keeps the server's RSA certificate when SNI picks a context with an EC one: OpenSSL's
   * context switch; these contexts are RSA) */
  server.addContext("*.other.test", { key: file("other.key"), cert: file("other.pem") });
  for (const servername of ["localhost", "one.other.test", "other.test"]) {
    const socket = tls.connect({ port, host: "localhost", servername, ca, checkServerIdentity: () => undefined });
    await new Promise((r) => socket.once("secureConnect", r));
    const cert = socket.getPeerCertificate();
    let data = "";
    socket.on("data", (d) => (data += d));
    await new Promise((r) => socket.on("close", r));
    console.log("-- SNI", servername, "→", cert.subject.CN, "server saw", data);
  }
  await new Promise((r) => server.close(r));
}
{
  const contexts = { "a.test": tls.createSecureContext({ key: file("other.key"), cert: file("other.pem") }) };
  const seen = [];
  const { server, port } = await serve({ SNICallback: (name, cb) => { seen.push(name); setTimeout(() => cb(null, contexts[name]), 5); } });
  for (const servername of ["a.test", "b.test"]) {
    const socket = tls.connect({ port, host: "localhost", servername, ca, checkServerIdentity: () => undefined });
    await new Promise((r) => socket.once("secureConnect", r));
    console.log("-- SNICallback", servername, socket.getPeerCertificate().subject.CN);
    socket.destroy();
  }
  console.log("   asked for", seen);
  await new Promise((r) => server.close(r));
}

/* ---- client certificates ---- */
const clientCert = { key: file("client.key"), cert: file("client.pem") };
await scenario("client certificate", { requestCert: true, ca }, clientCert, (socket, events) => {
  events.push(`peer ${socket.getPeerCertificate().subject.CN} ${socket.getPeerCertificate().ext_key_usage}`);
  socket.end("ok");
});
await scenario("client certificate missing, not rejected", { requestCert: true, rejectUnauthorized: false, ca }, {}, (socket, events) => {
  events.push(`peer ${JSON.stringify(socket.getPeerCertificate())}`);
  socket.end("ok");
});
await scenario("client certificate missing, rejected", { requestCert: true, ca }, {});
await scenario("client certificate from another CA", { requestCert: true, rejectUnauthorized: false, ca: caEc }, clientCert);

/* ---- session resumption ---- */
{
  const { server, port } = await serve({}, (socket) => socket.end(String(socket.isSessionReused())));
  const run = (session) => new Promise((resolve) => {
    let saved = null;
    const socket = tls.connect({ port, host: "localhost", servername: "localhost", ca, session });
    socket.on("session", (s) => (saved = s));
    let data = "";
    socket.on("data", (d) => (data += d));
    socket.on("close", () => resolve({ saved, reused: socket.isSessionReused(), data }));
  });
  const first = await run();
  const second = await run(first.saved);
  console.log("-- resumption", Buffer.isBuffer(first.saved), first.reused, first.data, second.reused, second.data);
  await new Promise((r) => server.close(r));
}

/* ---- TLS over a socket already connected (pg's SSLRequest, then the upgrade) ---- */
{
  const server = net.createServer((raw) => {
    raw.once("data", (d) => {
      console.log("-- upgrade: server read", JSON.stringify(String(d)));
      raw.write("S");
      const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: tls.createSecureContext({ key: serverKey, cert: serverCert, ...v12 }) });
      secure.on("secure", () => console.log("   server secure", secure.getProtocol()));
      secure.on("data", (d) => secure.end("got " + d));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const raw = net.connect(server.address().port, "127.0.0.1");
  await new Promise((r) => raw.once("connect", r));
  raw.write("SSLRequest");
  const answer = await new Promise((r) => raw.once("data", r));
  console.log("   client read", String(answer));
  const secure = tls.connect({ socket: raw, servername: "localhost", ca });
  secure.write("written before the handshake");
  let data = "";
  secure.on("data", (d) => (data += d));
  secure.on("secureConnect", () => console.log("   client secureConnect", secure.authorized, secure.remotePort === server.address().port));
  await new Promise((r) => secure.on("close", r));
  console.log("   client data", JSON.stringify(data), "raw closed", raw.destroyed);
  await new Promise((r) => server.close(r));
}

/* ---- failures ---- */
{
  /* a server that isn't TLS */
  const sockets = [];
  const server = net.createServer((s) => {
    sockets.push(s.on("error", () => {}));
    s.write("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = await client(server.address().port, {});
  console.log("-- not TLS:", c.events.join("; "));
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
}
{
  /* a server that hangs up */
  const server = net.createServer((s) => s.destroy());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const c = await client(server.address().port, {});
  console.log("-- hang up:", c.events.join("; "));
  await new Promise((r) => server.close(r));
}
{
  /* an HTTP client at a TLS server, and a client that hangs up */
  const { server, port, events } = await serve({});
  for (const payload of ["GET / HTTP/1.1\r\nHost: x\r\n\r\n", null]) {
    const s = net.connect(port, "127.0.0.1");
    await new Promise((r) => s.once("connect", r));
    if (payload) s.write(payload);
    else s.end();
    await new Promise((r) => s.on("close", r).resume());
  }
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => server.close(r));
  console.log("-- not a TLS client:", events.join("; "));
}
await scenario("no cipher in common", { ciphers: "ECDHE-ECDSA-AES128-GCM-SHA256" }, {});

/* ---- data ---- */
{
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  const { server, port } = await serve({}, (socket) => {
    const hash = createHash("sha256");
    let n = 0;
    socket.on("data", (d) => {
      hash.update(d);
      n += d.length;
    });
    socket.on("end", () => socket.end(`${n} ${hash.digest("hex").slice(0, 16)}`));
  });
  const socket = tls.connect({ port, host: "localhost", servername: "localhost", ca });
  socket.end(big);
  let data = "";
  socket.on("data", (d) => (data += d));
  await new Promise((r) => socket.on("close", r));
  await new Promise((r) => server.close(r));
  console.log("-- 3 MiB through TLS:", data, createHash("sha256").update(big).digest("hex").slice(0, 16));
}

/* ---- the module ---- */
console.log("-- module");
console.log(tls.getCiphers().includes("ecdhe-rsa-aes128-gcm-sha256"), tls.getCiphers().every((c) => c === c.toLowerCase()));
console.log(tls.rootCertificates.length > 100, Object.isFrozen(tls.rootCertificates), tls.rootCertificates[0].startsWith("-----BEGIN CERTIFICATE-----\n"));
console.log(tls.getCACertificates("bundled") === tls.rootCertificates, tls.getCACertificates().length === tls.rootCertificates.length);
console.log(tls.DEFAULT_ECDH_CURVE, tls.DEFAULT_MIN_VERSION, tls.CLIENT_RENEG_LIMIT, tls.CLIENT_RENEG_WINDOW);
const show = (f) => {
  try {
    const r = f();
    console.log(r === undefined ? "undefined" : r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};
show(() => tls.createSecureContext({ minVersion: "TLSv1.9" }));
show(() => tls.createSecureContext({ ciphers: "NOPE" }));
show(() => tls.createSecureContext({ key: file("other.key"), cert: serverCert }).constructor.name);
show(() => tls.createSecureContext({ ciphers: "ECDHE-RSA-AES128-GCM-SHA256" }) instanceof tls.SecureContext);
show(() => tls.connect({ port: 1, checkServerIdentity: 1 }));
const buf = {};
tls.convertALPNProtocols(["h2", "http/1.1"], buf);
console.log(buf.ALPNProtocols);
const id = (host, cert) => {
  const e = tls.checkServerIdentity(host, cert);
  return e ? `${e.code}: ${e.reason}` : "ok";
};
console.log(id("a.example.com", { subjectaltname: "DNS:*.example.com" }), id("example.com", { subjectaltname: "DNS:*.example.com" }));
console.log(id("a.b.example.com", { subjectaltname: "DNS:*.example.com" }), id("x.com", { subject: { CN: "x.com" } }));
console.log(id("::1", { subjectaltname: "IP Address:0:0:0:0:0:0:0:1" }), id("10.0.0.1", { subjectaltname: "IP Address:10.0.0.2" }));
console.log(id("x.com", { subject: {} }), id("WWW.Example.COM.", { subjectaltname: 'DNS:www.example.com, DNS:"a,b"' }));
