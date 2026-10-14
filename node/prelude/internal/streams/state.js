import * as __internal_validators from "./validators.js";
import * as __internal_errors from "./errors.js";

const { validateInteger } = __internal_validators;

const { ERR_INVALID_ARG_VALUE } = __internal_errors.codes;

// TODO (fix): For some reason Windows CI fails with bigger hwm.
let defaultHighWaterMarkBytes = process.platform === 'win32' ? 16 * 1024 : 64 * 1024;
let defaultHighWaterMarkObjectMode = 16;

function highWaterMarkFrom(options, isDuplex, duplexKey) {
  return options.highWaterMark != null ? options.highWaterMark :
    isDuplex ? options[duplexKey] : null;
}

function getDefaultHighWaterMark(objectMode) {
  return objectMode ? defaultHighWaterMarkObjectMode : defaultHighWaterMarkBytes;
}

function setDefaultHighWaterMark(objectMode, value) {
  validateInteger(value, 'value', 0);
  if (objectMode) {
    defaultHighWaterMarkObjectMode = value;
  } else {
    defaultHighWaterMarkBytes = value;
  }
}

function getHighWaterMark(state, options, duplexKey, isDuplex) {
  const hwm = highWaterMarkFrom(options, isDuplex, duplexKey);
  if (hwm != null) {
    if (!Number.isInteger(hwm) || hwm < 0) {
      const name = isDuplex ? `options.${duplexKey}` : 'options.highWaterMark';
      throw new ERR_INVALID_ARG_VALUE(name, hwm);
    }
    return Math.floor(hwm);
  }

  // Default value
  return getDefaultHighWaterMark(state.objectMode);
}

export {
  getHighWaterMark,
  getDefaultHighWaterMark,
  setDefaultHighWaterMark,
};
