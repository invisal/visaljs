// setImmediate and clearImmediate: after the current task and its microtasks, before later timers

const order = [];
setTimeout(() => {
  order.push("timeout 50");
  console.log(order.join(", "));
}, 50);
setImmediate((a, b) => order.push(`immediate ${a} ${b}`), 1, 2);
const cancelled = setImmediate(() => order.push("cancelled"));
clearImmediate(cancelled);
Promise.resolve().then(() => order.push("microtask"));
order.push("sync");

// inside a timer: an immediate set there runs before a timer set at the same time
setTimeout(() => {
  setTimeout(() => order.push("inner timeout"), 0);
  setImmediate(() => order.push("inner immediate"));
}, 1);
