#!/usr/bin/env node
import { isMainThread } from "node:worker_threads";

import { main } from "./main.ts";

/* the compiler's worker loads this module too (main.ts's compileInWorker) */
if (isMainThread) {
  const tty = process.stderr.isTTY === true;
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    report: { live: tty, color: tty && !process.env.NO_COLOR && process.env.TERM !== "dumb" },
  });
}
