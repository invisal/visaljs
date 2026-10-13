// node:v8: serialize and deserialize byte for byte as Node's (V8's wire format, Buffers and typed
// arrays as Node's host objects), Serializer's and Deserializer's raw parts, the heap statistics'
// shapes, and the rest of the module.
import v8 from "node:v8";

const hex = (b) => Buffer.from(b).toString("hex");
const show = (label, f) => {
  try {
    print(label + ": " + f());
  } catch (e) {
    print(label + ": " + e.name + " " + (e.code ?? "") + " " + e.message);
  }
};

const values = {
  undefined: undefined, null: null, true: true, false: false, int: 42, negative: -7, max: 2147483647, min: -2147483648,
  double: 1.5, big: 2 ** 40, nan: NaN, minusZero: -0, bigint: 123n, negBigint: -5n, hugeBigint: 2n ** 70n,
  latin1: "héllo", twoByte: "xxx日", emptyString: "", array: [1, "a", true], nested: { a: { b: [null] } },
  keys: { 1: "a", b: 2, 0: "z" }, date: new Date(0), regexp: /ab+c/gi, map: new Map([[1, "one"], ["k", { v: 2 }]]),
  set: new Set([1, "two"]), arrayBuffer: new Uint8Array([1, 2, 3]).buffer, stringObject: new String("s"),
  numberObject: new Number(3), booleanObject: new Boolean(false), uint8: new Uint8Array([1, 2]), buffer: Buffer.from("hi"),
  float64: new Float64Array([0.5]), dataView: new DataView(new ArrayBuffer(4), 2), bigint64: new BigInt64Array([-1n]),
};
const sparse = [1, , 3];
const extra = [1, 2];
extra.extra = true;
const o = {};
values.sparse = sparse;
values.extra = extra;
values.refs = [o, o];
values.twoByteInArray = ["日"];
values.error = Object.assign(new RangeError("r"), { stack: undefined });
values.cause = (() => {
  const e = new Error("c", { cause: 5 });
  delete e.stack;
  return e;
})();

for (const [name, value] of Object.entries(values)) {
  const bytes = v8.serialize(value);
  const back = v8.deserialize(bytes);
  let shown;
  if (typeof back === "bigint") shown = back + "n";
  else if (back instanceof Error) shown = `${back.name}:${back.message}:${back.cause}`;
  else if (back instanceof Map || back instanceof Set) shown = back.constructor.name + JSON.stringify([...back]);
  else if (ArrayBuffer.isView(back)) shown = back.constructor.name + ":" + hex(new Uint8Array(back.buffer, back.byteOffset, back.byteLength));
  else if (back instanceof ArrayBuffer) shown = "ArrayBuffer:" + hex(back);
  else if (typeof back === "object" && back !== null) shown = Object.prototype.toString.call(back) + JSON.stringify(back) + Object.keys(back);
  else shown = Object.is(back, -0) ? "-0" : String(back);
  print(name + ": " + hex(bytes) + " -> " + shown);
}
print("refs kept: " + (() => {
  const back = v8.deserialize(v8.serialize(values.refs));
  return back[0] === back[1];
})());
try {
  v8.serialize(() => {});
} catch (e) {
  print("function: " + e.name + " " + e.message.endsWith(" could not be cloned."));  /* the source text: visaljs keeps none */
}
show("symbol", () => v8.serialize(Symbol("s")));

/* the base Serializer: views as V8's own, and the raw writes */
{
  const s = new v8.Serializer();
  s.writeHeader();
  s.writeValue(new Uint16Array([5, 6]));
  s.writeUint32(300);
  s.writeUint64(1, 2);
  s.writeDouble(0.25);
  s.writeRawBytes(Buffer.from([9, 8]));
  const bytes = s.releaseBuffer();
  print("Serializer: " + hex(bytes));
  const d = new v8.Deserializer(bytes);
  print("readHeader: " + d.readHeader() + " version " + d.getWireFormatVersion());
  const view = d.readValue();
  print("view: " + view.constructor.name + " " + [...view]);
  print("raw: " + d.readUint32() + " " + d.readUint64() + " " + d.readDouble() + " " + hex(d.readRawBytes(2)));
}

/* heap statistics: their shapes */
print("heap: " + Object.keys(v8.getHeapStatistics()).join(","));
print("heap types: " + Object.values(v8.getHeapStatistics()).every((n) => typeof n === "number"));
print("spaces: " + v8.getHeapSpaceStatistics().length + " " + Object.keys(v8.getHeapSpaceStatistics()[0]).join(","));
print("code: " + Object.keys(v8.getHeapCodeStatistics()).join(","));
print("cpp: " + Object.keys(v8.getCppHeapStatistics("brief")).join(",") + " " + v8.getCppHeapStatistics("brief").detail_level);
show("cpp bad", () => v8.getCppHeapStatistics("x"));

/* the rest */
print("tag: " + typeof v8.cachedDataVersionTag());
print("oneByte: " + v8.isStringOneByteRepresentation("héllo") + " " + v8.isStringOneByteRepresentation("日"));
show("oneByte bad", () => v8.isStringOneByteRepresentation(1));
v8.setFlagsFromString("--no-lazy");
print("promiseHooks: " + Object.keys(v8.promiseHooks).join(","));
print("snapshot: " + v8.startupSnapshot.isBuildingSnapshot());
show("addSerializeCallback", () => v8.startupSnapshot.addSerializeCallback(() => {}));
const profiler = new v8.GCProfiler();
profiler.start();
const profile = profiler.stop();
print("GCProfiler: " + profile.version + " " + Array.isArray(profile.statistics) + " " + (profile.endTime >= profile.startTime));
