// Node's Buffer: encodings, the statics, the methods, errors and inspection.
import { Buffer as ModuleBuffer, constants, isUtf8 } from "node:buffer";
const err = (f) => {
  try {
    f();
    return "no error";
  } catch (e) {
    return `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
  }
};

/* creating */
const b = Buffer.from("héllo wörld");
console.log(b, b.length, b instanceof Uint8Array, Buffer.isBuffer(b), Buffer.isBuffer(new Uint8Array(1)));
console.log(Buffer.alloc(60), Buffer.from([]), Buffer.alloc(5, "ab"), Buffer.alloc(3, 257), Buffer.allocUnsafe(2).length);
console.log(Object.getPrototypeOf(Buffer.prototype) === Uint8Array.prototype, Object.getPrototypeOf(Buffer) === Uint8Array);
// Node assigns the prototype's methods, so for-in sees them (mysql2's MockBuffer stubs them that way)
const protoKeys = [];
for (const key in Buffer.prototype) protoKeys.push(key);
console.log("Buffer.prototype for-in:", protoKeys.length, protoKeys.join(","));
console.log(Buffer.from(new Uint16Array([1, 256])), Buffer.from({ length: 2, 0: 1, 1: 2 }), Buffer.from(new ArrayBuffer(3)));
console.log(Buffer.from([1, 2, 300, -1, 1.5]), Buffer.from({ type: "Buffer", data: [104, 105] }), Buffer.from(new String("str")));
console.log(Buffer.of(1, 2, 3), Buffer.copyBytesFrom(new Uint16Array([1, 2, 3]), 1, 1));
const ab = new ArrayBuffer(8);
const view = Buffer.from(ab, 2, 3);
view[0] = 7;
console.log(new Uint8Array(ab)[2], view.byteOffset, view.length, view.buffer === ab);

/* encodings */
console.log(b.toString("hex"), b.toString("base64"), b.toString("base64url"));
console.log(b.toString("latin1"), b.toString("ascii"), b.toString("utf16le").length, b.toString("utf8", 1, 3), b.toString(undefined, 7));
console.log(Buffer.from("aGVsbG8-_w", "base64"), Buffer.from("aGVs bG8=", "base64"), Buffer.from("zz12", "hex"), Buffer.from("0aBf1", "hex"));
console.log(Buffer.from("€", "latin1"), Buffer.from("hé", "ucs2"), Buffer.from("hé", "UTF-16LE"), Buffer.from("x", "BINARY"));
console.log(Buffer.from([0xe2, 0x82, 0x41, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0xc3]).toString(), Buffer.from("\ud800x").toString("hex"));
console.log(Buffer.byteLength("héllo"), Buffer.byteLength("aGVsbG8=", "base64"), Buffer.byteLength("abcd", "hex"), Buffer.byteLength(b),
  Buffer.byteLength(new ArrayBuffer(4)), Buffer.byteLength("ab", "ucs2"));
console.log(Buffer.isEncoding("UTF-8"), Buffer.isEncoding("x"), Buffer.isEncoding(1), Buffer.from([1, 2, 3]).toString("base64"));

/* concat, compare, equals, slices */
console.log(Buffer.concat([Buffer.from("a"), new Uint8Array([98])]), Buffer.concat([Buffer.from("abc")], 2), Buffer.concat([Buffer.from("a")], 3));
console.log(b.subarray(1, 3), b.slice(-3), b.subarray(5, 2).length, b.equals(Buffer.from("héllo wörld")), Buffer.compare(Buffer.from("a"), Buffer.from("b")));
console.log(Buffer.from("abc").compare(Buffer.from("abd")), Buffer.from("abc").compare(Buffer.from("xbc"), 1, 3, 1, 3));
const shared = b.subarray(0, 1);
shared[0] = 72;
console.log(b.toString(), [Buffer.from("zyx")].sort(Buffer.compare)[0].toString(), [Buffer.from("b"), Buffer.from("a")].sort(Buffer.compare));

/* searching */
console.log(b.indexOf("l"), b.indexOf(0x6c, 4), b.includes("wör"), b.lastIndexOf("l"), b.indexOf(Buffer.from("wö")), b.indexOf("zz"));
console.log(b.indexOf("l", -4), b.lastIndexOf("l", 3), b.indexOf(""), b.includes("6c", 0, "hex"));

/* writing, filling, copying */
const w = Buffer.alloc(8);
console.log(w.write("abc", 2), w, w.write("héllo", 6), w, w.write("ff", 0, "hex"), w.write("zz", "latin1"), w);
console.log(Buffer.alloc(6).fill("xy"), Buffer.alloc(6).fill(0x41, 2, 4), Buffer.alloc(4).fill(Buffer.from([1, 2, 3])), Buffer.alloc(3).fill("aa", "hex"));
const src = Buffer.from("abcdef");
const dst = Buffer.alloc(4);
console.log(src.copy(dst, 1, 2), dst, src.copy(src, 0, 3), src);

/* numbers */
const n = Buffer.alloc(16);
console.log(n.writeUInt32BE(0xdeadbeef, 0), n.writeInt16LE(-2, 4), n.writeUInt8(255, 6), n.writeDoubleLE(1.5, 8), n);
console.log(n.readUInt32BE(0), n.readUInt32LE(0), n.readInt16LE(4), n.readInt8(6), n.readUInt8(6), n.readDoubleLE(8), n.readFloatBE(0));
console.log(n.readUIntBE(0, 3), n.readIntLE(0, 6), n.writeUIntLE(0x123456, 0, 3), n.readUInt16BE(1), n.writeIntBE(-5, 0, 2), n.readInt16BE(0));
console.log(n.writeBigInt64LE(-3n, 0), n.readBigInt64LE(0), n.readBigUInt64BE(0), n.writeFloatLE(0.5, 0), n.readFloatLE(0));
console.log(err(() => n.readUInt32LE(14)), "|", err(() => n.writeUInt8(256)), "|", err(() => n.readUInt8(1.5)));
console.log(err(() => Buffer.alloc(2).readUInt32LE()), "|", err(() => n.writeInt8(-200)), "|", err(() => n.readUInt16LE("1")));
console.log(Buffer.from([1, 2, 3, 4]).swap16(), Buffer.from([1, 2, 3, 4]).swap32(), err(() => Buffer.from([1, 2, 3]).swap16()));

/* JSON, typed array methods (Buffer is their species) */
console.log(JSON.stringify(Buffer.from("hi")), Buffer.from("x").map((c) => c + 1), Buffer.from("abc").filter((c) => c !== 98));
console.log(Buffer.from("abc").reverse(), Buffer.from("ab").toJSON(), [...Buffer.from("ab")], Buffer.from("ab").entries().next());

/* errors */
console.log(err(() => Buffer.from(5)), "|", err(() => Buffer.alloc(-1)), "|", err(() => Buffer.alloc("1")));
console.log(err(() => b.toString("nope")), "|", err(() => Buffer.from("x", "nope")), "|", err(() => Buffer.concat([1])));
console.log(err(() => Buffer.concat("x")), "|", err(() => Buffer.compare(1, b)), "|", err(() => b.equals("x")));
console.log(err(() => Buffer.from(ab, 9)), "|", err(() => Buffer.byteLength(5)), "|", err(() => b.write(1)));

/* inspection */
const x = Buffer.from("ab");
x.foo = 1;
console.log(x, [x], { x }, Buffer.alloc(0), Buffer.from("zz").inspect());
console.log(ModuleBuffer === Buffer, constants.MAX_LENGTH, isUtf8(Buffer.from("é")), isUtf8(Buffer.from([0xff])));
class MyBuffer extends Buffer {}
console.log(Object.prototype.toString.call(b), b.constructor.name, typeof Buffer.poolSize, MyBuffer.name);
