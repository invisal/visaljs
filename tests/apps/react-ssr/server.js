// React server rendering on node:http: the store page (app.js) streamed with
// renderToPipeableStream. `/?n=50` renders 50 products (200 by default, at most 2000).
import { createServer } from "node:http";

import { createElement as h } from "react";
import { renderToPipeableStream } from "react-dom/server";

import { App, makeProducts } from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);
const pages = new Map();   // product lists by size: the data, not the HTML, is cached

function products(n) {
  let list = pages.get(n);
  if (!list) pages.set(n, (list = makeProducts(n)));
  return list;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found\n");
    return;
  }
  const n = Math.min(2000, Math.max(0, Number(url.searchParams.get("n") ?? 200) | 0));
  const stream = renderToPipeableStream(h(App, { products: products(n) }), {
    onShellReady() {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      stream.pipe(res);
    },
    onShellError(error) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Render failed: ${error.message}\n`);
    },
  });
});

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
