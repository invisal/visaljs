/* global console */
// A loop at the top level: sum and i are module bindings, but no function uses them, so they
// become SSA values in main (and Numbers). shared is read by a function: it stays a slot.
let sum = 0;
let shared = 1;
for (let i = 0; i < 1000; i++) {
  if (i % 3 === 0) sum += i;
  else sum -= 1;
}
function readShared() { return shared; }
shared = sum;
try {
  sum = readShared();
} catch {
  sum = -1;
}
console.log(sum, readShared());
