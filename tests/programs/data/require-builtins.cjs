// require() of a built-in gives its module.exports, as Node's does (require-builtins.js)
const EventEmitter = require("events");
const Stream = require("stream");
const fs = require("fs");
const buffer = require("buffer");

const lines = [];
lines.push(`events: ${typeof EventEmitter} ${EventEmitter.EventEmitter === EventEmitter} ${typeof EventEmitter.once}`);
lines.push(`stream: ${typeof Stream} ${Stream.Stream === Stream} ${typeof Stream.Readable} ${typeof Stream.prototype.pipe}`);
fs.patched = true;  // a CommonJS module's exports can be changed, unlike a namespace
lines.push(`fs: ${typeof fs} ${typeof fs.readFileSync} ${fs.patched}`);
lines.push(`buffer: ${buffer.Buffer === Buffer}`);
// pg's lib/utils.js
const { isDate } = require("util/types");
lines.push(`util/types: ${isDate(new Date())} ${isDate({})} ${require("util").types === require("util/types")}`);

// safer-buffer copies Buffer's statics with for-in: they're enumerable, as in Node
const statics = [];
for (const key in Buffer) if (Object.hasOwn(Buffer, key)) statics.push(key);
lines.push(`Buffer statics: ${statics.join(",")}`);

// util.inherits from a legacy constructor (send's SendStream)
function SendStream() { Stream.call(this); }
require("util").inherits(SendStream, Stream);
lines.push(`inherits: ${new SendStream() instanceof EventEmitter} ${SendStream.super_ === Stream}`);

// the legacy pipe: 'data' events to write(), then end()
const source = new SendStream();
const written = [];
const dest = new Stream.Writable({ write(chunk, _enc, cb) { written.push(String(chunk)); cb(); } });
dest.on("finish", () => console.log(`legacy pipe: ${written.join("|")}`));
source.pipe(dest);
source.emit("data", "a");
source.emit("data", "b");
source.emit("end");

// mysql2's lib/tracing.js: require("process") is process itself, whose emit stays
// EventEmitter.prototype's (not node:process's wrapper, which would call itself)
const proc = require("process");
lines.push(`process: ${proc === process} ${Object.hasOwn(proc, "emit")} ${typeof proc.on}`);
proc.once("beforeExit", () => console.log("beforeExit"));

module.exports = lines;
