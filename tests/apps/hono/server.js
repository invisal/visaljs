import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { stream, streamSSE } from "hono/streaming";

const app = new Hono();

/* middleware: a response header on every route, and a timing-free logger */
app.use("*", async (c, next) => {
  await next();
  c.header("X-Powered-By", "visaljs");
});

app.get("/", (c) => c.text("Hello, Hono!"));
app.get("/json", (c) => c.json({ ok: true, message: "hi", list: [1, 2, 3] }));
app.get("/users/:id", (c) => c.json({ id: c.req.param("id"), q: c.req.query("q") ?? null }));
app.post("/echo", async (c) => c.json({ received: await c.req.json(), type: c.req.header("content-type") }));
app.post("/text", async (c) => c.text(`got ${(await c.req.text()).length} chars`));
app.get("/html", (c) => c.html("<h1>Hi</h1>"));
app.get("/redirect", (c) => c.redirect("/json"));
app.get("/status", (c) => c.text("created", 201, { "X-Custom": "yes" }));
app.get("/cookie", (c) => {
  c.header("Set-Cookie", "a=1; Path=/");
  c.header("Set-Cookie", "b=2; Path=/", { append: true });
  return c.text("cookies");
});
app.get("/stream", () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("chunk 1\n"));
      controller.enqueue(encoder.encode("chunk 2\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/plain" } });
});
app.get("/helper-stream", (c) =>
  stream(c, async (s) => {
    await s.write("first\n");
    await s.sleep(5);
    await s.write(new TextEncoder().encode("second\n"));
  }));
app.get("/sse", (c) =>
  streamSSE(c, async (s) => {
    for (let id = 1; id <= 3; id++) await s.writeSSE({ id: String(id), event: "tick", data: JSON.stringify({ id }) });
  }));
app.get("/error", () => {
  throw new Error("boom");
});
app.onError((err, c) => c.json({ error: err.message }, 500));
app.notFound((c) => c.text("nothing here", 404));

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port }, (info) => console.log(`listening on http://localhost:${info.port}`));
