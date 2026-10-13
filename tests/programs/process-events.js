// process as an EventEmitter: 'beforeExit' each time the loop empties, while its
// listeners give it more to do, then 'exit'. Exit statuses are checked in programs.test.ts.
import { EventEmitter } from "node:events";

console.log(process instanceof EventEmitter, process.constructor.name, Object.getPrototypeOf(process) === process.constructor.prototype);

let rounds = 0;
process.on("beforeExit", (code) => {
  console.log("beforeExit", code, rounds);
  if (rounds++ < 2) setTimeout(() => console.log("more work", rounds), 1);
  else Promise.resolve().then(() => console.log("a microtask doesn't bring beforeExit back"));
});
process.once("exit", (code) => console.log("exit", code));
process.once("exit", function () {
  console.log(this === process, process.listenerCount("exit"));
});

const seen = [];
const record = (...args) => seen.push(args.join(" "));
process.on("custom", record);
console.log(process.emit("custom", 1, 2), process.emit("nobody"), seen);
process.off("custom", record);
console.log(process.listenerCount("custom"), process.listeners("beforeExit").length);

setTimeout(() => console.log("timer"), 1);
console.log("main done");
