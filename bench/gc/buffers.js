// Buffers and typed arrays: memory outside the cells (their bytes are malloc'd), which the
// collection trigger should count.
let n = 0;
for (let i = 0; i < 200_000; i++) {
  const b = Buffer.alloc(4096, i & 255);
  n += b[100];
  const u = new Uint8Array(1024);
  u[0] = i;
  n += u[0] & 1;
}
console.log(n);
