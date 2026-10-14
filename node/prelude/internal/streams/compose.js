import * as __internal_streams_pipeline from "./pipeline.js";
import * as __internal_streams_duplex from "./duplex.js";
import * as __internal_streams_destroy from "./destroy.js";
import * as __internal_streams_utils from "./utils.js";
import * as __internal_errors from "./errors.js";
import * as __internal_streams_end_of_stream from "./end_of_stream.js";

const { pipeline } = __internal_streams_pipeline;
const Duplex = __internal_streams_duplex.default;
const { destroyer } = __internal_streams_destroy;
const {
  isNodeStream,
  isReadable,
  isWritable,
  isWebStream,
  isTransformStream,
  isWritableStream,
  isReadableStream,
} = __internal_streams_utils;
const {
  AbortError,
  codes: {
    ERR_INVALID_ARG_VALUE,
    ERR_MISSING_ARGS,
  },
} = __internal_errors;
const { eos } = __internal_streams_end_of_stream;

export default function compose(...streams) {
  if (streams.length === 0) {
    throw new ERR_MISSING_ARGS('streams');
  }

  if (streams.length === 1) {
    return Duplex.from(streams[0]);
  }

  const orgStreams = streams.slice();

  if (typeof streams[0] === 'function') {
    streams[0] = Duplex.from(streams[0]);
  }

  if (typeof streams[streams.length - 1] === 'function') {
    const idx = streams.length - 1;
    streams[idx] = Duplex.from(streams[idx]);
  }

  for (let n = 0; n < streams.length; ++n) {
    if (!isNodeStream(streams[n]) && !isWebStream(streams[n])) {
      // TODO(ronag): Add checks for non streams.
      continue;
    }
    if (
      n < streams.length - 1 &&
      !(
        isReadable(streams[n]) ||
        isReadableStream(streams[n]) ||
        isTransformStream(streams[n])
      )
    ) {
      throw new ERR_INVALID_ARG_VALUE(
        `streams[${n}]`,
        orgStreams[n],
        'must be readable',
      );
    }
    if (
      n > 0 &&
      !(
        isWritable(streams[n]) ||
        isWritableStream(streams[n]) ||
        isTransformStream(streams[n])
      )
    ) {
      throw new ERR_INVALID_ARG_VALUE(
        `streams[${n}]`,
        orgStreams[n],
        'must be writable',
      );
    }
  }

  let ondrain;
  let onfinish;
  let onclose;
  let d;

  function onfinished(err) {
    const cb = onclose;
    onclose = null;

    if (cb) {
      cb(err);
    } else if (err) {
      d.destroy(err);
    } else if (!readable && !writable) {
      d.destroy();
    }
  }

  const head = streams[0];
  const tail = pipeline(streams, onfinished);

  const writable = !!(
    isWritable(head) ||
    isWritableStream(head) ||
    isTransformStream(head)
  );
  const readable = !!(
    isReadable(tail) ||
    isReadableStream(tail) ||
    isTransformStream(tail)
  );

  // TODO(ronag): Avoid double buffering.
  // Implement Writable/Readable/Duplex traits.
  // See, https://github.com/nodejs/node/pull/33515.
  d = new Duplex({
    // TODO (ronag): highWaterMark?
    writableObjectMode: !!head?.writableObjectMode,
    readableObjectMode: !!tail?.readableObjectMode,
    writable,
    readable,
  });

  if (writable) {
    if (isNodeStream(head)) {
      d._write = function(chunk, encoding, callback) {
        if (head.write(chunk, encoding)) {
          callback();
        } else {
          ondrain = callback;
        }
      };

      d._final = function(callback) {
        head.end();
        onfinish = callback;
      };

      head.on('drain', function() {
        if (ondrain) {
          const cb = ondrain;
          ondrain = null;
          cb();
        }
      });
    } else if (isWebStream(head)) {
      const writable = isTransformStream(head) ? head.writable : head;
      const writer = writable.getWriter();

      d._write = async function(chunk, encoding, callback) {
        try {
          await writer.ready;
          writer.write(chunk).catch(() => {});
          callback();
        } catch (err) {
          callback(err);
        }
      };

      d._final = async function(callback) {
        try {
          await writer.ready;
          writer.close().catch(() => {});
          onfinish = callback;
        } catch (err) {
          callback(err);
        }
      };
    }

    const toRead = isTransformStream(tail) ? tail.readable : tail;

    eos(toRead, () => {
      if (onfinish) {
        const cb = onfinish;
        onfinish = null;
        cb();
      }
    });
  }

  if (readable) {
    if (isNodeStream(tail)) {
      d._read = function() {
        tail.resume();
      };

      tail.on('data', function(chunk) {
        if (!d.push(chunk)) {
          tail.pause();
        }
      });

      tail.on('end', function() {
        d.push(null);
      });
    } else if (isWebStream(tail)) {
      const readable = isTransformStream(tail) ? tail.readable : tail;
      const reader = readable.getReader();
      d._read = async function() {
        while (true) {
          try {
            const { value, done } = await reader.read();

            if (done) {
              d.push(null);
              return;
            }

            if (!d.push(value)) {
              return;
            }
          } catch {
            return;
          }
        }
      };
    }
  }

  d._destroy = function(err, callback) {
    if (!err && onclose !== null) {
      err = new AbortError();
    }

    ondrain = null;
    onfinish = null;

    if (isNodeStream(tail)) {
      destroyer(tail, err);
    }

    if (onclose === null) {
      callback(err);
    } else {
      onclose = callback;
    }
  };

  return d;
};
