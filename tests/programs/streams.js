// ReadableStream: sources (start, pull, cancel), the queue and its strategy, readers, async
// iteration, tee, errors and inspection, as Node has them.
const err = async (f) => {
  try {
    await f();
    return "no error";
  } catch (e) {
    return `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
  }
};

const rs = new ReadableStream({
  start(c) {
    c.enqueue("a");
    c.enqueue("b");
    c.close();
  },
});
console.log(rs, rs.locked);
const r = rs.getReader();
console.log(rs, r);
console.log(await err(() => rs.getReader()));
console.log(await r.read(), await r.read(), await r.read(), await r.closed, await r.read());

/* enqueue/close after close */
new ReadableStream({
  async start(c) {
    c.close();
    console.log(await err(() => c.enqueue(1)), "|", await err(() => c.close()));
  },
});

/* an erroring pull */
const s3 = new ReadableStream({
  pull(c) {
    c.error(new Error("x"));
  },
});
console.log(await err(() => s3.getReader().read()), s3);

/* pull on demand, highWaterMark 0 */
let n = 0;
const s4 = new ReadableStream({
  pull(c) {
    n++;
    console.log("pull", n);
    if (n > 3) c.close();
    else c.enqueue(n);
  },
}, { highWaterMark: 0 });
for await (const x of s4) console.log("iter", x);

/* desiredSize, a size function, releaseLock */
const controllers = [];
const s5 = new ReadableStream({ start(c) { controllers.push(c); } }, { highWaterMark: 10, size: (chunk) => chunk.length });
const c5 = controllers[0];
console.log(c5, c5.desiredSize);
c5.enqueue("abcd");
console.log(c5.desiredSize);
const r5 = s5.getReader();
console.log(await r5.read(), c5.desiredSize);
r5.releaseLock();
console.log(s5.locked, await err(() => r5.read()), await err(() => r5.closed));

/* cancel */
const s6 = new ReadableStream({
  cancel(reason) {
    console.log("cancel", reason);
  },
});
console.log(await s6.cancel("bye"), s6);
const s7 = new ReadableStream({ start(c) { c.enqueue(1); } });
const r7 = s7.getReader();
console.log(await r7.cancel("stop"), await r7.read(), await err(() => s7.cancel()));

/* a pending read resolved by a later enqueue */
let later;
const s8 = new ReadableStream({ start(c) { later = c; } });
const r8 = s8.getReader();
const pending = r8.read();
later.enqueue("late");
console.log(await pending);
later.error(new TypeError("boom"));
console.log(await err(() => r8.read()), await err(() => r8.closed));

/* tee */
const [t1, t2] = new ReadableStream({
  start(c) {
    c.enqueue(1);
    c.enqueue(2);
    c.close();
  },
}).tee();
const all = async (s) => {
  const out = [];
  for await (const v of s) out.push(v);
  return out;
};
console.log(await all(t1), await all(t2));

/* values({ preventCancel }) and breaking out of for await */
let canceled = false;
const s9 = new ReadableStream({
  pull(c) {
    c.enqueue("x");
  },
  cancel() {
    canceled = true;
  },
});
for await (const v of s9) {
  console.log("first", v);
  break;
}
console.log(canceled, s9.locked);

/* errors */
console.log(await err(() => new ReadableStream(1)), "|", await err(() => new ReadableStream({ pull: 1 })));
console.log(await err(() => new ReadableStream({}, { highWaterMark: -1 })), "|", await err(() => new ReadableStreamDefaultController()));
console.log(await err(() => new ReadableStream({ start() { throw new Error("in start"); } })));
console.log(await err(() => new ReadableStreamDefaultReader({})));
console.log(Object.keys(ReadableStream.prototype), typeof ReadableStream.prototype[Symbol.asyncIterator]);
