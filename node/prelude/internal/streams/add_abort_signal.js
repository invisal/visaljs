import * as __internal_errors from "./errors.js";
import * as __internal_util from "./validators.js";
import * as __internal_streams_utils from "./utils.js";
import * as __internal_streams_end_of_stream from "./end_of_stream.js";

const {
  AbortError,
  codes: {
    ERR_INVALID_ARG_TYPE,
  },
} = __internal_errors;

const {
  isNodeStream,
  isWebStream,
  kControllerErrorFunction,
} = __internal_streams_utils;

const { eos } = __internal_streams_end_of_stream;
const { addAbortListener } = __internal_util;

// This method is inlined here for readable-stream
// It also does not allow for signal to not exist on the stream
// https://github.com/nodejs/node/pull/36061#discussion_r533718029
const validateAbortSignal = (signal, name) => {
  if (typeof signal !== 'object' ||
       !('aborted' in signal)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
};

export function addAbortSignal(signal, stream) {
  validateAbortSignal(signal, 'signal');
  if (!isNodeStream(stream) && !isWebStream(stream)) {
    throw new ERR_INVALID_ARG_TYPE('stream', ['ReadableStream', 'WritableStream', 'Stream'], stream);
  }
  return addAbortSignalNoValidate(signal, stream);
};

export function addAbortSignalNoValidate(signal, stream) {
  if (typeof signal !== 'object' || !('aborted' in signal)) {
    return stream;
  }
  const onAbort = isNodeStream(stream) ?
    () => {
      stream.destroy(new AbortError(undefined, { cause: signal.reason }));
    } :
    () => {
      stream[kControllerErrorFunction](new AbortError(undefined, { cause: signal.reason }));
    };
  if (signal.aborted) {
    onAbort();
  } else {
    const disposable = addAbortListener(signal, onAbort);
    eos(stream, disposable[Symbol.dispose]);
  }
  return stream;
};
