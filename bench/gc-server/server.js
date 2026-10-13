// The GC server benchmark's server (bench/gc-server.ts): a cache of 20,000 entries, replaced
// in turn, is the live heap; "/" answers a small JSON page; "/big" makes a megabyte buffer and a
// large JSON body, the load spike.
import { createServer } from "node:http";

const cache = new Map();
let n = 0;

function items(start, count) {
  const out = [];
  for (let k = 0; k < count; k++) out.push({ id: start + k, name: `item ${start + k}`, tags: ["a", "b", String(k % 7)] });
  return out;
}

createServer((req, res) => {
  const i = n++;
  res.setHeader("content-type", "application/json");
  if (req.url === "/big") {
    const buffer = Buffer.alloc(1 << 20, i & 255);
    res.end(JSON.stringify({ check: buffer[i % 1000], items: items(i, 5000) }));
    return;
  }
  cache.set(i % 20000, items(i, 10));
  res.end(JSON.stringify(items(i, 100)));
}).listen(Number(process.env.PORT) || 3000);
