// node:util/types (and util.types): what a value is inside, as V8 answers it — Symbol.toStringTag,
// prototypes and subclassing don't change the answer. The runtime gives each object's internal
// kind (utilTypeTag, runtime/src/util_types.c); these compare it. Modules are bundled into one
// program, so there are no module namespace objects to recognize.
import { utilTypeTag } from "visaljs:host";
import { kKeyType } from "./internal/crypto/key_type.js";

const tag = (value) => (typeof value === "object" || typeof value === "function") && value !== null ? utilTypeTag(value) : "";

const TYPED_ARRAYS = new Set([
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "BigInt64Array", "BigUint64Array", "Float16Array", "Float32Array", "Float64Array",
]);

export const isExternal = (_value) => false;
export const isDate = (value) => tag(value) === "Date";
export const isArgumentsObject = (value) => tag(value) === "Arguments";
export const isBigIntObject = (value) => tag(value) === "BigIntObject";
export const isBooleanObject = (value) => tag(value) === "BooleanObject";
export const isNumberObject = (value) => tag(value) === "NumberObject";
export const isStringObject = (value) => tag(value) === "StringObject";
export const isSymbolObject = (value) => tag(value) === "SymbolObject";
export function isBoxedPrimitive(value) {
  const t = tag(value);
  return t === "NumberObject" || t === "StringObject" || t === "BooleanObject" || t === "BigIntObject" || t === "SymbolObject";
}
export const isNativeError = (value) => tag(value) === "Error";
export const isRegExp = (value) => tag(value) === "RegExp";
export const isAsyncFunction = (value) => {
  const t = tag(value);
  return t === "AsyncFunction" || t === "AsyncGeneratorFunction";
};
export const isGeneratorFunction = (value) => {
  const t = tag(value);
  return t === "GeneratorFunction" || t === "AsyncGeneratorFunction";
};
export const isGeneratorObject = (value) => {
  const t = tag(value);
  return t === "Generator" || t === "AsyncGenerator";
};
export const isPromise = (value) => tag(value) === "Promise";
export const isMap = (value) => tag(value) === "Map";
export const isSet = (value) => tag(value) === "Set";
export const isMapIterator = (value) => tag(value) === "Map Iterator";
export const isSetIterator = (value) => tag(value) === "Set Iterator";
export const isWeakMap = (value) => tag(value) === "WeakMap";
export const isWeakSet = (value) => tag(value) === "WeakSet";
export const isArrayBuffer = (value) => tag(value) === "ArrayBuffer";
export const isDataView = (value) => tag(value) === "DataView";
export const isSharedArrayBuffer = (value) => tag(value) === "SharedArrayBuffer";
export const isProxy = (value) => tag(value) === "Proxy";
export const isModuleNamespaceObject = (_value) => false;
export const isAnyArrayBuffer = (value) => {
  const t = tag(value);
  return t === "ArrayBuffer" || t === "SharedArrayBuffer";
};
export const isCryptoKey = (value) => tag(value) === "CryptoKey";
export const isKeyObject = (value) => value != null && value[kKeyType] !== undefined;
export const isArrayBufferView = (value) => {
  const t = tag(value);
  return t === "DataView" || TYPED_ARRAYS.has(t);
};
export const isTypedArray = (value) => TYPED_ARRAYS.has(tag(value));
export const isUint8Array = (value) => tag(value) === "Uint8Array";
export const isUint8ClampedArray = (value) => tag(value) === "Uint8ClampedArray";
export const isUint16Array = (value) => tag(value) === "Uint16Array";
export const isUint32Array = (value) => tag(value) === "Uint32Array";
export const isInt8Array = (value) => tag(value) === "Int8Array";
export const isInt16Array = (value) => tag(value) === "Int16Array";
export const isInt32Array = (value) => tag(value) === "Int32Array";
export const isFloat16Array = (value) => tag(value) === "Float16Array";
export const isFloat32Array = (value) => tag(value) === "Float32Array";
export const isFloat64Array = (value) => tag(value) === "Float64Array";
export const isBigInt64Array = (value) => tag(value) === "BigInt64Array";
export const isBigUint64Array = (value) => tag(value) === "BigUint64Array";

/* Node's order, which Object.keys(util.types) shows */
export default {
  isArgumentsObject, isArrayBuffer, isAsyncFunction, isBigIntObject, isBooleanObject, isDataView, isDate, isExternal,
  isGeneratorFunction, isGeneratorObject, isMap, isMapIterator, isModuleNamespaceObject, isNativeError, isNumberObject,
  isPromise, isProxy, isRegExp, isSet, isSetIterator, isSharedArrayBuffer, isStringObject, isSymbolObject, isWeakMap,
  isWeakSet, isAnyArrayBuffer, isBoxedPrimitive, isArrayBufferView, isTypedArray, isUint8Array, isUint8ClampedArray,
  isUint16Array, isUint32Array, isInt8Array, isInt16Array, isInt32Array, isFloat16Array, isFloat32Array,
  isFloat64Array, isBigInt64Array, isBigUint64Array, isKeyObject, isCryptoKey,
};
