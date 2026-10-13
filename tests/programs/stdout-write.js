// process.stdout.write: a string as UTF-8, a typed array or DataView as its bytes (the view's
// window, whatever its element type), and Node's errors for anything else.
process.stdout.write("text é\n");
process.stdout.write(new Uint8Array([65, 66, 10]));
process.stdout.write(Buffer.from("buffer\n"));
process.stdout.write(new Uint8Array([0, 67, 68, 10, 0]).subarray(1, 4));
process.stdout.write(new Uint16Array([0x4645, 0x0a47]));
process.stdout.write(new DataView(new Uint8Array([88, 72, 10, 89]).buffer, 1, 2));
process.stdout.write(new Uint8Array([0xe2, 0x82]));  /* € split across writes: bytes, not text */
process.stdout.write(new Uint8Array([0xac, 10]));
for (const value of [5, true, undefined, {}, new ArrayBuffer(2), null]) {
  try {
    process.stdout.write(value);
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}
process.stdout.write(new Uint8Array([100, 111, 110, 101, 10]), () => console.log("written"));
