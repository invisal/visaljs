// node:sea: a visaljs binary isn't one of Node's single executable applications: isSea() is false,
// and the asset calls throw ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION, as Node's do outside one.
import { codeError } from "./internal/errors.js";

const notInSea = () =>
  codeError(Error, "ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION", "Operation cannot be invoked when not in a single-executable application");

export const isSea = () => false;

export function getAsset() {
  throw notInSea();
}
export function getAssetAsBlob() {
  throw notInSea();
}
export function getRawAsset() {
  throw notInSea();
}
export function getAssetKeys() {
  throw notInSea();
}

export default { isSea, getAsset, getAssetAsBlob, getRawAsset, getAssetKeys };
