// The exit status and output streams: process.exitCode, stderr, and an exit with work pending.
console.log("out 1");
console.error("err 1");
process.stdout.write("out 2\n");
process.exitCode = 7;
setTimeout(() => {
  console.log("timer ran, exiting with", process.exitCode);
  process.exit();
}, 1);
setTimeout(() => console.log("never"), 50);
