// util.getSystemErrorName, getSystemErrorMessage and getSystemErrorMap: libuv's errors, by code.
// Linked into programs that name them (internal/features.js).
import { errnoMap, errnoMessage, errnoName } from "visaljs:host";
import { codeError, invalidArgType } from "./errors.js";
import { features } from "./features.js";

function validateErrno(err) {
  if (typeof err !== "number") throw invalidArgType("err", "of type number", err);
  if (!Number.isInteger(err)) {
    const e = codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "err" is out of range. It must be an integer. Received ${err}`);
    throw e;
  }
  if (err >= 0) {
    throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "err" is out of range. It must be a negative integer. Received ${err}`);
  }
}

/** "ENOENT" for -2. */
function getSystemErrorName(err) {
  validateErrno(err);
  const entry = errnoMap().find(([code]) => code === err);
  return entry ? entry[1] : errnoName(err) === "UNKNOWN" ? `Unknown system error ${err}` : errnoName(err);
}

/** "no such file or directory" for -2. */
function getSystemErrorMessage(err) {
  validateErrno(err);
  const entry = errnoMap().find(([code]) => code === err);
  return entry ? entry[2] : errnoMessage(err) === "unknown error" ? `Unknown system error ${err}` : errnoMessage(err);
}

/** Every system error: code → [name, message]. */
function getSystemErrorMap() {
  return new Map(errnoMap().map(([code, name, message]) => [code, [name, message]]));
}

Object.assign(features, { getSystemErrorName, getSystemErrorMessage, getSystemErrorMap });
