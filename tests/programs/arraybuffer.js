// ArrayBuffer and DataView (§25.1, §25.3): fixed and resizable buffers, slice, transfer and
// detaching, DataView reads and writes in both byte orders, and how console.log prints them.
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.constructor.name}: ${e.message}`);
  }
};

const buf = new ArrayBuffer(16);
const view = new DataView(buf);
view.setUint8(0, 255);
view.setInt16(1, -2);
view.setInt16(3, -2, true);
view.setUint32(5, 0xdeadbeef);
view.setFloat32(9, 1.5, true);
view.setInt8(13, -128);
console.log(buf);
console.log(view.getUint8(0), view.getInt8(0), view.getInt16(1), view.getUint16(1), view.getInt16(3, true), view.getInt16(3));
console.log(view.getUint32(5).toString(16), view.getInt32(5), view.getUint32(5, true).toString(16), view.getFloat32(9, true), view.getInt8(13));

// Float64 round trip, NaN and -0, and integer wrapping
const f = new DataView(new ArrayBuffer(8));
for (const x of [Math.PI, -0, NaN, Infinity, 1e-310, 2 ** 53 + 2]) {
  f.setFloat64(0, x);
  const back = f.getFloat64(0);
  console.log(x, back, Object.is(x, back), f.getUint32(0).toString(16), f.getUint32(4).toString(16));
}
f.setInt8(0, 300);
f.setUint16(1, -1);
f.setInt32(3, 2 ** 32 + 5);
console.log(f.getUint8(0), f.getUint16(1), f.getInt32(3));
f.setFloat32(0, 16777217);
console.log(f.getFloat32(0), f.getUint32(0).toString(16));

// Views with an offset and a length
const part = new DataView(buf, 4, 8);
console.log(part.byteOffset, part.byteLength, part.buffer === buf, part.getUint8(1).toString(16));
t(() => part.getUint32(5));
t(() => new DataView(buf, 17));
t(() => new DataView(buf, 8, 9));

// slice copies; the original is untouched
const copy = buf.slice(5, 9);
new DataView(copy).setUint8(0, 0);
console.log(copy, copy.byteLength, view.getUint8(5).toString(16), buf.slice(-2), buf.slice(10, 2));

// Resizable buffers, and views that track their length
const rb = new ArrayBuffer(4, { maxByteLength: 12 });
const tracking = new DataView(rb);
const fixed = new DataView(rb, 0, 4);
console.log(rb.resizable, rb.maxByteLength, tracking.byteLength, fixed.byteLength);
rb.resize(10);
tracking.setUint8(9, 7);
console.log(rb.byteLength, tracking.byteLength, tracking.getUint8(9), rb);
rb.resize(2);
console.log(rb.byteLength, tracking.byteLength);
t(() => fixed.byteLength);
t(() => rb.resize(13));
rb.resize(6);
console.log(fixed.byteLength, tracking.getUint8(5));

// transfer moves the bytes and detaches the original
const src = new ArrayBuffer(4);
new DataView(src).setUint32(0, 0x01020304);
const moved = src.transfer(6);
console.log(src, src.detached, src.byteLength, moved, moved.detached);
const shrunk = moved.transferToFixedLength(2);
console.log(shrunk, moved.detached, rb.transfer().resizable, new ArrayBuffer(1, { maxByteLength: 2 }).transferToFixedLength().resizable);
t(() => src.slice());
t(() => new DataView(src));
t(() => src.transfer());

// subclasses and species
class Bytes extends ArrayBuffer {
  get size() {
    return this.byteLength;
  }
}
const bytes = new Bytes(3);
console.log(bytes, bytes.size, bytes.slice(1) instanceof Bytes, ArrayBuffer[Symbol.species] === ArrayBuffer);
console.log(ArrayBuffer.isView(view), ArrayBuffer.isView(buf), ArrayBuffer.isView({}), Object.prototype.toString.call(buf), String(view));
console.log(new ArrayBuffer(0), new DataView(new ArrayBuffer(3), 1), new ArrayBuffer(120));

// errors
t(() => ArrayBuffer(1));
t(() => new ArrayBuffer(-1));
t(() => new ArrayBuffer(2 ** 53));
t(() => new ArrayBuffer(4, { maxByteLength: 2 }));
t(() => new ArrayBuffer(4).resize(2));
t(() => new DataView({}));
t(() => DataView.prototype.getInt8.call(buf, 0));
t(() => view.getInt16(15));
t(() => view.getInt8(-1));
