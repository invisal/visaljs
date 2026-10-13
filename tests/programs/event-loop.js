// The event loop: timers, one per iteration, each followed by the microtasks.

// timers, then microtasks, in order
setTimeout(() => console.log("timeout"), 0);
Promise.resolve().then(() => console.log("micro 1"));
queueMicrotask(() => console.log("micro 2"));
(async () => { await null; console.log("after await"); })();
console.log("sync");

// deadlines order timers; equal ones run in creation order (0 and 1 ms are the same in Node)
setTimeout(() => console.log("20 ms"), 20);
setTimeout(() => console.log("5 ms"), 5);
setTimeout(() => console.log("1 ms"), 1);
setTimeout(() => console.log("0 ms, created after 1 ms"), 0);

// extra arguments, and the microtasks a timer queues run before the next timer
setTimeout((a, b) => {
  console.log("args " + a + " " + b);
  Promise.resolve().then(() => console.log("micro after the args timer"));
}, 2, "x", "y");
setTimeout(() => console.log("next timer"), 2);

// clearTimeout before it fires; ids are positive and distinct
var cancelled = setTimeout(() => console.log("never"), 3);
clearTimeout(cancelled);
var ids = [setTimeout(() => {}, 0), setTimeout(() => {}, 0)];
console.log("ids " + (ids[0] > 0 && ids[1] !== ids[0]));

// setInterval re-arms after its callback until cleared, even from inside it
var ticks = 0;
var iv = setInterval(() => {
  ticks++;
  console.log("tick " + ticks);
  if (ticks === 3) clearInterval(iv);
}, 25);

// a sleep built on promises and timers
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function sequence() {
  await sleep(60);
  console.log("slept 60");
  await sleep(10);
  console.log("slept 70; ticks " + ticks);
  return "done";
}
sequence().then((v) => console.log("sequence " + v));

// a timer created by a timer runs in a later iteration
setTimeout(() => {
  console.log("outer");
  setTimeout(() => console.log("inner"), 0);
  queueMicrotask(() => console.log("outer's microtask"));
}, 40);
