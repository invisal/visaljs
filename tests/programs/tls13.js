// node:tls with TLS 1.3, each side's default: the handshake, session tickets (which
// come after it) and resumption, verification when the client finishes first, a required client
// certificate (TLS 1.3's alert), half-close, and the upgrade of a connected socket. The suite
// isn't shown: BoringSSL prefers AES-128-GCM where OpenSSL prefers AES-256-GCM.
import { readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";

const file = (name) => readFileSync(join(import.meta.dirname, "data", "tls", name));
const ca = file("ca.pem");
const serverOptions = { key: file("server.key"), cert: file("server.pem") };

function serve(options, onSocket) {
  const events = [];
  const server = tls.createServer({ ...serverOptions, ...options }, (socket) => {
    events.push(`secureConnection ${socket.getProtocol()} authorized=${socket.authorized} error=${socket.authorizationError}`);
    onSocket(socket, events);
  });
  server.on("tlsClientError", (err) => events.push(`tlsClientError ${err.code}`));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, events })));
}

function client(port, options) {
  return new Promise((resolve) => {
    const events = [];
    const socket = tls.connect({ port, host: "localhost", servername: "localhost", ca, ...options }, () => {
      events.push(`secureConnect ${socket.getProtocol()} ${socket.getCipher().version} authorized=${socket.authorized}`);
    });
    let data = "";
    socket.on("data", (d) => (data += d));
    socket.on("end", () => events.push(`end ${JSON.stringify(data)}`));
    socket.on("error", (e) => events.push(`error ${e.code}`));
    socket.on("close", () => resolve({ events, socket }));
  });
}

async function scenario(name, sOptions, cOptions, onSocket = (s) => s.end("hi")) {
  const { server, port, events } = await serve(sOptions, onSocket);
  const c = await client(port, cOptions);
  await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => server.close(r));
  console.log(`-- ${name}`);
  for (const e of c.events) console.log("  client:", e);
  for (const e of events) console.log("  server:", e);
}

await scenario("handshake", {}, {});
await scenario("self-signed: the client finishes first, then rejects", { key: file("self.key"), cert: file("self.pem") }, {});
await scenario("not rejected", { key: file("self.key"), cert: file("self.pem") }, { rejectUnauthorized: false });
await scenario("a required client certificate, missing", { requestCert: true, ca }, {});
await scenario("a client certificate", { requestCert: true, ca }, { key: file("client.key"), cert: file("client.pem") },
  (s, events) => {
    events.push(`peer ${s.getPeerCertificate().subject.CN}`);
    s.end("ok");
  });
await scenario("an Ed25519 certificate", { key: file("server-ed25519.key"), cert: file("server-ed25519.pem") }, {}, (s, events) => {
  events.push(`own certificate ${s.getCertificate().subject.CN}`);
  s.end("hi");
});
await scenario("TLS 1.2 at most, from the client", {}, { maxVersion: "TLSv1.2" });
await scenario("TLS 1.3 only, against TLS 1.2", { maxVersion: "TLSv1.2" }, { minVersion: "TLSv1.3" });

/* tickets: 'session' after the handshake, and a resumed connection that still knows its peer */
{
  const { server, port } = await serve({}, (s) => s.end(String(s.isSessionReused())));
  const run = (session) => new Promise((resolve) => {
    const sessions = [];
    const socket = tls.connect({ port, host: "localhost", servername: "localhost", ca, session });
    socket.on("session", (s) => sessions.push(s));
    let data = "";
    socket.on("data", (d) => (data += d));
    socket.on("secureConnect", () => {
      const peer = socket.getPeerCertificate();
      resolve.peer = `${socket.isSessionReused()} ${socket.authorized} ${peer.subject?.CN}`;
    });
    socket.on("close", () => resolve({ sessions, data, peer: resolve.peer }));
  });
  const first = await run();
  const second = await run(first.sessions.at(-1));
  await new Promise((r) => server.close(r));
  console.log("-- tickets", first.sessions.length > 0, first.sessions.every(Buffer.isBuffer), first.data, first.peer);
  console.log("   resumed", second.data, second.peer);
}

/* half-close: the client ends, the server still answers */
{
  const { server, port } = await serve({}, (s) => {
    let got = "";
    s.on("data", (d) => (got += d));
    s.on("end", () => s.end(`server got ${got.length} bytes`));
  });
  const socket = tls.connect({ port, host: "localhost", servername: "localhost", ca });
  socket.end("x".repeat(100000));
  let data = "";
  socket.on("data", (d) => (data += d));
  await new Promise((r) => socket.on("close", r));
  await new Promise((r) => server.close(r));
  console.log("-- half-close:", data);
}

/* TLS over a connected socket, the server's side too */
{
  const server = net.createServer((raw) => {
    raw.once("data", () => {
      raw.write("S");
      const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: tls.createSecureContext(serverOptions) });
      secure.on("data", (d) => secure.end("got " + d));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const raw = net.connect(server.address().port, "127.0.0.1");
  await new Promise((r) => raw.once("connect", r));
  raw.write("?");
  await new Promise((r) => raw.once("data", r));
  const secure = tls.connect({ socket: raw, servername: "localhost", ca });
  secure.write("early");
  let data = "";
  secure.on("data", (d) => (data += d));
  secure.on("secureConnect", () => console.log("-- upgrade", secure.getProtocol(), secure.authorized));
  await new Promise((r) => secure.on("close", r));
  await new Promise((r) => server.close(r));
  console.log("   data", JSON.stringify(data));
}
console.log(tls.DEFAULT_MAX_VERSION, ["tls_aes_128_gcm_sha256", "tls_aes_256_gcm_sha384", "tls_chacha20_poly1305_sha256"].every((c) => tls.getCiphers().includes(c)));
