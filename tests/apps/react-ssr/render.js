// The render benchmark: the page rendered to a string, again and again, timed in-process (so
// startup isn't counted). Prints the page's size and a checksum of its HTML, which Node's and
// visaljs's runs must agree on, then the time per render on stderr.
//
//   node render.js [products=200] [renders=200]
import { performance } from "node:perf_hooks";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { App, makeProducts } from "./app.js";

const count = Number(process.argv[2] ?? 200);
const renders = Number(process.argv[3] ?? 200);
const products = makeProducts(count);

function checksum(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return x >>> 0;
}

let html = renderToString(h(App, { products }));   // warm-up, and the output to check
const warmups = Math.min(20, renders);
for (let i = 1; i < warmups; i++) renderToString(h(App, { products }));
const start = performance.now();
for (let i = 0; i < renders; i++) html = renderToString(h(App, { products }));
const ms = performance.now() - start;

console.log(`${html.length} chars, checksum ${checksum(html)}`);
console.error(`${renders} renders of ${count} products: ${(ms / renders).toFixed(3)} ms per render`);
