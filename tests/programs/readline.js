// node:readline and node:readline/promises on streams: lines however they're split into chunks,
// questions, pause and resume, the async iterator, and the cursor's escapes.
import readline from "node:readline";
import { createInterface, Readline } from "node:readline/promises";
import { PassThrough, Writable } from "node:stream";

/* what a stream was given, escapes shown */
function sink() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, encoding, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  stream.text = () => JSON.stringify(chunks.join(""));
  return stream;
}

async function lines() {
  const input = new PassThrough();
  const rl = readline.createInterface({ input });
  const seen = [];
  rl.on("line", (line) => seen.push(line));
  const closed = new Promise((resolve) => rl.on("close", resolve));
  input.write("one\ntw");
  input.write("o\r\nthree\r");
  input.write("\nfour\rfive");
  input.write(Buffer.from([0xc3]));  /* é, split between chunks */
  input.end(Buffer.from([0xa9, 0x0a, 0x6c, 0x61, 0x73, 0x74]));
  await closed;
  print("lines: " + JSON.stringify(seen));
  print("closed: " + rl.closed + " " + rl.terminal);
}

async function questions() {
  const input = new PassThrough();
  const output = sink();
  const rl = readline.createInterface({ input, output, prompt: "$ " });
  const events = [];
  for (const name of ["pause", "resume", "close"]) rl.on(name, () => events.push(name));
  rl.on("line", (line) => events.push("line " + line));
  const closed = new Promise((resolve) => rl.on("close", resolve));
  rl.question("name? ", (answer) => {
    events.push("answer " + answer);
    rl.prompt();
    rl.pause();
    rl.resume();
    input.write("after\n");
    rl.close();
    print("events: " + events.join(", "));
    print("output: " + output.text());
    print("prompt: " + rl.getPrompt());
  });
  input.write("Ada\n");
  await closed;
  try {
    rl.question("again? ", () => {});
  } catch (e) {
    print("after close: " + e.code);
  }
}

async function iterate() {
  const input = new PassThrough();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  setTimeout(() => input.end("a\r\nb\nc"), 0);
  const seen = [];
  for await (const line of rl) seen.push(line);
  print("for await: " + JSON.stringify(seen));
}

async function promises() {
  const input = new PassThrough();
  const output = sink();
  const rl = createInterface({ input, output });
  setTimeout(() => input.write("42\n"), 0);
  print("answer: " + (await rl.question("how many? ")));
  const controller = new AbortController();
  const pending = rl.question("never? ", { signal: controller.signal });
  controller.abort();
  try {
    await pending;
  } catch (e) {
    print("aborted: " + e.name + " " + e.code);
  }
  rl.close();
  print("output: " + output.text());
}

async function cursor() {
  const out = sink();
  readline.cursorTo(out, 3);
  readline.cursorTo(out, 3, 4);
  readline.moveCursor(out, -2, 1);
  readline.moveCursor(out, 0, 0);
  readline.clearLine(out, -1);
  readline.clearLine(out, 1);
  readline.clearLine(out, 0);
  readline.clearScreenDown(out);
  print("escapes: " + out.text());
  print("no stream: " + readline.cursorTo(null, 1));

  const out2 = sink();
  const r = new Readline(out2);
  r.cursorTo(0).moveCursor(1, -1).clearLine(0).clearScreenDown();
  print("queued: " + out2.text());
  await r.commit();
  print("committed: " + out2.text());
  r.cursorTo(5).rollback();
  await r.commit();
  print("rolled back: " + out2.text());
}

await lines();
await questions();
await iterate();
await promises();
await cursor();
