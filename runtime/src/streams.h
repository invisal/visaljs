/* streams.h — what streams.c (ReadableStream) and writable.c (WritableStream, TransformStream,
 * pipeTo) share, inside the streams component (runtime-private). */
#ifndef JS_STREAMS_H
#define JS_STREAMS_H

#include "js_web.h"

enum { JS_RS_READABLE, JS_RS_CLOSED, JS_RS_ERRORED };

/* A readable stream with a C source whose start waits for `start` (a promise, or undefined for
 * none), with a highWaterMark and a size function (undefined for 1 per chunk). */
JS_WARN_UNUSED JSValue js_rs_new(JSContext *ctx, const JSStreamSource *source, JSValue data, double hwm, JSValue size, JSValue start);
int js_rs_state(JSValue stream);
JSValue js_rs_stored_error(JSValue stream);
bool js_rs_locked(JSValue stream);
JSValue js_rs_controller(JSValue stream);
/* ReadableStreamCancel: a promise. */
JS_WARN_UNUSED JSValue js_rs_cancel(JSContext *ctx, JSValue stream, JSValue reason);

/* The default controller's operations (the stream's own checks included). */
bool js_rs_can_close_or_enqueue(JSValue controller);
bool js_rs_has_backpressure(JSValue controller);
JSValue js_rs_desired_size(JSValue controller);  /* a number, or null when errored */

/* A default reader: acquired (JS_EXCEPTION when the stream is locked), read (a promise of
 * { value, done }), its closed promise, released. */
JS_WARN_UNUSED JSValue js_rs_reader(JSContext *ctx, JSValue stream);
JS_WARN_UNUSED JSValue js_rs_read(JSContext *ctx, JSValue reader);
JSValue js_rs_reader_closed(JSValue reader);
void js_rs_release(JSContext *ctx, JSValue reader);

/* Promise helpers. */
JS_WARN_UNUSED JSValue js_streams_resolved(JSContext *ctx, JSValue v);
JS_WARN_UNUSED JSValue js_streams_rejected(JSContext *ctx, JSValue reason);
/* A result as a promise: JS_EXCEPTION becomes a rejection, a value is resolved. */
JS_WARN_UNUSED JSValue js_streams_promise_of(JSContext *ctx, JSValue r);
void js_streams_reject_handled(JSContext *ctx, JSValue promise, JSValue reason);
/* ERR_INVALID_STATE's error, as a value. */
JS_WARN_UNUSED JSValue js_streams_invalid_state(JSContext *ctx, const char *what);

/* writable.c: installs WritableStream, its writer and controller, TransformStream and its
 * controller; streams.c's install calls it. pipeTo and pipeThrough are writable.c's. */
void js_writable_streams_install(JSContext *ctx, JSObject *global);
JSValue js_rs_pipe_to(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);
JSValue js_rs_pipe_through(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);

#endif /* JS_STREAMS_H */
