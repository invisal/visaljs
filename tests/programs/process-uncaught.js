// process's 'uncaughtException', 'unhandledRejection' and 'rejectionHandled': with
// listeners, errors and rejections don't end the program. Statuses are checked in programs.test.ts.
const log = [];
process.on("uncaughtException", (error, origin) => console.log("uncaughtException", error.message, origin));
process.on("unhandledRejection", (reason, promise) => {
  console.log("unhandledRejection", reason.message, promise instanceof Promise);
  Promise.resolve().then(() => console.log("a job its listener queued"));
});
process.on("rejectionHandled", (promise) => console.log("rejectionHandled", promise === late));
process.on("exit", (code) => console.log("exit", code, log));

setTimeout(() => { log.push("timer"); throw new Error("from a timer"); }, 1);
setTimeout(() => {
  log.push("later timer");
  late.catch(() => console.log("late's handler"));
}, 5);
queueMicrotask(() => { throw new Error("from a microtask"); });
queueMicrotask(() => log.push("next microtask"));
const late = Promise.reject(new Error("handled late"));
console.log("main");
