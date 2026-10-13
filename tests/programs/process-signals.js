// process's signal events and process.kill: a listener replaces the signal's default
// action, the last one removed restores it; watching doesn't keep the program alive.
import { EventEmitter } from "node:events";
import { constants } from "node:os";

const onUsr2 = (name, number) => console.log("got", name, number === constants.signals.SIGUSR2);
process.on("SIGUSR2", onUsr2);
process.once("SIGUSR1", function (name) { console.log("once", name, arguments.length); });

setTimeout(() => {
  console.log(process.kill(process.pid, "SIGUSR2"));
  setTimeout(() => {
    process.kill(process.pid, "SIGUSR1");
    setTimeout(() => {
      process.off("SIGUSR2", onUsr2);
      console.log(process.listenerCount("SIGUSR1"), process.listenerCount("SIGUSR2"));
    }, 20);
  }, 20);
}, 10);

for (const [pid, sig] of [[process.pid, "SIGFOO"], ["x", undefined], [999999999, 0]]) {
  try { process.kill(pid, sig); } catch (e) { console.log(e.code, e.message, e.syscall); }
}
try { process.on("SIGKILL", () => {}); } catch (e) { console.log(e.code, e.message, e.syscall); }
console.log(process.kill(process.pid, 0), process.listenerCount("SIGKILL"));

/* removeAllListeners: 'removeListener' for each, last first, when someone listens for it */
const e = new EventEmitter();
e.on("x", function a() {});
e.on("x", function b() {});
e.on("y", function c() {});
e.on("removeListener", (type, fn) => console.log("removed", type, fn.name));
e.removeAllListeners("x");
e.removeAllListeners();
console.log(e.eventNames());
