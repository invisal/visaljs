// node:v8: serialize and deserialize in V8's wire format (version 15) and Node's DefaultSerializer
// (Buffers and typed arrays as host objects), byte for byte, with Serializer and Deserializer for
// the format's parts; heap figures from visaljs's collector in V8's shapes; and the rest of the
// module as a compiled program has it (no flags, coverage or heap snapshots).
import { processMemory } from "visaljs:host";
import { codeError, invalidArgType, notSupported, validateString } from "./internal/errors.js";

/* ---- the wire format ---------------------------------------------------------------------------- */

const kLatestVersion = 15;
const T = {
  version: 0xff, padding: 0x00, hole: 0x2d, undefined: 0x5f, null: 0x30, true: 0x54, false: 0x46, int32: 0x49, uint32: 0x55,
  double: 0x4e, bigint: 0x5a, utf8: 0x53, oneByte: 0x22, twoByte: 0x63, ref: 0x5e, beginObject: 0x6f, endObject: 0x7b,
  beginSparse: 0x61, endSparse: 0x40, beginDense: 0x41, endDense: 0x24, date: 0x44, trueObject: 0x79, falseObject: 0x78,
  numberObject: 0x6e, bigintObject: 0x7a, stringObject: 0x73, regexp: 0x52, beginMap: 0x3b, endMap: 0x3a, beginSet: 0x27,
  endSet: 0x2c, arrayBuffer: 0x42, transfer: 0x74, view: 0x56, host: 0x5c, error: 0x72,
};
const ERROR = { eval: 0x45, range: 0x52, reference: 0x46, syntax: 0x53, type: 0x54, uri: 0x55, message: 0x6d, cause: 0x63, stack: 0x73, end: 0x2e };
const errorPrototypes = [[EvalError, ERROR.eval], [RangeError, ERROR.range], [ReferenceError, ERROR.reference], [SyntaxError, ERROR.syntax],
  [TypeError, ERROR.type], [URIError, ERROR.uri]];
const REGEXP_FLAGS = [["g", 1], ["i", 2], ["m", 4], ["y", 8], ["u", 16], ["s", 32], ["d", 128], ["v", 256]];

/* V8's views' subtags, for the base Serializer */
const VIEW_TAGS = [["Int8Array", 0x62], ["Uint8Array", 0x42], ["Uint8ClampedArray", 0x43], ["Int16Array", 0x77], ["Uint16Array", 0x57],
  ["Int32Array", 0x64], ["Uint32Array", 0x44], ["Float32Array", 0x66], ["Float64Array", 0x46], ["BigInt64Array", 0x71],
  ["BigUint64Array", 0x51], ["DataView", 0x3f]];

/* Node's DefaultSerializer: the views' indices (10 is Buffer) */
const viewTypes = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
  DataView, null, BigInt64Array, BigUint64Array];
const typeName = (v) => Object.prototype.toString.call(v).slice(8, -1);

function cloneError(value) {
  const shown = typeof value === "function" ? Function.prototype.toString.call(value) : typeof value === "symbol" ? String(value)
    : `#<${value?.constructor?.name ?? "Object"}>`;
  return new Error(`${shown} could not be cloned.`);
}

export class Serializer {
  #chunks = [];
  #size = 0;
  #ids = new Map();
  #transfers = new Map();
  #viewsAsHost = false;

  /* ---- bytes ---- */
  #byte(b) {
    this.#push(Uint8Array.of(b));
  }

  #push(bytes) {
    this.#chunks.push(bytes);
    this.#size += bytes.length;
  }

  #varint(n) {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    this.#push(Uint8Array.from(out));
  }

  #double(d) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, d, true);
    this.#push(b);
  }

  /* ---- the public calls ---- */
  writeHeader() {
    this.#byte(T.version);
    this.#varint(kLatestVersion);
  }

  writeValue(value) {
    this.#write(value);
    return true;
  }

  releaseBuffer() {
    const out = Buffer.allocUnsafe(this.#size);
    let at = 0;
    for (const c of this.#chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.#chunks = [];
    this.#size = 0;
    return out;
  }

  transferArrayBuffer(id, arrayBuffer) {
    this.#transfers.set(arrayBuffer, id);
  }

  writeUint32(value) {
    this.#varint(value >>> 0);
  }

  writeUint64(hi, lo) {
    this.#varint((hi >>> 0) * 4294967296 + (lo >>> 0));
  }

  writeDouble(value) {
    this.#double(value);
  }

  writeRawBytes(source) {
    if (!ArrayBuffer.isView(source)) throw invalidArgType("source", "an instance of Buffer, TypedArray, or DataView", source);
    this.#push(new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice());
  }

  _setTreatArrayBufferViewsAsHostObjects(flag) {
    this.#viewsAsHost = Boolean(flag);
  }

  _getDataCloneError(message) {
    return new Error(message);
  }

  _getSharedArrayBufferId() {
    throw this._getDataCloneError("#<SharedArrayBuffer> could not be cloned.");
  }

  _writeHostObject(object) {
    throw this._getDataCloneError(`Unserializable host object: ${typeName(object)}`);
  }

  /* ---- values ---- */
  #string(s) {
    let oneByte = true;
    for (let i = 0; i < s.length && oneByte; i++) oneByte = s.charCodeAt(i) <= 0xff;
    if (oneByte) {
      this.#byte(T.oneByte);
      this.#varint(s.length);
      this.#push(Uint8Array.from(s, (c) => c.charCodeAt(0)));
      return;
    }
    const byteLength = s.length * 2;
    let lengthSize = 1;
    for (let n = byteLength; n >= 128; n = Math.floor(n / 128)) lengthSize++;
    if ((this.#size + 1 + lengthSize) & 1) this.#byte(T.padding);  /* the UTF-16 bytes 2-aligned, as V8's */
    this.#byte(T.twoByte);
    this.#varint(byteLength);
    const b = new Uint8Array(byteLength);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      b[2 * i] = c & 0xff;
      b[2 * i + 1] = c >> 8;
    }
    this.#push(b);
  }

  #number(n) {
    if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 && !Object.is(n, -0)) {
      this.#byte(T.int32);
      this.#varint(((n << 1) ^ (n >> 31)) >>> 0);
    } else {
      this.#byte(T.double);
      this.#double(n);
    }
  }

  #bigintDigits(b) {
    const negative = b < 0n;
    let magnitude = negative ? -b : b;
    const words = [];
    while (magnitude > 0n) {
      words.push(magnitude & 0xffffffffffffffffn);
      magnitude >>= 64n;
    }
    this.#varint((words.length * 8) * 2 + (negative ? 1 : 0));
    const bytes = new Uint8Array(words.length * 8);
    const view = new DataView(bytes.buffer);
    words.forEach((w, i) => view.setBigUint64(i * 8, w, true));
    this.#push(bytes);
  }

  #write(value) {
    switch (typeof value) {
      case "undefined":
        return this.#byte(T.undefined);
      case "boolean":
        return this.#byte(value ? T.true : T.false);
      case "number":
        return this.#number(value);
      case "string":
        return this.#string(value);
      case "bigint":
        this.#byte(T.bigint);
        return this.#bigintDigits(value);
      case "symbol":
      case "function":
        throw this._getDataCloneError(cloneError(value).message);
    }
    if (value === null) return this.#byte(T.null);
    const id = this.#ids.get(value);
    if (id !== undefined) {
      this.#byte(T.ref);
      return this.#varint(id);
    }
    if (value instanceof ArrayBuffer && this.#transfers.has(value)) {
      this.#ids.set(value, this.#ids.size);
      this.#byte(T.transfer);
      return this.#varint(this.#transfers.get(value));
    }
    if (ArrayBuffer.isView(value) && this.#viewsAsHost) {
      this.#ids.set(value, this.#ids.size);
      this.#byte(T.host);
      return this._writeHostObject(value);
    }
    if (ArrayBuffer.isView(value)) {
      /* V8's own: the buffer, then the view on it */
      this.#write(value.buffer);
      this.#ids.set(value, this.#ids.size);
      this.#byte(T.view);
      this.#byte(VIEW_TAGS.find(([name]) => name === typeName(value))?.[1] ?? 0x3f);
      this.#varint(value.byteOffset);
      this.#varint(value.byteLength);
      return this.#varint(0);
    }
    this.#ids.set(value, this.#ids.size);
    const type = typeName(value);
    if (Array.isArray(value)) return this.#array(value);
    if (value instanceof ArrayBuffer) {
      this.#byte(T.arrayBuffer);
      this.#varint(value.byteLength);
      return this.#push(new Uint8Array(value).slice());
    }
    if (type === "Date") {
      this.#byte(T.date);
      return this.#double(value.getTime());
    }
    if (type === "RegExp") {
      this.#byte(T.regexp);
      this.#string(value.source);
      return this.#varint(REGEXP_FLAGS.reduce((f, [c, bit]) => (value.flags.includes(c) ? f | bit : f), 0));
    }
    if (type === "Map") {
      this.#byte(T.beginMap);
      for (const [k, v] of value) {
        this.#write(k);
        this.#write(v);
      }
      this.#byte(T.endMap);
      return this.#varint(value.size * 2);
    }
    if (type === "Set") {
      this.#byte(T.beginSet);
      for (const v of value) this.#write(v);
      this.#byte(T.endSet);
      return this.#varint(value.size);
    }
    if (type === "Boolean") return this.#byte(value.valueOf() ? T.trueObject : T.falseObject);
    if (type === "Number") {
      this.#byte(T.numberObject);
      return this.#double(value.valueOf());
    }
    if (type === "String") {
      this.#byte(T.stringObject);
      return this.#string(value.valueOf());
    }
    if (type === "BigInt") {
      this.#byte(T.bigintObject);
      return this.#bigintDigits(value.valueOf());
    }
    if (type === "Error") return this.#error(value);
    if (type !== "Object" && type !== "Arguments") throw this._getDataCloneError(cloneError(value).message);
    this.#byte(T.beginObject);
    this.#varint(this.#properties(value, Object.keys(value)));
    return;
  }

  /* own enumerable properties, keys first: index keys as numbers */
  #properties(object, keys) {
    for (const key of keys) {
      const index = Number(key);
      if (String(index) === key && index >= 0 && index <= 4294967294) this.#number(index);
      else this.#string(key);
      this.#write(object[key]);
    }
    this.#byte(T.endObject);
    return keys.length;
  }

  #array(array) {
    const length = array.length;
    let dense = true;
    for (let i = 0; i < length && dense; i++) dense = Object.hasOwn(array, i);
    const extra = Object.keys(array).filter((k) => !(String(Number(k)) === k && Number(k) < length));
    if (dense) {
      this.#byte(T.beginDense);
      this.#varint(length);
      for (let i = 0; i < length; i++) this.#write(array[i]);
      for (const key of extra) {
        this.#string(key);
        this.#write(array[key]);
      }
      this.#byte(T.endDense);
    } else {
      this.#byte(T.beginSparse);
      this.#varint(length);
      const keys = Object.keys(array);
      for (const key of keys) {
        const index = Number(key);
        if (String(index) === key && index < length) this.#number(index);
        else this.#string(key);
        this.#write(array[key]);
      }
      this.#byte(T.endSparse);
      this.#varint(keys.length);
      return this.#varint(length);
    }
    this.#varint(extra.length);
    this.#varint(length);
  }

  #error(error) {
    this.#byte(T.error);
    const proto = Object.getPrototypeOf(error);
    const tag = errorPrototypes.find(([ctor]) => proto === ctor.prototype)?.[1];
    if (tag !== undefined) this.#byte(tag);
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (message && "value" in message) {
      this.#byte(ERROR.message);
      this.#string(String(message.value));
    }
    if (typeof error.stack === "string") {
      this.#byte(ERROR.stack);
      this.#string(error.stack);
    }
    if (Object.hasOwn(error, "cause")) {
      this.#byte(ERROR.cause);
      this.#write(error.cause);
    }
    this.#byte(ERROR.end);
  }
}

export class Deserializer {
  #buffer;
  #pos = 0;
  #version = 0;
  #objects = [];
  #transfers = new Map();

  constructor(buffer) {
    if (!ArrayBuffer.isView(buffer)) throw invalidArgType("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
    this.#buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  get buffer() {
    return this.#buffer;
  }

  #byte() {
    if (this.#pos >= this.#buffer.length) throw new Error("Unable to deserialize cloned data.");
    return this.#buffer[this.#pos++];
  }

  #varint() {
    let result = 0, scale = 1, b;
    do {
      b = this.#byte();
      result += (b & 0x7f) * scale;
      scale *= 128;
    } while (b & 0x80);
    return result;
  }

  #double() {
    const d = this.#buffer.readDoubleLE(this.#pos);
    this.#pos += 8;
    return d;
  }

  readHeader() {
    if (this.#buffer[this.#pos] === T.version) {
      this.#pos++;
      this.#version = this.#varint();
      if (this.#version > kLatestVersion) throw new Error("Unable to deserialize cloned data due to invalid or unsupported version.");
    }
    return true;
  }

  getWireFormatVersion() {
    return this.#version;
  }

  readValue() {
    return this.#read();
  }

  readUint32() {
    return this.#varint() >>> 0;
  }

  readUint64() {
    const n = this.#varint();
    return [Math.floor(n / 4294967296) >>> 0, n >>> 0];
  }

  readDouble() {
    return this.#double();
  }

  _readRawBytes(length) {
    const offset = this.#pos;
    this.#pos += length;
    return offset;
  }

  readRawBytes(length) {
    return this.#buffer.subarray(this._readRawBytes(length), this.#pos);
  }

  transferArrayBuffer(id, arrayBuffer) {
    this.#transfers.set(id, arrayBuffer);
  }

  _readHostObject() {
    throw new Error("Unable to deserialize cloned data.");
  }

  #string(tag) {
    const length = this.#varint();
    const bytes = this.#buffer.subarray(this.#pos, this.#pos + length);
    this.#pos += length;
    if (tag === T.oneByte) return bytes.toString("latin1");
    if (tag === T.utf8) return bytes.toString("utf8");
    return bytes.toString("utf16le");
  }

  #readString() {
    let tag = this.#byte();
    while (tag === T.padding) tag = this.#byte();
    return this.#string(tag);
  }

  #bigint() {
    const bitfield = this.#varint();
    const byteLength = Math.floor(bitfield / 2);
    let result = 0n;
    for (let i = byteLength - 8; i >= 0; i -= 8) result = (result << 64n) | this.#buffer.readBigUInt64LE(this.#pos + i);
    this.#pos += byteLength;
    return bitfield & 1 ? -result : result;
  }

  #int32() {
    const z = this.#varint();
    return z & 1 ? -(z + 1) / 2 : z / 2;
  }

  #keyed(target, endTag) {
    for (;;) {
      const tag = this.#buffer[this.#pos];
      if (tag === endTag) {
        this.#pos++;
        return;
      }
      const key = this.#read();
      target[key] = this.#read();
    }
  }

  #read() {
    let tag = this.#byte();
    while (tag === T.padding) tag = this.#byte();
    switch (tag) {
      case T.undefined:
      case T.hole:
        return undefined;
      case T.null:
        return null;
      case T.true:
        return true;
      case T.false:
        return false;
      case T.int32:
        return this.#int32();
      case T.uint32:
        return this.#varint();
      case T.double:
        return this.#double();
      case T.bigint:
        return this.#bigint();
      case T.oneByte:
      case T.twoByte:
      case T.utf8:
        return this.#string(tag);
      case T.ref:
        return this.#objects[this.#varint()];
      case T.beginObject: {
        const object = {};
        this.#objects.push(object);
        this.#keyed(object, T.endObject);
        this.#varint();
        return object;
      }
      case T.beginDense: {
        const length = this.#varint();
        const array = new Array(length);
        this.#objects.push(array);
        for (let i = 0; i < length; i++) {
          if (this.#buffer[this.#pos] === T.hole) {
            this.#pos++;
            continue;
          }
          array[i] = this.#read();
        }
        this.#keyed(array, T.endDense);
        this.#varint();
        this.#varint();
        return array;
      }
      case T.beginSparse: {
        const array = new Array(this.#varint());
        this.#objects.push(array);
        this.#keyed(array, T.endSparse);
        this.#varint();
        this.#varint();
        return array;
      }
      case T.date: {
        const date = new Date(this.#double());
        this.#objects.push(date);
        return date;
      }
      case T.regexp: {
        const source = this.#readString();
        const bits = this.#varint();
        const re = new RegExp(source, REGEXP_FLAGS.filter(([, bit]) => bits & bit).map(([c]) => c).join(""));
        this.#objects.push(re);
        return re;
      }
      case T.beginMap: {
        const map = new Map();
        this.#objects.push(map);
        while (this.#buffer[this.#pos] !== T.endMap) map.set(this.#read(), this.#read());
        this.#pos++;
        this.#varint();
        return map;
      }
      case T.beginSet: {
        const set = new Set();
        this.#objects.push(set);
        while (this.#buffer[this.#pos] !== T.endSet) set.add(this.#read());
        this.#pos++;
        this.#varint();
        return set;
      }
      case T.trueObject:
      case T.falseObject: {
        const b = Object(tag === T.trueObject);
        this.#objects.push(b);
        return b;
      }
      case T.numberObject: {
        const n = Object(this.#double());
        this.#objects.push(n);
        return n;
      }
      case T.stringObject: {
        const s = Object(this.#readString());
        this.#objects.push(s);
        return s;
      }
      case T.bigintObject: {
        const b = Object(this.#bigint());
        this.#objects.push(b);
        return b;
      }
      case T.arrayBuffer: {
        const length = this.#varint();
        const ab = this.#buffer.buffer.slice(this.#buffer.byteOffset + this.#pos, this.#buffer.byteOffset + this.#pos + length);
        this.#pos += length;
        this.#objects.push(ab);
        return this.#maybeView(ab);
      }
      case T.transfer: {
        const ab = this.#transfers.get(this.#varint());
        this.#objects.push(ab);
        return this.#maybeView(ab);
      }
      case T.host: {
        const index = this.#objects.length;
        this.#objects.push(undefined);
        const object = this._readHostObject();
        this.#objects[index] = object;
        return object;
      }
      case T.error:
        return this.#error();
    }
    throw new Error("Unable to deserialize cloned data.");
  }

  /* an ArrayBuffer, or the view V8 wrote after it */
  #maybeView(ab) {
    if (this.#buffer[this.#pos] !== T.view) return ab;
    this.#pos++;
    const subtag = this.#byte();
    const byteOffset = this.#varint();
    const byteLength = this.#varint();
    if (this.#version >= 14) this.#varint();
    const name = VIEW_TAGS.find(([, t]) => t === subtag)?.[0] ?? "DataView";
    const Ctor = globalThis[name];
    const view = name === "DataView" ? new DataView(ab, byteOffset, byteLength) : new Ctor(ab, byteOffset, byteLength / Ctor.BYTES_PER_ELEMENT);
    this.#objects.push(view);
    return view;
  }

  #error() {
    const index = this.#objects.length;
    this.#objects.push(undefined);
    let Ctor = Error;
    let message, stack, cause, hasCause = false;
    for (;;) {
      const tag = this.#byte();
      if (tag === ERROR.end) break;
      if (tag === ERROR.message) message = this.#readString();
      else if (tag === ERROR.stack) stack = this.#readString();
      else if (tag === ERROR.cause) {
        cause = this.#read();
        hasCause = true;
      } else Ctor = errorPrototypes.find(([, t]) => t === tag)?.[0] ?? Error;
    }
    const error = hasCause ? new Ctor(message, { cause }) : new Ctor(message);
    if (message === undefined) delete error.message;
    if (stack !== undefined) Object.defineProperty(error, "stack", { value: stack, writable: true, configurable: true });
    else delete error.stack;
    this.#objects[index] = error;
    return error;
  }
}

/** Node's: Buffers and typed arrays as host objects, their bytes copied (a Buffer's pool not shown). */
export class DefaultSerializer extends Serializer {
  constructor() {
    super();
    this._setTreatArrayBufferViewsAsHostObjects(true);
  }

  _writeHostObject(view) {
    let i = 10;
    if (view.constructor !== Buffer) {
      i = viewTypes.findIndex((Ctor) => Ctor !== null && typeName(view) === Ctor.name);
      if (i === -1) throw this._getDataCloneError(`Unserializable host object: ${typeName(view)}`);
    }
    this.writeUint32(i);
    this.writeUint32(view.byteLength);
    this.writeRawBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
}

export class DefaultDeserializer extends Deserializer {
  _readHostObject() {
    const typeIndex = this.readUint32();
    const Ctor = typeIndex === 10 ? Buffer : viewTypes[typeIndex];
    if (Ctor === undefined || Ctor === null) throw new Error("Unable to deserialize cloned data.");
    const byteLength = this.readUint32();
    const offset = this._readRawBytes(byteLength);
    const bytes = this.buffer.subarray(offset, offset + byteLength);
    if (Ctor === Buffer) return Buffer.from(bytes);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + byteLength);
    if (Ctor === DataView) return new DataView(copy);
    return new Ctor(copy, 0, byteLength / Ctor.BYTES_PER_ELEMENT);
  }
}

export function serialize(value) {
  const serializer = new DefaultSerializer();
  serializer.writeHeader();
  serializer.writeValue(value);
  return serializer.releaseBuffer();
}

export function deserialize(buffer) {
  const deserializer = new DefaultDeserializer(buffer);
  deserializer.readHeader();
  return deserializer.readValue();
}

/* ---- the heap: visaljs's collector's figures, in V8's shapes ------------------------------------ */

const memory = () => {
  const [rss, heapTotal, heapUsed] = processMemory();
  return { rss, heapTotal, heapUsed };
};
const HEAP_LIMIT = 4345298944;  /* V8's default on a 64-bit machine: visaljs's heap has no fixed limit */

export function getHeapStatistics() {
  const { rss, heapTotal, heapUsed } = memory();
  return {
    total_heap_size: heapTotal, total_heap_size_executable: 0, total_physical_size: Math.min(heapTotal, rss),
    total_available_size: HEAP_LIMIT - heapUsed, used_heap_size: heapUsed, heap_size_limit: HEAP_LIMIT, malloced_memory: 0,
    peak_malloced_memory: 0, does_zap_garbage: 0, number_of_native_contexts: 1, number_of_detached_contexts: 0,
    total_global_handles_size: 0, used_global_handles_size: 0, external_memory: 0,
  };
}

/* V8's spaces: visaljs's heap is one, reported as old_space */
const SPACES = ["read_only_space", "new_space", "old_space", "code_space", "shared_space", "trusted_space", "shared_trusted_space",
  "new_large_object_space", "large_object_space", "code_large_object_space", "shared_large_object_space",
  "shared_trusted_large_object_space", "trusted_large_object_space"];  /* V8 13.6's, as Node 24 lists them */

export function getHeapSpaceStatistics() {
  const { heapTotal, heapUsed } = memory();
  return SPACES.map((space_name) => {
    const old = space_name === "old_space";
    return {
      space_name, space_size: old ? heapTotal : 0, space_used_size: old ? heapUsed : 0, space_available_size: old ? heapTotal - heapUsed : 0,
      physical_space_size: old ? heapTotal : 0,
    };
  });
}

export function getHeapCodeStatistics() {
  return { code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0, cpu_profiler_metadata_size: 0 };
}

export function getCppHeapStatistics(detailLevel = "detailed") {
  if (detailLevel !== "brief" && detailLevel !== "detailed") {
    throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'type' must be one of: 'brief', 'detailed'. Received '${detailLevel}'`);
  }
  return { committed_size_bytes: 0, resident_size_bytes: 0, used_size_bytes: 0, space_statistics: [], type_names: [], detail_level: detailLevel };
}

export function getHeapSnapshot() {
  throw notSupported("v8.getHeapSnapshot (V8's heap snapshot format)");
}

export function writeHeapSnapshot() {
  throw notSupported("v8.writeHeapSnapshot (V8's heap snapshot format)");
}

export function queryObjects() {
  throw notSupported("v8.queryObjects");
}

/** A limit on heap snapshots Node would write near the heap's limit: none are written. */
export function setHeapSnapshotNearHeapLimit(limit) {
  if (typeof limit !== "number") throw invalidArgType("limit", "of type number", limit);
}

/* ---- the rest ---------------------------------------------------------------------------------------- */

/** A number for the code cache's format: fixed, as a compiled program has no code cache. */
export function cachedDataVersionTag() {
  return 2596627580;
}

/** Whether V8 keeps a string as one byte per character: its characters all fit in Latin-1. */
export function isStringOneByteRepresentation(content) {
  validateString(content, "content");
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) > 0xff) return false;
  return true;
}

/** V8's flags: a compiled program has no V8 to set them on. */
export function setFlagsFromString(flags) {
  validateString(flags, "flags");
}

export function takeCoverage() {}
export function stopCoverage() {}

/** GC profiling: the collections aren't reported by visaljs's collector (statistics is empty). */
export class GCProfiler {
  #startTime = 0;

  start() {
    this.#startTime = Date.now();
  }

  stop() {
    const endTime = Date.now();
    return { version: 1, startTime: this.#startTime, statistics: [], endTime };
  }
}

/* promise hooks: visaljs's promises run none */
const stop = () => {};
export const promiseHooks = {
  createHook: () => stop,
  onInit: () => stop,
  onBefore: () => stop,
  onAfter: () => stop,
  onSettled: () => stop,
};

const notBuilding = () => codeError(Error, "ERR_NOT_BUILDING_SNAPSHOT", "Operation cannot be invoked when not building startup snapshot");
export const startupSnapshot = {
  addSerializeCallback() {
    throw notBuilding();
  },
  addDeserializeCallback() {
    throw notBuilding();
  },
  setDeserializeMainFunction() {
    throw notBuilding();
  },
  isBuildingSnapshot: () => 0,  /* Node's: a flag from its binding, a number */
};

export default {
  cachedDataVersionTag, getHeapSnapshot, getHeapStatistics, getHeapSpaceStatistics, getHeapCodeStatistics, getCppHeapStatistics,
  setFlagsFromString, Serializer, Deserializer, DefaultSerializer, DefaultDeserializer, deserialize, takeCoverage, stopCoverage, serialize,
  writeHeapSnapshot, promiseHooks, queryObjects, startupSnapshot, setHeapSnapshotNearHeapLimit, GCProfiler, isStringOneByteRepresentation,
};
