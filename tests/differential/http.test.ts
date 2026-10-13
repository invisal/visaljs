// HTTP differential tests: the app servers (tests/apps), unmodified, run under Node and
// compiled by visaljs, answer the same requests with the same bytes. Each request list goes
// over one connection (keep-alive), so connection handling is compared too.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { main } from "visaljs";

import { ensureInstalled } from "../apps/install.ts";
import { abandon, exchange, type Server, start, stop } from "./http.ts";

const APPS = join(import.meta.dirname, "..", "apps");
const OUT = mkdtempSync(join(tmpdir(), "visaljs-http-"));

const get = (path: string, extra = "") => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n${extra}\r\n`;
const post = (path: string, type: string, body: string) =>
  `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

interface Case {
  name: string;
  requests: string[];
}

/* `abandoned`: the request the hang-up test pipelines 4000 of (default `GET /`). The server answers
 * every one, as Node does, even after the client hangs up: it must be cheap. */
const SERVERS: { name: string; entry: string; cases: Case[]; abandoned?: string }[] = [
  {
    name: "http-hello",
    entry: join(APPS, "http-hello", "server.js"),
    cases: [
      { name: "GET, twice on one connection", requests: [get("/"), get("/anything?x=1")] },
      { name: "HEAD", requests: [`HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n`] },
      { name: "Connection: close", requests: [get("/", "Connection: close\r\n")] },
      { name: "HTTP/1.0", requests: [`GET / HTTP/1.0\r\n\r\n`] },
      { name: "a POST body is read and ignored", requests: [post("/", "text/plain", "ignored body"), get("/")] },
    ],
  },
  {
    name: "hono",
    entry: join(APPS, "hono", "server.js"),
    cases: [
      { name: "text, JSON, params and query", requests: [get("/"), get("/json"), get("/users/42?q=search%20me")] },
      { name: "JSON body", requests: [post("/echo", "application/json", '{"a":[1,2,{"b":"ü"}]}')] },
      {
        name: "chunked request body",
        requests: [`POST /text HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n`],
      },
      { name: "HTML, status and headers", requests: [get("/html"), get("/status")] },
      { name: "redirect", requests: [get("/redirect"), `HEAD /redirect HTTP/1.1\r\nHost: localhost\r\n\r\n`] },
      { name: "Set-Cookie twice", requests: [get("/cookie")] },
      { name: "streamed response", requests: [get("/stream")] },
      { name: "hono/streaming: stream() and streamSSE()", requests: [get("/helper-stream"), get("/sse")] },
      { name: "errors and not found", requests: [get("/error"), get("/missing")] },
      { name: "HEAD", requests: [`HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n`] },
      { name: "Connection: close", requests: [get("/json", "Connection: close\r\n")] },
      { name: "no Host header", requests: [`GET / HTTP/1.0\r\n\r\n`] },
    ],
  },
  {
    name: "express",
    entry: join(APPS, "express", "server.js"),
    cases: [
      { name: "text, JSON, params and query", requests: [get("/"), get("/json"), get("/users/42?q=search%20me&tag=a&tag=b")] },
      {
        name: "JSON and urlencoded bodies",
        requests: [
          post("/echo", "application/json", '{"a":[1,2,{"b":"ü"}]}'),
          post("/form", "application/x-www-form-urlencoded", "a=1&b=two&c%5Bd%5D=3"),
        ],
      },
      { name: "malformed JSON body", requests: [post("/echo", "application/json", '{"a":')] },
      { name: "HTML, status and headers", requests: [get("/html"), get("/status"), get("/no-content")] },
      { name: "redirect", requests: [get("/redirect"), `HEAD /redirect HTTP/1.1\r\nHost: localhost\r\n\r\n`] },
      { name: "cookies and attachments", requests: [get("/cookie"), get("/download")] },
      {
        name: "content negotiation",
        requests: [get("/negotiate", "Accept: application/json\r\n"), get("/negotiate", "Accept: text/plain\r\n"), get("/negotiate", "Accept: image/png\r\n")],
      },
      { name: "a mounted router", requests: [get("/api/items"), get("/api/items/7"), get("/api/items/x")] },
      { name: "errors and not found", requests: [get("/error"), get("/async-error"), get("/missing")] },
      { name: "HEAD", requests: [`HEAD /json HTTP/1.1\r\nHost: localhost\r\n\r\n`] },
      { name: "Connection: close", requests: [get("/json", "Connection: close\r\n")] },
    ],
  },
  {
    name: "react-ssr",
    entry: join(APPS, "react-ssr", "server.js"),
    cases: [
      { name: "a streamed page, twice on one connection", requests: [get("/"), get("/?n=7")] },
      { name: "an empty list, and not found", requests: [get("/?n=0"), get("/missing")] },
      { name: "HEAD", requests: [`HEAD / HTTP/1.1\r\nHost: localhost\r\n\r\n`] },
    ],
    abandoned: get("/?n=1"),  /* a page of one product: 4000 pages of 200 take Node itself seconds */
  },
];

let nextPort = 39000 + (process.pid % 1000) * 2;

for (const server of SERVERS) {
  describe(`HTTP: ${server.name} (Node vs visaljs)`, () => {
    let node: Server;
    let compiled: Server;

    beforeAll(async () => {
      ensureInstalled(server.name);
      const binary = join(OUT, server.name);
      let stderr = "";
      const code = await main(["build", server.entry, "-o", binary], { stdout: () => {}, stderr: (t) => (stderr += t) });
      if (code !== 0) throw new Error(`build failed:\n${stderr}`);
      const cwd = dirname(server.entry);
      [node, compiled] = await Promise.all([
        start(process.execPath, [server.entry], nextPort++, cwd),
        start(binary, [], nextPort++, cwd),
      ]);
    }, 600000);

    afterAll(async () => {
      await Promise.all([node && stop(node), compiled && stop(compiled)]);
    });

    for (const c of server.cases) {
      it(c.name, async () => {
        const [expected, actual] = await Promise.all([exchange(node.port, c.requests), exchange(compiled.port, c.requests)]);
        expect(actual).toEqual(expected);
      }, 30000);
    }

    it("a client that hangs up mid-response doesn't end the server (SIGPIPE is ignored)", async () => {
      for (let i = 0; i < 20; i++) await abandon(compiled.port, server.abandoned ?? get("/"), 200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(compiled.process.exitCode).toBe(null);
      const [expected, actual] = await Promise.all([exchange(node.port, [get("/")]), exchange(compiled.port, [get("/")])]);
      expect(actual).toEqual(expected);
    }, 30000);
  });
}
