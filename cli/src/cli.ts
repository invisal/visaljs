#!/usr/bin/env node
import { main } from "./main.ts";

const tty = process.stderr.isTTY === true;
process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  report: { live: tty, color: tty && !process.env.NO_COLOR && process.env.TERM !== "dumb" },
});
