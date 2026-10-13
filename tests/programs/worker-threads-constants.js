// node:worker_threads in a program's one thread, node:constants and fs.constants, process.features,
// require() of a JSON file at run time, and fs.ReadStream called as a function (graceful-fs).
// Runs in an empty temporary directory.
import * as threads from "node:worker_threads";
import constants from "node:constants";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

console.log(threads.isMainThread, threads.isInternalThread, threads.threadId, JSON.stringify(threads.threadName), threads.parentPort, threads.workerData);
console.log(Object.keys(threads.resourceLimits).length, String(threads.SHARE_ENV));
threads.setEnvironmentData("answer", 42);
console.log(threads.getEnvironmentData("answer"), threads.getEnvironmentData("missing"));
threads.setEnvironmentData("answer", undefined);
console.log(threads.getEnvironmentData("answer"));
const marked = {};
threads.markAsUntransferable(marked);
threads.markAsUntransferable(1);
console.log(threads.isMarkedAsUntransferable(marked), threads.isMarkedAsUntransferable({}), threads.isMarkedAsUntransferable(1));
console.log(typeof threads.Worker, typeof threads.MessageChannel, typeof threads.BroadcastChannel);

console.log(Object.isFrozen(constants), constants.O_CREAT === fs.constants.O_CREAT, constants.ENOENT === os.constants.errno.ENOENT,
  constants.SIGINT === os.constants.signals.SIGINT, constants.RTLD_NOW === os.constants.dlopen.RTLD_NOW, constants.PRIORITY_LOW);
console.log(fs.constants.F_OK, fs.constants.R_OK, fs.constants.W_OK, fs.constants.X_OK, fs.constants.COPYFILE_EXCL, fs.constants.S_IFMT, fs.constants.S_IFDIR);
console.log(Object.getPrototypeOf(fs.constants), Object.keys(fs.constants).includes("O_RDONLY"));

console.log(process.features.uv, process.features.require_module, process.features.tls, Object.keys(process.features).join(" "));

fs.writeFileSync("data.json", '﻿{ "name": "data", "list": [1, 2] }');
fs.writeFileSync("broken.json", "{ name: 1 }");
const require = createRequire(join(process.cwd(), "main.js"));
const data = require("./data.json");
console.log(data, require("./data.json") === data, require(join(process.cwd(), "data.json")) === data);
for (const id of ["./missing.json", "./broken.json"]) {
  try { require(id); } catch (e) { console.log(e.name, e.code, e.message.split("\n")[0].replace(process.cwd() + "/", "")); }
}

fs.writeFileSync("chunk.txt", "0123456789");
function Patched(path, options) { return fs.ReadStream.apply(this, arguments), this; }
Patched.prototype = Object.create(fs.ReadStream.prototype);
const s = new Patched("chunk.txt", { encoding: "utf8", start: 2, end: 5 });
s.on("data", (d) => console.log(JSON.stringify(d), s instanceof fs.ReadStream)).on("close", () => {
  const t = fs.ReadStream("chunk.txt", { end: 0 });
  t.on("data", (d) => console.log(d.length, t instanceof fs.ReadStream));
});
