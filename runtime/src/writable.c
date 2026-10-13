/* WritableStream and TransformStream (WHATWG Streams §5, §6), and ReadableStream's pipeTo and
 * pipeThrough (§4.9.4), in the streams component, as Node has them. The
 * algorithms are the standard's, named as it names them: a writable stream's queue holds the
 * chunks written and the close request (EMPTY), its controller hands them to the sink one at a
 * time, and backpressure follows the queue's size against the highWaterMark. A transform stream
 * is a writable whose sink runs the transformer into a readable (streams.c), with the standard's
 * backpressure handshake between the two. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_promise.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"
#include "streams.h"

/* A failure's -1, after the call that threw (the throwers' results must be used). */
static int fail(JSValue thrown) {
    (void)thrown;
    return -1;
}

enum { W_WRITABLE, W_CLOSED, W_ERRORING, W_ERRORED };

typedef struct WStream {
    JSObject obj;
    JSValue  controller, writer, stored_error;
    JSValue  in_flight_write, close_request, in_flight_close;  /* promises, or undefined */
    JSValue  abort_promise, abort_reason;  /* the pending abort request: its promise (or undefined) and reason */
    JSValue  write_requests;               /* promises, oldest first: an array */
    uint8_t  state, backpressure, abort_was_erroring;
} WStream;

/* A C sink (a transform stream's): write, close and abort return a promise, a value or JS_EXCEPTION. */
typedef struct Sink {
    JSValue (*write)(JSContext *ctx, JSValue data, JSValue chunk);
    JSValue (*close)(JSContext *ctx, JSValue data);
    JSValue (*abort)(JSContext *ctx, JSValue data, JSValue reason);
} Sink;

typedef struct WController {
    JSObject obj;
    JSValue  stream;
    JSValue *queue;  /* chunk, size; …: a chunk EMPTY is the close request */
    uint32_t head, n, cap;
    double   queue_size, high_water_mark;
    JSValue  size, sink, write, close, abort;  /* the strategy's size; the sink and its methods (or undefined) */
    JSValue  signal;  /* an AbortSignal, aborted when the stream is */
    const Sink *native;
    uint8_t  started;
} WController;

typedef struct Writer {
    JSObject obj;
    JSValue  stream;  /* undefined once released */
    JSValue  ready, closed;
} Writer;

typedef struct TStream {
    JSObject obj;
    JSValue  readable, writable, controller;
    JSValue  backpressure_change;  /* a promise, or undefined */
    uint8_t  backpressure;         /* 2: not set yet */
} TStream;

typedef struct TController {
    JSObject obj;
    JSValue  stream;
    JSValue  transformer, transform, flush, cancel;
    JSValue  finish;  /* the promise a close, an abort or a cancel settles; undefined until one starts */
} TController;

static void wstream_visit(JSCell *c, JSTracer *trc) {
    WStream *s = (WStream *)c;
    js_trace_value(trc, s->controller);
    js_trace_value(trc, s->writer);
    js_trace_value(trc, s->stored_error);
    js_trace_value(trc, s->in_flight_write);
    js_trace_value(trc, s->close_request);
    js_trace_value(trc, s->in_flight_close);
    js_trace_value(trc, s->abort_promise);
    js_trace_value(trc, s->abort_reason);
    js_trace_value(trc, s->write_requests);
}
static void wcontroller_visit(JSCell *c, JSTracer *trc) {
    WController *k = (WController *)c;
    js_trace_value(trc, k->stream);
    for (uint32_t i = k->head; i < k->n; i++) js_trace_value(trc, k->queue[i]);
    js_trace_value(trc, k->size);
    js_trace_value(trc, k->sink);
    js_trace_value(trc, k->write);
    js_trace_value(trc, k->close);
    js_trace_value(trc, k->abort);
    js_trace_value(trc, k->signal);
}
static void wcontroller_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    free(((WController *)c)->queue);
}
static void writer_visit(JSCell *c, JSTracer *trc) {
    Writer *w = (Writer *)c;
    js_trace_value(trc, w->stream);
    js_trace_value(trc, w->ready);
    js_trace_value(trc, w->closed);
}
static void tstream_visit(JSCell *c, JSTracer *trc) {
    TStream *t = (TStream *)c;
    js_trace_value(trc, t->readable);
    js_trace_value(trc, t->writable);
    js_trace_value(trc, t->controller);
    js_trace_value(trc, t->backpressure_change);
}
static void tcontroller_visit(JSCell *c, JSTracer *trc) {
    TController *k = (TController *)c;
    js_trace_value(trc, k->stream);
    js_trace_value(trc, k->transformer);
    js_trace_value(trc, k->transform);
    js_trace_value(trc, k->flush);
    js_trace_value(trc, k->cancel);
    js_trace_value(trc, k->finish);
}

static const JSClass wstream_class = { "WritableStream", sizeof(WStream), NULL, NULL, NULL, NULL, wstream_visit, NULL, NULL };
static const JSClass wcontroller_class = { "WritableStreamDefaultController", sizeof(WController), NULL, NULL, NULL, NULL, wcontroller_visit, wcontroller_finalize, NULL };
static const JSClass writer_class = { "WritableStreamDefaultWriter", sizeof(Writer), NULL, NULL, NULL, NULL, writer_visit, NULL, NULL };
static const JSClass tstream_class = { "TransformStream", sizeof(TStream), NULL, NULL, NULL, NULL, tstream_visit, NULL, NULL };
static const JSClass tcontroller_class = { "TransformStreamDefaultController", sizeof(TController), NULL, NULL, NULL, NULL, tcontroller_visit, NULL, NULL };

#define AS(kind, type) \
    static type *as_##kind(JSValue v) { return js_is_object(v) && js_as_object(v)->shape->cls == &kind##_class ? (type *)js_as_object(v) : NULL; }
AS(wstream, WStream)
AS(wcontroller, WController)
AS(writer, Writer)
AS(tstream, TStream)
AS(tcontroller, TController)

#define STORE(o, field, v) js_store(ctx, &(o)->obj.cell, &(o)->field, (v))

static JSValue new_promise(JSContext *ctx) { return js_new_promise(ctx); }
static void resolve(JSContext *ctx, JSValue p, JSValue v) { js_promise_resolve_internal(ctx, p, v); }
static void reject(JSContext *ctx, JSValue p, JSValue e) { js_promise_reject_internal(ctx, p, e); }
static bool pending(JSValue p) { return js_is_promise(p) && js_as_promise(p)->state == JS_PROMISE_PENDING; }
static void mark_handled(JSValue p) {
    if (js_is_promise(p)) js_as_promise(p)->is_handled = 1;
}
static JSValue type_error(JSContext *ctx, const char *msg) { return js_new_error(ctx, JS_TYPE_ERROR, js_new_string_cstr(ctx, msg)); }

/* then(on_fulfilled, on_rejected) with C closures over `data`; `derived` gets the result (or undefined). */
static void then(JSContext *ctx, JSValue p, JSNativeFn on_fulfilled, JSNativeFn on_rejected, JSValue data, JSValue derived) {
    js_promise_then_internal(ctx, p, on_fulfilled ? js_new_closure_native(ctx, on_fulfilled, 1, data) : JS_UNDEFINED,
                             on_rejected ? js_new_closure_native(ctx, on_rejected, 1, data) : JS_UNDEFINED, derived);
}

/* ---- WritableStream algorithms (§5.5) ------------------------------------------------------- */

static WController *controller_of(WStream *s) { return as_wcontroller(s->controller); }
static bool close_queued_or_in_flight(WStream *s) { return !js_is_undefined(s->close_request) || !js_is_undefined(s->in_flight_close); }
static bool has_operation_in_flight(WStream *s) { return !js_is_undefined(s->in_flight_write) || !js_is_undefined(s->in_flight_close); }

static void queue_push(JSContext *ctx, WController *k, JSValue chunk, double size) {
    if (k->head > 0 && k->n == k->cap) {
        memmove(k->queue, k->queue + k->head, (k->n - k->head) * sizeof *k->queue);
        k->n -= k->head;
        k->head = 0;
    }
    if (k->n + 2 > k->cap) {
        uint32_t cap = k->cap ? k->cap * 2 : 16;
        JSValue *q = realloc(k->queue, cap * sizeof *q);
        if (!q) js_fatal("out of memory queueing a chunk");
        k->queue = q;
        k->cap = cap;
    }
    k->queue[k->n++] = chunk;  /* barrier: below */
    js_write_barrier(ctx, &k->obj.cell, NULL, chunk);
    k->queue[k->n++] = js_number(size);  /* barrier: not a cell */
    k->queue_size += size;
}
static bool queue_empty(const WController *k) { return k->head == k->n; }
static JSValue queue_peek(const WController *k) { return k->queue[k->head]; }
static void queue_dequeue(WController *k) {
    k->queue_size -= js_as_number(k->queue[k->head + 1]);
    if (k->queue_size < 0) k->queue_size = 0;
    k->head += 2;
    if (k->head == k->n) k->head = k->n = 0;
}
static void queue_reset(WController *k) {
    k->head = k->n = 0;
    k->queue_size = 0;
}

static void clear_algorithms(JSContext *ctx, WController *k) {
    STORE(k, write, JS_UNDEFINED);
    STORE(k, close, JS_UNDEFINED);
    STORE(k, abort, JS_UNDEFINED);
    STORE(k, size, JS_UNDEFINED);
    k->native = NULL;
}

static double desired_size(WController *k) { return k->high_water_mark - k->queue_size; }

static void ensure_ready_rejected(JSContext *ctx, Writer *w, JSValue error) {
    if (!pending(w->ready)) STORE(w, ready, new_promise(ctx));
    js_streams_reject_handled(ctx, w->ready, error);
}

static void ensure_closed_rejected(JSContext *ctx, Writer *w, JSValue error) {
    if (!pending(w->closed)) STORE(w, closed, new_promise(ctx));
    js_streams_reject_handled(ctx, w->closed, error);
}

static void update_backpressure(JSContext *ctx, WStream *s, bool bp) {
    Writer *w = as_writer(s->writer);
    if (w && bp != (bool)s->backpressure) {
        if (bp) STORE(w, ready, new_promise(ctx));
        else resolve(ctx, w->ready, JS_UNDEFINED);
    }
    s->backpressure = bp;
}

static void reject_close_and_closed_if_needed(JSContext *ctx, WStream *s) {
    if (!js_is_undefined(s->close_request)) {
        reject(ctx, s->close_request, s->stored_error);
        STORE(s, close_request, JS_UNDEFINED);
    }
    Writer *w = as_writer(s->writer);
    if (w) js_streams_reject_handled(ctx, w->closed, s->stored_error);
}

BUILTIN(abort_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue data = js_closure_data(callee);  /* [stream, abort promise] */
    WStream *s = as_wstream(js_get_elem(ctx, data, js_int32(0)));
    resolve(ctx, js_get_elem(ctx, data, js_int32(1)), JS_UNDEFINED);
    reject_close_and_closed_if_needed(ctx, s);
    return JS_UNDEFINED;
}

BUILTIN(abort_rejected) {
    (void)this_val, (void)new_target;
    JSValue data = js_closure_data(callee);
    WStream *s = as_wstream(js_get_elem(ctx, data, js_int32(0)));
    reject(ctx, js_get_elem(ctx, data, js_int32(1)), ARG(0));
    reject_close_and_closed_if_needed(ctx, s);
    return JS_UNDEFINED;
}

/* A sink method's result as a promise (a C sink's or the JS sink's). */
static JSValue sink_call(JSContext *ctx, WController *k, int which, JSValue arg) {
    JSValue kv = js_object_value(&k->obj);
    if (k->native) {
        JSValue r = which == 0 ? k->native->write(ctx, k->sink, arg) : which == 1 ? k->native->close(ctx, k->sink) : k->native->abort(ctx, k->sink, arg);
        return js_streams_promise_of(ctx, r);
    }
    JSValue f = which == 0 ? k->write : which == 1 ? k->close : k->abort;
    if (js_is_undefined(f)) return js_streams_resolved(ctx, JS_UNDEFINED);
    JSValue args[2] = { arg, kv };
    JSValue r = which == 1 ? js_call(ctx, f, k->sink, 0, NULL) : js_call(ctx, f, k->sink, which == 0 ? 2 : 1, args);
    return js_streams_promise_of(ctx, r);
}

static void finish_erroring(JSContext *ctx, WStream *s) {
    s->state = W_ERRORED;
    WController *k = controller_of(s);
    queue_reset(k);
    JSValue requests = s->write_requests;
    STORE(s, write_requests, js_new_array(ctx, 0));
    for (uint32_t i = 0; i < js_array_length(js_as_object(requests)); i++)
        reject(ctx, js_get_elem(ctx, requests, js_int32((int32_t)i)), s->stored_error);
    if (js_is_undefined(s->abort_promise)) {
        reject_close_and_closed_if_needed(ctx, s);
        return;
    }
    JSValue abort_promise = s->abort_promise, reason = s->abort_reason;
    bool was_erroring = s->abort_was_erroring;
    STORE(s, abort_promise, JS_UNDEFINED);
    STORE(s, abort_reason, JS_UNDEFINED);
    if (was_erroring) {
        reject(ctx, abort_promise, s->stored_error);
        reject_close_and_closed_if_needed(ctx, s);
        return;
    }
    JSValue p = sink_call(ctx, k, 2, reason);
    clear_algorithms(ctx, k);
    JSValue items[2] = { js_object_value(&s->obj), abort_promise };
    then(ctx, p, abort_fulfilled, abort_rejected, js_new_array_from(ctx, items, 2), JS_UNDEFINED);
}

static void start_erroring(JSContext *ctx, WStream *s, JSValue reason) {
    s->state = W_ERRORING;
    STORE(s, stored_error, reason);
    Writer *w = as_writer(s->writer);
    if (w) ensure_ready_rejected(ctx, w, reason);
    if (!has_operation_in_flight(s) && controller_of(s)->started) finish_erroring(ctx, s);
}

static void deal_with_rejection(JSContext *ctx, WStream *s, JSValue error) {
    if (s->state == W_WRITABLE) start_erroring(ctx, s, error);
    else finish_erroring(ctx, s);
}

static void error_if_needed(JSContext *ctx, WController *k, JSValue error) {
    WStream *s = as_wstream(k->stream);
    if (s->state != W_WRITABLE) return;
    clear_algorithms(ctx, k);
    start_erroring(ctx, s, error);
}

static void advance_queue_if_needed(JSContext *ctx, WController *k);

BUILTIN(write_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    WController *k = as_wcontroller(js_closure_data(callee));
    WStream *s = as_wstream(k->stream);
    resolve(ctx, s->in_flight_write, JS_UNDEFINED);
    STORE(s, in_flight_write, JS_UNDEFINED);
    queue_dequeue(k);
    if (!close_queued_or_in_flight(s) && s->state == W_WRITABLE) update_backpressure(ctx, s, desired_size(k) <= 0);
    advance_queue_if_needed(ctx, k);
    return JS_UNDEFINED;
}

BUILTIN(write_rejected) {
    (void)this_val, (void)new_target;
    WController *k = as_wcontroller(js_closure_data(callee));
    WStream *s = as_wstream(k->stream);
    if (s->state == W_WRITABLE) clear_algorithms(ctx, k);
    reject(ctx, s->in_flight_write, ARG(0));
    STORE(s, in_flight_write, JS_UNDEFINED);
    deal_with_rejection(ctx, s, ARG(0));
    return JS_UNDEFINED;
}

BUILTIN(close_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    WStream *s = as_wstream(js_closure_data(callee));
    resolve(ctx, s->in_flight_close, JS_UNDEFINED);
    STORE(s, in_flight_close, JS_UNDEFINED);
    if (s->state == W_ERRORING) {
        STORE(s, stored_error, JS_UNDEFINED);
        if (!js_is_undefined(s->abort_promise)) {
            resolve(ctx, s->abort_promise, JS_UNDEFINED);
            STORE(s, abort_promise, JS_UNDEFINED);
            STORE(s, abort_reason, JS_UNDEFINED);
        }
    }
    s->state = W_CLOSED;
    Writer *w = as_writer(s->writer);
    if (w) resolve(ctx, w->closed, JS_UNDEFINED);
    return JS_UNDEFINED;
}

BUILTIN(close_rejected) {
    (void)this_val, (void)new_target;
    WStream *s = as_wstream(js_closure_data(callee));
    reject(ctx, s->in_flight_close, ARG(0));
    STORE(s, in_flight_close, JS_UNDEFINED);
    if (!js_is_undefined(s->abort_promise)) {
        reject(ctx, s->abort_promise, ARG(0));
        STORE(s, abort_promise, JS_UNDEFINED);
        STORE(s, abort_reason, JS_UNDEFINED);
    }
    deal_with_rejection(ctx, s, ARG(0));
    return JS_UNDEFINED;
}

static void advance_queue_if_needed(JSContext *ctx, WController *k) {
    WStream *s = as_wstream(k->stream);
    if (!k->started || !js_is_undefined(s->in_flight_write)) return;
    if (s->state == W_ERRORING) {
        finish_erroring(ctx, s);
        return;
    }
    if (queue_empty(k)) return;
    JSValue value = queue_peek(k);
    if (js_is_empty(value)) {  /* the close request */
        STORE(s, in_flight_close, s->close_request);
        STORE(s, close_request, JS_UNDEFINED);
        queue_dequeue(k);
        JSValue p = sink_call(ctx, k, 1, JS_UNDEFINED);
        clear_algorithms(ctx, k);
        then(ctx, p, close_fulfilled, close_rejected, js_object_value(&s->obj), JS_UNDEFINED);
        return;
    }
    JSValue requests = s->write_requests;
    JSValue first = js_get_elem(ctx, requests, js_int32(0));
    uint32_t n = js_array_length(js_as_object(requests));
    JSValue rest = js_new_array(ctx, n - 1);
    for (uint32_t i = 1; i < n; i++)
        if (js_array_push(ctx, js_as_object(rest), js_get_elem(ctx, requests, js_int32((int32_t)i))) < 0) js_discard(js_take_exception(ctx));
    STORE(s, write_requests, rest);
    STORE(s, in_flight_write, first);
    JSValue p = sink_call(ctx, k, 0, value);
    then(ctx, p, write_fulfilled, write_rejected, js_object_value(&k->obj), JS_UNDEFINED);
}

/* WritableStreamAbort: a promise */
static JSValue stream_abort(JSContext *ctx, WStream *s, JSValue reason) {
    if (s->state == W_CLOSED || s->state == W_ERRORED) return js_streams_resolved(ctx, JS_UNDEFINED);
    WController *k = controller_of(s);
    js_abort_signal_abort(ctx, k->signal, reason);
    if (s->state == W_CLOSED || s->state == W_ERRORED) return js_streams_resolved(ctx, JS_UNDEFINED);
    if (!js_is_undefined(s->abort_promise)) return s->abort_promise;
    bool was_erroring = s->state == W_ERRORING;
    if (was_erroring) reason = JS_UNDEFINED;
    JSValue promise = new_promise(ctx);
    STORE(s, abort_promise, promise);
    STORE(s, abort_reason, reason);
    s->abort_was_erroring = was_erroring;
    if (!was_erroring) start_erroring(ctx, s, reason);
    return promise;
}

/* WritableStreamClose: a promise */
static JSValue stream_close(JSContext *ctx, WStream *s) {
    if (s->state == W_CLOSED || s->state == W_ERRORED)
        return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "WritableStream is closed"));
    JSValue promise = new_promise(ctx);
    STORE(s, close_request, promise);
    Writer *w = as_writer(s->writer);
    if (w && s->backpressure && s->state == W_WRITABLE) resolve(ctx, w->ready, JS_UNDEFINED);
    WController *k = controller_of(s);
    queue_push(ctx, k, JS_EMPTY, 0);
    advance_queue_if_needed(ctx, k);
    return promise;
}

/* A chunk's size by the strategy: 1 without one; an error errors the stream (and counts 1). */
static double chunk_size(JSContext *ctx, WController *k, JSValue chunk) {
    if (js_is_undefined(k->size)) return 1;
    JSValue r = js_call(ctx, k->size, JS_UNDEFINED, 1, &chunk);
    double d;
    if (js_is_exception(r) || js_to_number(ctx, &d, r) < 0) {
        error_if_needed(ctx, k, js_take_exception(ctx));
        return 1;
    }
    return d;
}

/* WritableStreamDefaultWriterWrite: a promise */
static JSValue writer_write(JSContext *ctx, Writer *w, JSValue chunk) {
    WStream *s = as_wstream(w->stream);
    WController *k = controller_of(s);
    double size = chunk_size(ctx, k, chunk);
    if (!as_wstream(w->stream)) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "Writer has been released"));
    if (s->state == W_ERRORED || s->state == W_ERRORING) return js_streams_rejected(ctx, s->stored_error);
    if (close_queued_or_in_flight(s) || s->state == W_CLOSED)
        return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "WritableStream is closed"));
    JSValue promise = new_promise(ctx);
    if (js_array_push(ctx, js_as_object(s->write_requests), promise) < 0) return JS_EXCEPTION;
    if (!(size >= 0) || isinf(size)) {
        error_if_needed(ctx, k, js_new_error(ctx, JS_RANGE_ERROR, js_new_string_cstr(ctx, "Invalid size")));
        return promise;
    }
    queue_push(ctx, k, chunk, size);
    if (!close_queued_or_in_flight(s) && s->state == W_WRITABLE) update_backpressure(ctx, s, desired_size(k) <= 0);
    advance_queue_if_needed(ctx, k);
    return promise;
}

static void writer_release(JSContext *ctx, Writer *w) {
    WStream *s = as_wstream(w->stream);
    if (!s) return;
    JSValue e = js_streams_invalid_state(ctx, "Writer has been released");
    ensure_ready_rejected(ctx, w, e);
    ensure_closed_rejected(ctx, w, e);
    STORE(s, writer, JS_UNDEFINED);
    STORE(w, stream, JS_UNDEFINED);
}

static JSValue new_writer(JSContext *ctx, JSValue proto, JSValue sv) {
    WStream *s = as_wstream(sv);
    Writer *w = (Writer *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &writer_class, proto, 0));
    js_init_slot(&w->stream, sv);
    js_init_slot(&w->ready, JS_UNDEFINED);
    js_init_slot(&w->closed, JS_UNDEFINED);
    JSValue wv = js_object_value(&w->obj);
    if (s->state == W_WRITABLE) {
        STORE(w, ready, !close_queued_or_in_flight(s) && s->backpressure ? new_promise(ctx) : js_streams_resolved(ctx, JS_UNDEFINED));
        STORE(w, closed, new_promise(ctx));
    } else if (s->state == W_ERRORING) {
        STORE(w, ready, new_promise(ctx));
        js_streams_reject_handled(ctx, w->ready, s->stored_error);
        STORE(w, closed, new_promise(ctx));
    } else if (s->state == W_CLOSED) {
        STORE(w, ready, js_streams_resolved(ctx, JS_UNDEFINED));
        STORE(w, closed, js_streams_resolved(ctx, JS_UNDEFINED));
    } else {
        STORE(w, ready, new_promise(ctx));
        js_streams_reject_handled(ctx, w->ready, s->stored_error);
        STORE(w, closed, new_promise(ctx));
        js_streams_reject_handled(ctx, w->closed, s->stored_error);
    }
    STORE(s, writer, wv);
    return wv;
}

static JSValue acquire_writer(JSContext *ctx, JSValue sv) {
    if (!js_is_undefined(as_wstream(sv)->writer)) {
        JSValue e = js_streams_invalid_state(ctx, "WritableStream is locked");
        return js_throw(ctx, e);
    }
    return new_writer(ctx, ctx->intrinsics[JS_INTRINSIC_WRITABLE_STREAM_WRITER_PROTOTYPE], sv);
}

BUILTIN(wstart_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    WController *k = as_wcontroller(js_closure_data(callee));
    k->started = 1;
    advance_queue_if_needed(ctx, k);
    return JS_UNDEFINED;
}

BUILTIN(wstart_rejected) {
    (void)this_val, (void)new_target;
    WController *k = as_wcontroller(js_closure_data(callee));
    k->started = 1;
    deal_with_rejection(ctx, as_wstream(k->stream), ARG(0));
    return JS_UNDEFINED;
}

/* A new writable stream and its controller; its start is the caller's. */
static JSValue new_wstream(JSContext *ctx, JSValue proto, double hwm, JSValue size) {
    WStream *s = (WStream *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &wstream_class, proto, 4));
    js_init_slot(&s->controller, JS_UNDEFINED);
    js_init_slot(&s->writer, JS_UNDEFINED);
    js_init_slot(&s->stored_error, JS_UNDEFINED);
    js_init_slot(&s->in_flight_write, JS_UNDEFINED);
    js_init_slot(&s->close_request, JS_UNDEFINED);
    js_init_slot(&s->in_flight_close, JS_UNDEFINED);
    js_init_slot(&s->abort_promise, JS_UNDEFINED);
    js_init_slot(&s->abort_reason, JS_UNDEFINED);
    js_init_slot(&s->write_requests, JS_UNDEFINED);
    s->state = W_WRITABLE;
    s->backpressure = 0;
    s->abort_was_erroring = 0;
    JSValue sv = js_object_value(&s->obj);
    STORE(s, write_requests, js_new_array(ctx, 0));
    WController *k = (WController *)js_alloc_object(ctx, JS_CELL_OBJECT,
        js_shape_root(ctx, &wcontroller_class, ctx->intrinsics[JS_INTRINSIC_WRITABLE_STREAM_CONTROLLER_PROTOTYPE], 0));
    js_init_slot(&k->stream, sv);
    k->queue = NULL;
    k->head = k->n = k->cap = 0;
    k->queue_size = 0;
    k->high_water_mark = hwm;
    js_init_slot(&k->size, size);
    js_init_slot(&k->sink, JS_UNDEFINED);
    js_init_slot(&k->write, JS_UNDEFINED);
    js_init_slot(&k->close, JS_UNDEFINED);
    js_init_slot(&k->abort, JS_UNDEFINED);
    js_init_slot(&k->signal, JS_UNDEFINED);
    k->native = NULL;
    k->started = 0;
    STORE(s, controller, js_object_value(&k->obj));
    STORE(k, signal, js_new_abort_signal(ctx));
    update_backpressure(ctx, s, desired_size(k) <= 0);
    return sv;
}

static void wstart(JSContext *ctx, WController *k, JSValue start_promise) {
    then(ctx, start_promise, wstart_fulfilled, wstart_rejected, js_object_value(&k->obj), JS_UNDEFINED);
}

/* ---- Strategies ------------------------------------------------------------------------------ */

/* A strategy's highWaterMark (dflt when absent) and size. 0, or -1. */
static int strategy(JSContext *ctx, JSValue st, const char *name, double dflt, double *hwm, JSValue *size) {
    *hwm = dflt;
    *size = JS_UNDEFINED;
    if (js_is_undefined(st)) return 0;
    if (!js_is_object(st)) return fail(js_throw_invalid_arg_type(ctx, name, "of type object", st));
    JSValue h = js_get_value(ctx, st, js_atom_from_cstr(ctx, "highWaterMark"));
    if (js_is_exception(h)) return -1;
    if (!js_is_undefined(h)) {
        if (js_to_number(ctx, hwm, h) < 0) return -1;
        if (isnan(*hwm) || *hwm < 0) {
            char received[64];
            js_describe_value(ctx, h, received, sizeof received);
            return fail(js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_INVALID_ARG_VALUE", "The property '%s.highWaterMark' is invalid. Received %s", name, received));
        }
    }
    *size = js_get_value(ctx, st, js_atom_from_cstr(ctx, "size"));
    if (js_is_exception(*size)) return -1;
    if (!js_is_undefined(*size) && !js_is_callable(*size)) {
        char received[256];
        js_node_received(ctx, *size, received, sizeof received);
        return fail(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "The \"%s.size\" property must be of type function.%s", name, received));
    }
    return 0;
}

/* A method of an underlying sink or transformer: a function, or undefined. */
static JSValue method(JSContext *ctx, JSValue o, const char *what, const char *name) {
    if (!js_is_object(o)) return JS_UNDEFINED;
    JSValue f = js_get_value(ctx, o, js_atom_from_cstr(ctx, name));
    if (js_is_exception(f) || js_is_undefined(f) || js_is_callable(f)) return f;
    char received[256];
    js_node_received(ctx, f, received, sizeof received);
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "The \"%s.%s\" property must be of type function.%s", what, name, received);
}

/* ---- WritableStream ------------------------------------------------------------------------- */

/* new WritableStream(underlyingSink, strategy) */
BUILTIN(wstream_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "WritableStream");
    JSValue sink = ARG(0);
    if (!js_is_undefined(sink) && !js_is_object(sink)) return js_throw_invalid_arg_type(ctx, "sink", "of type object", sink);
    JSValue start = method(ctx, sink, "sink", "start");
    if (js_is_exception(start)) return start;
    JSValue write = method(ctx, sink, "sink", "write");
    if (js_is_exception(write)) return write;
    JSValue close = method(ctx, sink, "sink", "close");
    if (js_is_exception(close)) return close;
    JSValue abort = method(ctx, sink, "sink", "abort");
    if (js_is_exception(abort)) return abort;
    double hwm;
    JSValue size;
    if (strategy(ctx, ARG(1), "strategy", 1, &hwm, &size) < 0) return JS_EXCEPTION;
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_WRITABLE_STREAM_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    JSValue sv = new_wstream(ctx, proto, hwm, size);
    WController *k = controller_of(as_wstream(sv));
    STORE(k, sink, sink);
    STORE(k, write, write);
    STORE(k, close, close);
    STORE(k, abort, abort);
    JSValue kv = js_object_value(&k->obj);
    JSValue r = js_is_undefined(start) ? JS_UNDEFINED : js_call(ctx, start, sink, 1, &kv);
    if (js_is_exception(r)) return r;
    wstart(ctx, k, js_streams_promise_of(ctx, r));
    return sv;
}

#define THIS_WSTREAM()                          \
    WStream *s = as_wstream(this_val);          \
    if (!s) return js_throw_invalid_this(ctx, "WritableStream")

static JSValue rejected_invalid_this(JSContext *ctx, const char *type) {
    JSValue e = js_throw_invalid_this(ctx, type);
    (void)e;
    return js_streams_rejected(ctx, js_take_exception(ctx));
}

BUILTIN(wstream_locked) {
    UNUSED_ARGS;
    THIS_WSTREAM();
    return js_bool(!js_is_undefined(s->writer));
}

BUILTIN(wstream_abort) {
    UNUSED_ARGS;
    WStream *s = as_wstream(this_val);
    if (!s) return rejected_invalid_this(ctx, "WritableStream");
    if (!js_is_undefined(s->writer)) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "WritableStream is locked"));
    return stream_abort(ctx, s, ARG(0));
}

BUILTIN(wstream_close) {
    UNUSED_ARGS;
    WStream *s = as_wstream(this_val);
    if (!s) return rejected_invalid_this(ctx, "WritableStream");
    if (!js_is_undefined(s->writer)) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "WritableStream is locked"));
    if (close_queued_or_in_flight(s)) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "Failure closing WritableStream"));
    return stream_close(ctx, s);
}

BUILTIN(wstream_get_writer) {
    UNUSED_ARGS;
    THIS_WSTREAM();
    (void)s;
    return acquire_writer(ctx, this_val);
}

static const char *const WSTATES[] = { "writable", "closed", "erroring", "errored" };

/* `WritableStream { locked: false, state: 'writable' }` */
BUILTIN(wstream_inspect) {
    UNUSED_ARGS;
    THIS_WSTREAM();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "locked"), js_bool(!js_is_undefined(s->writer)), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "state"), js_new_string_cstr(ctx, WSTATES[s->state]), JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "WritableStream", o, ARG(0), ARG(1));
}

/* ---- WritableStreamDefaultWriter ------------------------------------------------------------ */

BUILTIN(writer_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "WritableStreamDefaultWriter");
    if (!as_wstream(ARG(0))) return js_throw_invalid_arg_type(ctx, "stream", "an instance of WritableStream", ARG(0));
    if (!js_is_undefined(as_wstream(ARG(0))->writer)) return js_throw(ctx, js_streams_invalid_state(ctx, "WritableStream is locked"));
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_WRITABLE_STREAM_WRITER_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    return new_writer(ctx, proto, ARG(0));
}

#define THIS_WRITER()                         \
    Writer *w = as_writer(this_val);          \
    if (!w) return js_throw_invalid_this(ctx, "WritableStreamDefaultWriter")

BUILTIN(writer_closed) {
    UNUSED_ARGS;
    Writer *w = as_writer(this_val);
    if (!w) return rejected_invalid_this(ctx, "WritableStreamDefaultWriter");
    return w->closed;
}

BUILTIN(writer_ready) {
    UNUSED_ARGS;
    Writer *w = as_writer(this_val);
    if (!w) return rejected_invalid_this(ctx, "WritableStreamDefaultWriter");
    return w->ready;
}

static JSValue writer_desired_size(Writer *w) {
    WStream *s = as_wstream(w->stream);
    if (s->state == W_ERRORED || s->state == W_ERRORING) return JS_NULL;
    if (s->state == W_CLOSED) return js_int32(0);
    return js_number(desired_size(controller_of(s)));
}

BUILTIN(writer_desired_size_getter) {
    UNUSED_ARGS;
    THIS_WRITER();
    if (!as_wstream(w->stream)) return js_throw(ctx, js_streams_invalid_state(ctx, "Writer is not bound to a WritableStream"));
    return writer_desired_size(w);
}

BUILTIN(writer_abort) {
    UNUSED_ARGS;
    Writer *w = as_writer(this_val);
    if (!w) return rejected_invalid_this(ctx, "WritableStreamDefaultWriter");
    WStream *s = as_wstream(w->stream);
    if (!s) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "Writer is not bound to a WritableStream"));
    return stream_abort(ctx, s, ARG(0));
}

BUILTIN(writer_close) {
    UNUSED_ARGS;
    Writer *w = as_writer(this_val);
    if (!w) return rejected_invalid_this(ctx, "WritableStreamDefaultWriter");
    WStream *s = as_wstream(w->stream);
    if (!s) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "Writer is not bound to a WritableStream"));
    if (close_queued_or_in_flight(s)) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "Failure to close WritableStream"));
    return stream_close(ctx, s);
}

BUILTIN(writer_release_lock) {
    UNUSED_ARGS;
    THIS_WRITER();
    writer_release(ctx, w);
    return JS_UNDEFINED;
}

BUILTIN(writer_write_method) {
    UNUSED_ARGS;
    Writer *w = as_writer(this_val);
    if (!w) return rejected_invalid_this(ctx, "WritableStreamDefaultWriter");
    if (!as_wstream(w->stream)) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "Writer is not bound to a WritableStream"));
    return writer_write(ctx, w, ARG(0));
}

/* `WritableStreamDefaultWriter { stream: …, close: Promise { … }, ready: …, desiredSize: 1 }` */
BUILTIN(writer_inspect) {
    UNUSED_ARGS;
    THIS_WRITER();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "stream"), w->stream, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "close"), w->closed, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "ready"), w->ready, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "desiredSize"), as_wstream(w->stream) ? writer_desired_size(w) : JS_NULL, JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "WritableStreamDefaultWriter", o, ARG(0), ARG(1));
}

/* ---- WritableStreamDefaultController -------------------------------------------------------- */

BUILTIN(illegal_ctor) {
    UNUSED_ARGS;
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
}

#define THIS_WCONTROLLER()                         \
    WController *k = as_wcontroller(this_val);     \
    if (!k) return js_throw_invalid_this(ctx, "WritableStreamDefaultController")

BUILTIN(wcontroller_signal) {
    UNUSED_ARGS;
    THIS_WCONTROLLER();
    return k->signal;
}

BUILTIN(wcontroller_error) {
    UNUSED_ARGS;
    THIS_WCONTROLLER();
    if (as_wstream(k->stream)->state == W_WRITABLE) error_if_needed(ctx, k, ARG(0));
    return JS_UNDEFINED;
}

BUILTIN(wcontroller_inspect) {
    UNUSED_ARGS;
    THIS_WCONTROLLER();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "stream"), k->stream, JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "WritableStreamDefaultController", o, ARG(0), ARG(1));
}

/* ---- TransformStream (§6.4) ----------------------------------------------------------------- */

static TController *tcontroller_of(TStream *t) { return as_tcontroller(t->controller); }

static void set_backpressure(JSContext *ctx, TStream *t, bool bp) {
    if (pending(t->backpressure_change)) resolve(ctx, t->backpressure_change, JS_UNDEFINED);
    STORE(t, backpressure_change, new_promise(ctx));
    t->backpressure = bp;
}

static void tclear_algorithms(JSContext *ctx, TController *k) {
    STORE(k, transform, JS_UNDEFINED);
    STORE(k, flush, JS_UNDEFINED);
    STORE(k, cancel, JS_UNDEFINED);
}

static void error_writable_and_unblock(JSContext *ctx, TStream *t, JSValue e) {
    tclear_algorithms(ctx, tcontroller_of(t));
    error_if_needed(ctx, controller_of(as_wstream(t->writable)), e);
    if (t->backpressure == 1) set_backpressure(ctx, t, false);
}

static void tstream_error(JSContext *ctx, TStream *t, JSValue e) {
    js_readable_stream_error(ctx, js_rs_controller(t->readable), e);
    error_writable_and_unblock(ctx, t, e);
}

/* TransformStreamDefaultControllerEnqueue: 0, or -1 */
static int tenqueue(JSContext *ctx, TStream *t, JSValue chunk) {
    JSValue rc = js_rs_controller(t->readable);
    if (!js_rs_can_close_or_enqueue(rc)) return fail(js_throw(ctx, js_streams_invalid_state(ctx, "Unable to enqueue")));
    if (js_readable_stream_enqueue(ctx, rc, chunk) < 0) {
        JSValue e = js_take_exception(ctx);
        error_writable_and_unblock(ctx, t, e);
        return fail(js_throw(ctx, js_rs_stored_error(t->readable)));
    }
    bool bp = js_rs_has_backpressure(rc);
    if (bp != (t->backpressure == 1) && bp) set_backpressure(ctx, t, true);
    return 0;
}

BUILTIN(transform_rejected) {
    (void)this_val, (void)new_target;
    TStream *t = as_tstream(js_closure_data(callee));
    tstream_error(ctx, t, ARG(0));
    return js_throw(ctx, ARG(0));
}

/* TransformStreamDefaultControllerPerformTransform */
static JSValue perform_transform(JSContext *ctx, TStream *t, JSValue chunk) {
    TController *k = tcontroller_of(t);
    JSValue r;
    if (js_is_undefined(k->transform)) {
        r = tenqueue(ctx, t, chunk) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
    } else {
        JSValue args[2] = { chunk, js_object_value(&k->obj) };
        r = js_call(ctx, k->transform, k->transformer, 2, args);
    }
    JSValue p = js_streams_promise_of(ctx, r);
    JSValue derived = new_promise(ctx);
    then(ctx, p, NULL, transform_rejected, js_object_value(&t->obj), derived);
    return derived;
}

BUILTIN(write_after_backpressure) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue data = js_closure_data(callee);  /* [transform stream, chunk] */
    TStream *t = as_tstream(js_get_elem(ctx, data, js_int32(0)));
    WStream *ws = as_wstream(t->writable);
    if (ws->state == W_ERRORING) return js_throw(ctx, ws->stored_error);
    return perform_transform(ctx, t, js_get_elem(ctx, data, js_int32(1)));
}

static JSValue sink_write(JSContext *ctx, JSValue tv, JSValue chunk) {
    TStream *t = as_tstream(tv);
    if (t->backpressure == 1) {
        JSValue items[2] = { tv, chunk };
        JSValue derived = new_promise(ctx);
        then(ctx, t->backpressure_change, write_after_backpressure, NULL, js_new_array_from(ctx, items, 2), derived);
        return derived;
    }
    return perform_transform(ctx, t, chunk);
}

BUILTIN(flush_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    TStream *t = as_tstream(js_closure_data(callee));
    TController *k = tcontroller_of(t);
    if (js_rs_state(t->readable) == JS_RS_ERRORED) {
        reject(ctx, k->finish, js_rs_stored_error(t->readable));
        return JS_UNDEFINED;
    }
    if (js_rs_can_close_or_enqueue(js_rs_controller(t->readable)) && js_readable_stream_close(ctx, js_rs_controller(t->readable)) < 0)
        js_discard(js_take_exception(ctx));
    resolve(ctx, k->finish, JS_UNDEFINED);
    return JS_UNDEFINED;
}

BUILTIN(finish_rejected) {
    (void)this_val, (void)new_target;
    TStream *t = as_tstream(js_closure_data(callee));
    tstream_error(ctx, t, ARG(0));
    reject(ctx, tcontroller_of(t)->finish, ARG(0));
    return JS_UNDEFINED;
}

static JSValue sink_close(JSContext *ctx, JSValue tv) {
    TStream *t = as_tstream(tv);
    TController *k = tcontroller_of(t);
    if (!js_is_undefined(k->finish)) return k->finish;
    STORE(k, finish, new_promise(ctx));
    JSValue kv = js_object_value(&k->obj);
    JSValue r = js_is_undefined(k->flush) ? JS_UNDEFINED : js_call(ctx, k->flush, k->transformer, 1, &kv);
    tclear_algorithms(ctx, k);
    then(ctx, js_streams_promise_of(ctx, r), flush_fulfilled, finish_rejected, tv, JS_UNDEFINED);
    return k->finish;
}

BUILTIN(abort_cancel_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue data = js_closure_data(callee);  /* [transform stream, reason] */
    TStream *t = as_tstream(js_get_elem(ctx, data, js_int32(0)));
    TController *k = tcontroller_of(t);
    if (js_rs_state(t->readable) == JS_RS_ERRORED) reject(ctx, k->finish, js_rs_stored_error(t->readable));
    else {
        js_readable_stream_error(ctx, js_rs_controller(t->readable), js_get_elem(ctx, data, js_int32(1)));
        resolve(ctx, k->finish, JS_UNDEFINED);
    }
    return JS_UNDEFINED;
}

BUILTIN(abort_cancel_rejected) {
    (void)this_val, (void)new_target;
    JSValue data = js_closure_data(callee);
    TStream *t = as_tstream(js_get_elem(ctx, data, js_int32(0)));
    js_readable_stream_error(ctx, js_rs_controller(t->readable), ARG(0));
    reject(ctx, tcontroller_of(t)->finish, ARG(0));
    return JS_UNDEFINED;
}

/* the writable side aborted, or (source_cancel) the readable side canceled: the transformer's cancel */
static JSValue run_cancel(JSContext *ctx, TStream *t, JSValue reason, bool from_readable) {
    TController *k = tcontroller_of(t);
    if (!js_is_undefined(k->finish)) return k->finish;
    STORE(k, finish, new_promise(ctx));
    JSValue r = js_is_undefined(k->cancel) ? JS_UNDEFINED : js_call(ctx, k->cancel, k->transformer, 1, &reason);
    tclear_algorithms(ctx, k);
    JSValue items[2] = { js_object_value(&t->obj), reason };
    if (from_readable) {
        error_if_needed(ctx, controller_of(as_wstream(t->writable)), reason);
        if (t->backpressure == 1) set_backpressure(ctx, t, false);
        then(ctx, js_streams_promise_of(ctx, r), NULL, abort_cancel_rejected, js_new_array_from(ctx, items, 2), JS_UNDEFINED);
        then(ctx, js_streams_promise_of(ctx, r), NULL, NULL, JS_UNDEFINED, k->finish);
    } else {
        then(ctx, js_streams_promise_of(ctx, r), abort_cancel_fulfilled, abort_cancel_rejected, js_new_array_from(ctx, items, 2), JS_UNDEFINED);
    }
    return k->finish;
}

static JSValue sink_abort(JSContext *ctx, JSValue tv, JSValue reason) { return run_cancel(ctx, as_tstream(tv), reason, false); }

static const Sink transform_sink = { sink_write, sink_close, sink_abort };

static JSValue source_pull(JSContext *ctx, JSValue controller, JSValue tv) {
    (void)controller;
    TStream *t = as_tstream(tv);
    set_backpressure(ctx, t, false);
    return t->backpressure_change;
}

static JSValue source_cancel(JSContext *ctx, JSValue tv, JSValue reason) { return run_cancel(ctx, as_tstream(tv), reason, true); }

static const JSStreamSource transform_source = { source_pull, source_cancel };

/* new TransformStream(transformer, writableStrategy, readableStrategy) */
BUILTIN(tstream_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "TransformStream");
    JSValue transformer = ARG(0);
    if (!js_is_undefined(transformer) && !js_is_object(transformer))
        return js_throw_invalid_arg_type(ctx, "transformer", "of type object", transformer);
    JSValue start = method(ctx, transformer, "transformer", "start");
    if (js_is_exception(start)) return start;
    JSValue transform = method(ctx, transformer, "transformer", "transform");
    if (js_is_exception(transform)) return transform;
    JSValue flush = method(ctx, transformer, "transformer", "flush");
    if (js_is_exception(flush)) return flush;
    JSValue cancel = method(ctx, transformer, "transformer", "cancel");
    if (js_is_exception(cancel)) return cancel;
    double whwm, rhwm;
    JSValue wsize, rsize;
    if (strategy(ctx, ARG(1), "writableStrategy", 1, &whwm, &wsize) < 0) return JS_EXCEPTION;
    if (strategy(ctx, ARG(2), "readableStrategy", 0, &rhwm, &rsize) < 0) return JS_EXCEPTION;
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_TRANSFORM_STREAM_PROTOTYPE);
    if (js_is_exception(proto)) return proto;

    TStream *t = (TStream *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &tstream_class, proto, 2));
    js_init_slot(&t->readable, JS_UNDEFINED);
    js_init_slot(&t->writable, JS_UNDEFINED);
    js_init_slot(&t->controller, JS_UNDEFINED);
    js_init_slot(&t->backpressure_change, JS_UNDEFINED);
    t->backpressure = 2;
    JSValue tv = js_object_value(&t->obj);
    JSValue start_promise = new_promise(ctx);
    /* the writable: its sink is the transform */
    JSValue ws = new_wstream(ctx, ctx->intrinsics[JS_INTRINSIC_WRITABLE_STREAM_PROTOTYPE], whwm, wsize);
    WController *wk = controller_of(as_wstream(ws));
    wk->native = &transform_sink;
    STORE(wk, sink, tv);
    STORE(t, writable, ws);
    JSValue rs = js_rs_new(ctx, &transform_source, tv, rhwm, rsize, start_promise);
    if (js_is_exception(rs)) return rs;
    STORE(t, readable, rs);
    set_backpressure(ctx, t, true);
    wstart(ctx, wk, start_promise);

    TController *k = (TController *)js_alloc_object(ctx, JS_CELL_OBJECT,
        js_shape_root(ctx, &tcontroller_class, ctx->intrinsics[JS_INTRINSIC_TRANSFORM_STREAM_CONTROLLER_PROTOTYPE], 0));
    js_init_slot(&k->stream, tv);
    js_init_slot(&k->transformer, transformer);
    js_init_slot(&k->transform, transform);
    js_init_slot(&k->flush, flush);
    js_init_slot(&k->cancel, cancel);
    js_init_slot(&k->finish, JS_UNDEFINED);
    STORE(t, controller, js_object_value(&k->obj));
    JSValue kv = js_object_value(&k->obj);
    JSValue r = js_is_undefined(start) ? JS_UNDEFINED : js_call(ctx, start, transformer, 1, &kv);
    if (js_is_exception(r)) return r;
    resolve(ctx, start_promise, r);
    return tv;
}

#define THIS_TSTREAM()                         \
    TStream *t = as_tstream(this_val);         \
    if (!t) return js_throw_invalid_this(ctx, "TransformStream")

BUILTIN(tstream_readable) {
    UNUSED_ARGS;
    THIS_TSTREAM();
    return t->readable;
}

BUILTIN(tstream_writable) {
    UNUSED_ARGS;
    THIS_TSTREAM();
    return t->writable;
}

/* `TransformStream { readable: …, writable: …, backpressure: true }` */
BUILTIN(tstream_inspect) {
    UNUSED_ARGS;
    THIS_TSTREAM();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "readable"), t->readable, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "writable"), t->writable, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "backpressure"), t->backpressure == 2 ? JS_UNDEFINED : js_bool(t->backpressure), JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "TransformStream", o, ARG(0), ARG(1));
}

#define THIS_TCONTROLLER()                         \
    TController *k = as_tcontroller(this_val);     \
    if (!k) return js_throw_invalid_this(ctx, "TransformStreamDefaultController")

BUILTIN(tcontroller_desired_size) {
    UNUSED_ARGS;
    THIS_TCONTROLLER();
    return js_rs_desired_size(js_rs_controller(as_tstream(k->stream)->readable));
}

BUILTIN(tcontroller_enqueue) {
    UNUSED_ARGS;
    THIS_TCONTROLLER();
    return tenqueue(ctx, as_tstream(k->stream), ARG(0)) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

BUILTIN(tcontroller_error) {
    UNUSED_ARGS;
    THIS_TCONTROLLER();
    tstream_error(ctx, as_tstream(k->stream), ARG(0));
    return JS_UNDEFINED;
}

BUILTIN(tcontroller_terminate) {
    UNUSED_ARGS;
    THIS_TCONTROLLER();
    TStream *t = as_tstream(k->stream);
    JSValue rc = js_rs_controller(t->readable);
    if (js_rs_can_close_or_enqueue(rc) && js_readable_stream_close(ctx, rc) < 0) return JS_EXCEPTION;
    error_writable_and_unblock(ctx, t, js_streams_invalid_state(ctx, "TransformStream has been terminated"));
    return JS_UNDEFINED;
}

BUILTIN(tcontroller_inspect) {
    UNUSED_ARGS;
    THIS_TCONTROLLER();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "stream"), k->stream, JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "TransformStreamDefaultController", o, ARG(0), ARG(1));
}

/* ---- pipeTo (§4.9.4 ReadableStreamPipeTo) --------------------------------------------------- */

/* The pipe's state: [reader, writer, promise, source, dest, flags, currentWrite, signal, abortListener,
 * deferred shutdown]. flags: 1 preventClose, 2 preventAbort, 4 preventCancel, 8 shutting down,
 * 16 a read in flight (a shutdown waits for its chunk to be written: [action, has error, error]) */
enum { P_READER, P_WRITER, P_PROMISE, P_SOURCE, P_DEST, P_FLAGS, P_WRITE, P_SIGNAL, P_LISTENER, P_DEFERRED, P_COUNT };

static JSValue pget(JSContext *ctx, JSValue p, int i) { return js_get_elem(ctx, p, js_int32(i)); }
static void pset(JSContext *ctx, JSValue p, int i, JSValue v) {
    if (js_set_elem(ctx, p, js_int32(i), v, true) < 0) js_discard(js_take_exception(ctx));
}
static int pflags(JSContext *ctx, JSValue p) { return (int)js_as_number(pget(ctx, p, P_FLAGS)); }

static void pipe_step(JSContext *ctx, JSValue p);

/* Finalize: release both locks, settle the pipe's promise (with the error, or not). */
static void pipe_finalize(JSContext *ctx, JSValue p, bool has_error, JSValue error) {
    Writer *w = as_writer(pget(ctx, p, P_WRITER));
    writer_release(ctx, w);
    js_rs_release(ctx, pget(ctx, p, P_READER));
    JSValue signal = pget(ctx, p, P_SIGNAL);
    if (js_is_object(signal)) {
        JSValue remove = js_get_value(ctx, signal, js_atom_from_cstr(ctx, "removeEventListener"));
        JSValue args[2] = { js_new_string_cstr(ctx, "abort"), pget(ctx, p, P_LISTENER) };
        if (js_is_callable(remove) && js_is_exception(js_call(ctx, remove, signal, 2, args))) js_discard(js_take_exception(ctx));
    }
    if (has_error) reject(ctx, pget(ctx, p, P_PROMISE), error);
    else resolve(ctx, pget(ctx, p, P_PROMISE), JS_UNDEFINED);
}

BUILTIN(finalize_with_original) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue data = js_closure_data(callee);  /* [pipe, has error, error] */
    pipe_finalize(ctx, pget(ctx, data, 0), js_truthy(pget(ctx, data, 1)), pget(ctx, data, 2));
    return JS_UNDEFINED;
}

BUILTIN(finalize_with_new) {
    (void)this_val, (void)new_target;
    JSValue data = js_closure_data(callee);
    pipe_finalize(ctx, pget(ctx, data, 0), true, ARG(0));
    return JS_UNDEFINED;
}

enum { ACT_NONE, ACT_ABORT_DEST, ACT_CANCEL_SOURCE, ACT_CLOSE_DEST, ACT_BOTH };

/* runs the action, then finalizes; data: [pipe, action, has error, error] */
BUILTIN(pipe_run_action) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue data = js_closure_data(callee);
    JSValue p = pget(ctx, data, 0);
    int action = (int)js_as_number(pget(ctx, data, 1));
    JSValue error = pget(ctx, data, 3);
    JSValue result;
    WStream *dest = as_wstream(pget(ctx, p, P_DEST));
    JSValue source = pget(ctx, p, P_SOURCE);
    int flags = pflags(ctx, p);
    if (action == ACT_ABORT_DEST) result = stream_abort(ctx, dest, error);
    else if (action == ACT_CANCEL_SOURCE) result = js_rs_cancel(ctx, source, error);
    else if (action == ACT_CLOSE_DEST) {
        /* WritableStreamDefaultWriterCloseWithErrorPropagation */
        if (close_queued_or_in_flight(dest) || dest->state == W_CLOSED) result = js_streams_resolved(ctx, JS_UNDEFINED);
        else if (dest->state == W_ERRORED) result = js_streams_rejected(ctx, dest->stored_error);
        else result = stream_close(ctx, dest);
    } else if (action == ACT_BOTH) {  /* the signal: abort the dest and cancel the source, as asked */
        JSValue a = !(flags & 2) && dest->state == W_WRITABLE ? stream_abort(ctx, dest, error) : js_streams_resolved(ctx, JS_UNDEFINED);
        JSValue c = !(flags & 4) && js_rs_state(source) == JS_RS_READABLE ? js_rs_cancel(ctx, source, error) : js_streams_resolved(ctx, JS_UNDEFINED);
        mark_handled(a);
        mark_handled(c);
        (void)a;
        result = c;
    } else result = js_streams_resolved(ctx, JS_UNDEFINED);
    JSValue items[3] = { p, pget(ctx, data, 2), error };
    JSValue fdata = js_new_array_from(ctx, items, 3);
    then(ctx, result, finalize_with_original, finalize_with_new, fdata, JS_UNDEFINED);
    return JS_UNDEFINED;
}

/* Shutdown (with an action, or none): once; waits for the write in flight when the dest is still writable */
static void pipe_shutdown(JSContext *ctx, JSValue p, int action, bool has_error, JSValue error) {
    int flags = pflags(ctx, p);
    if (flags & 8) return;
    if (flags & 16) {  /* the chunk being read is written first */
        if (js_is_undefined(pget(ctx, p, P_DEFERRED))) {
            JSValue d[3] = { js_int32(action), js_bool(has_error), error };
            pset(ctx, p, P_DEFERRED, js_new_array_from(ctx, d, 3));
        }
        return;
    }
    pset(ctx, p, P_FLAGS, js_int32(flags | 8));
    JSValue items[4] = { p, js_int32(action), js_bool(has_error), error };
    JSValue data = js_new_array_from(ctx, items, 4);
    WStream *dest = as_wstream(pget(ctx, p, P_DEST));
    JSValue current = pget(ctx, p, P_WRITE);
    JSValue wait = dest->state == W_WRITABLE && !close_queued_or_in_flight(dest) && js_is_promise(current) ? current : js_streams_resolved(ctx, JS_UNDEFINED);
    then(ctx, wait, pipe_run_action, pipe_run_action, data, JS_UNDEFINED);
}

/* the source closed or errored (its reader's closed promise settled) */
BUILTIN(source_closed) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue p = js_closure_data(callee);
    int flags = pflags(ctx, p);
    pipe_shutdown(ctx, p, flags & 1 ? ACT_NONE : ACT_CLOSE_DEST, false, JS_UNDEFINED);
    return JS_UNDEFINED;
}

BUILTIN(source_errored) {
    (void)this_val, (void)new_target;
    JSValue p = js_closure_data(callee);
    int flags = pflags(ctx, p);
    pipe_shutdown(ctx, p, flags & 2 ? ACT_NONE : ACT_ABORT_DEST, true, ARG(0));
    return JS_UNDEFINED;
}

/* the dest errored (its writer's closed promise rejected), or closed under the pipe */
BUILTIN(dest_errored) {
    (void)this_val, (void)new_target;
    JSValue p = js_closure_data(callee);
    int flags = pflags(ctx, p);
    pipe_shutdown(ctx, p, flags & 4 ? ACT_NONE : ACT_CANCEL_SOURCE, true, ARG(0));
    return JS_UNDEFINED;
}

BUILTIN(dest_closed) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue p = js_closure_data(callee);
    int flags = pflags(ctx, p);
    if (flags & 8) return JS_UNDEFINED;
    JSValue e = type_error(ctx, "the destination writable stream closed before all data could be piped to it");
    pipe_shutdown(ctx, p, flags & 4 ? ACT_NONE : ACT_CANCEL_SOURCE, true, e);
    return JS_UNDEFINED;
}

BUILTIN(signal_aborted) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue p = js_closure_data(callee);
    JSValue signal = pget(ctx, p, P_SIGNAL);
    JSValue reason = js_get_value(ctx, signal, js_atom_from_cstr(ctx, "reason"));
    if (js_is_exception(reason)) return reason;
    pipe_shutdown(ctx, p, ACT_BOTH, true, reason);
    return JS_UNDEFINED;
}

/* The read settled: a shutdown that waited for it goes ahead; 1 when one did. */
static bool read_settled(JSContext *ctx, JSValue p) {
    pset(ctx, p, P_FLAGS, js_int32(pflags(ctx, p) & ~16));
    JSValue d = pget(ctx, p, P_DEFERRED);
    if (js_is_undefined(d)) return false;
    pipe_shutdown(ctx, p, (int)js_as_number(pget(ctx, d, 0)), js_truthy(pget(ctx, d, 1)), pget(ctx, d, 2));
    return true;
}

/* a chunk read: write it (the write isn't awaited, only its readiness), and read the next */
BUILTIN(pipe_chunk) {
    (void)this_val, (void)new_target;
    JSValue p = js_closure_data(callee);
    JSValue result = ARG(0);
    JSValue done = js_get_value(ctx, result, JS_ATOM(done));
    if (js_is_exception(done)) return done;
    if (!js_truthy(done) && !(pflags(ctx, p) & 8)) {
        JSValue chunk = js_get_value(ctx, result, JS_ATOM(value));
        if (js_is_exception(chunk)) return chunk;
        Writer *w = as_writer(pget(ctx, p, P_WRITER));
        if (as_wstream(w->stream)) {
            JSValue wp = writer_write(ctx, w, chunk);
            if (js_is_exception(wp)) return wp;
            mark_handled(wp);
            pset(ctx, p, P_WRITE, wp);
        }
    }
    if (!read_settled(ctx, p) && !js_truthy(done)) pipe_step(ctx, p);
    return JS_UNDEFINED;
}

BUILTIN(pipe_read_failed) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    read_settled(ctx, js_closure_data(callee));
    return JS_UNDEFINED;
}

BUILTIN(pipe_ready) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    pipe_step(ctx, js_closure_data(callee));
    return JS_UNDEFINED;
}

BUILTIN(ignore) {
    UNUSED_ARGS;
    return JS_UNDEFINED;
}

/* the loop: when the writer is ready, read a chunk */
static void pipe_step(JSContext *ctx, JSValue p) {
    if (pflags(ctx, p) & 8) return;
    Writer *w = as_writer(pget(ctx, p, P_WRITER));
    WStream *dest = as_wstream(w->stream);
    if (!dest || dest->state != W_WRITABLE || close_queued_or_in_flight(dest)) return;
    if (desired_size(controller_of(dest)) <= 0) {
        js_promise_then_internal(ctx, w->ready, js_new_closure_native(ctx, pipe_ready, 1, p), js_new_native(ctx, ignore, js_empty_string(), 1, JS_FN_STRICT), JS_UNDEFINED);
        return;
    }
    pset(ctx, p, P_FLAGS, js_int32(pflags(ctx, p) | 16));
    JSValue rp = js_rs_read(ctx, pget(ctx, p, P_READER));
    js_promise_then_internal(ctx, rp, js_new_closure_native(ctx, pipe_chunk, 1, p), js_new_closure_native(ctx, pipe_read_failed, 1, p), JS_UNDEFINED);
}

static JSValue pipe_to(JSContext *ctx, JSValue source, JSValue dest, JSValue options) {
    int flags = 0;
    JSValue signal = JS_UNDEFINED;
    if (!js_is_undefined(options)) {
        if (!js_is_object(options)) {
            JSValue e = js_throw_invalid_arg_type(ctx, "options", "of type object", options);
            (void)e;
            return js_streams_rejected(ctx, js_take_exception(ctx));
        }
        static const char *const names[] = { "preventClose", "preventAbort", "preventCancel" };
        for (int i = 0; i < 3; i++) {
            JSValue v = js_get_value(ctx, options, js_atom_from_cstr(ctx, names[i]));
            if (js_is_exception(v)) return js_streams_rejected(ctx, js_take_exception(ctx));
            if (js_truthy(v)) flags |= 1 << i;
        }
        signal = js_get_value(ctx, options, js_atom_from_cstr(ctx, "signal"));
        if (js_is_exception(signal)) return js_streams_rejected(ctx, js_take_exception(ctx));
        if (!js_is_undefined(signal) && !js_is_abort_signal(signal)) {
            JSValue e = js_throw_invalid_arg_type(ctx, "options.signal", "an instance of AbortSignal", signal);
            (void)e;
            return js_streams_rejected(ctx, js_take_exception(ctx));
        }
    }
    if (js_rs_locked(source)) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "ReadableStream is locked"));
    if (!js_is_undefined(as_wstream(dest)->writer)) return js_streams_rejected(ctx, js_streams_invalid_state(ctx, "WritableStream is locked"));
    JSValue reader = js_rs_reader(ctx, source);
    if (js_is_exception(reader)) return js_streams_rejected(ctx, js_take_exception(ctx));
    JSValue writer = acquire_writer(ctx, dest);
    if (js_is_exception(writer)) return js_streams_rejected(ctx, js_take_exception(ctx));
    JSValue promise = new_promise(ctx);
    JSValue items[P_COUNT] = { reader, writer, promise, source, dest, js_int32(flags), JS_UNDEFINED, signal, JS_UNDEFINED, JS_UNDEFINED };
    JSValue p = js_new_array_from(ctx, items, P_COUNT);
    if (js_is_abort_signal(signal)) {
        JSValue aborted = js_get_value(ctx, signal, js_atom_from_cstr(ctx, "aborted"));
        if (js_is_exception(aborted)) return js_streams_rejected(ctx, js_take_exception(ctx));
        JSValue listener = js_new_closure_native(ctx, signal_aborted, 0, p);
        pset(ctx, p, P_LISTENER, listener);
        if (js_truthy(aborted)) {
            JSValue r = signal_aborted(ctx, listener, JS_UNDEFINED, 0, NULL, JS_UNDEFINED);
            if (js_is_exception(r)) return js_streams_rejected(ctx, js_take_exception(ctx));
            return promise;
        }
        JSValue add = js_get_value(ctx, signal, js_atom_from_cstr(ctx, "addEventListener"));
        JSValue args[2] = { js_new_string_cstr(ctx, "abort"), listener };
        if (js_is_exception(add) || js_is_exception(js_call(ctx, add, signal, 2, args))) return js_streams_rejected(ctx, js_take_exception(ctx));
    }
    /* the states as the pipe starts, then their changes */
    WStream *ws = as_wstream(dest);
    if (js_rs_state(source) == JS_RS_ERRORED) {
        pipe_shutdown(ctx, p, flags & 2 ? ACT_NONE : ACT_ABORT_DEST, true, js_rs_stored_error(source));
        return promise;
    }
    if (ws->state == W_ERRORED || ws->state == W_ERRORING) {
        pipe_shutdown(ctx, p, flags & 4 ? ACT_NONE : ACT_CANCEL_SOURCE, true, ws->stored_error);
        return promise;
    }
    if (js_rs_state(source) == JS_RS_CLOSED) {
        pipe_shutdown(ctx, p, flags & 1 ? ACT_NONE : ACT_CLOSE_DEST, false, JS_UNDEFINED);
        return promise;
    }
    if (close_queued_or_in_flight(ws) || ws->state == W_CLOSED) {
        JSValue e = type_error(ctx, "the destination writable stream closed before all data could be piped to it");
        pipe_shutdown(ctx, p, flags & 4 ? ACT_NONE : ACT_CANCEL_SOURCE, true, e);
        return promise;
    }
    then(ctx, js_rs_reader_closed(reader), source_closed, source_errored, p, JS_UNDEFINED);
    then(ctx, as_writer(writer)->closed, dest_closed, dest_errored, p, JS_UNDEFINED);
    pipe_step(ctx, p);
    return promise;
}

JSValue js_rs_pipe_to(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    if (!js_is_readable_stream(this_val)) return rejected_invalid_this(ctx, "ReadableStream");
    if (!as_wstream(ARG(0))) {
        char received[256];
        js_node_received(ctx, ARG(0), received, sizeof received);
        JSValue e = js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "The \"transform.writable\" property must be an instance of WritableStream.%s", received);
        (void)e;
        return js_streams_rejected(ctx, js_take_exception(ctx));
    }
    return pipe_to(ctx, this_val, ARG(0), ARG(1));
}

/* pipeThrough({ writable, readable }, options): the readable */
JSValue js_rs_pipe_through(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    if (!js_is_readable_stream(this_val)) return js_throw_invalid_this(ctx, "ReadableStream");
    JSValue pair = ARG(0);
    if (!js_is_object(pair)) return js_throw_invalid_arg_type(ctx, "transform", "of type object", pair);
    JSValue readable = js_get_value(ctx, pair, js_atom_from_cstr(ctx, "readable"));
    if (js_is_exception(readable)) return readable;
    char received[256];
    if (!js_is_readable_stream(readable)) {
        js_node_received(ctx, readable, received, sizeof received);
        return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "The \"transform.readable\" property must be an instance of ReadableStream.%s", received);
    }
    JSValue writable = js_get_value(ctx, pair, js_atom_from_cstr(ctx, "writable"));
    if (js_is_exception(writable)) return writable;
    if (!as_wstream(writable)) {
        js_node_received(ctx, writable, received, sizeof received);
        return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "The \"transform.writable\" property must be an instance of WritableStream.%s", received);
    }
    if (js_rs_locked(this_val)) return js_throw(ctx, js_streams_invalid_state(ctx, "ReadableStream is locked"));
    if (!js_is_undefined(as_wstream(writable)->writer)) return js_throw(ctx, js_streams_invalid_state(ctx, "WritableStream is locked"));
    JSValue p = pipe_to(ctx, this_val, writable, ARG(1));
    mark_handled(p);
    return readable;
}

/* ---- Realm ---------------------------------------------------------------------------------- */

static const JSBuiltin wstream_proto[] = {
    WEBIDL_ATTRIBUTE("locked", wstream_locked, NULL),
    WEBIDL_OPERATION("abort", wstream_abort, 0),
    WEBIDL_OPERATION("close", wstream_close, 0),
    WEBIDL_OPERATION("getWriter", wstream_get_writer, 0),
};

static const JSBuiltin writer_proto[] = {
    WEBIDL_ATTRIBUTE("closed", writer_closed, NULL),
    WEBIDL_ATTRIBUTE("desiredSize", writer_desired_size_getter, NULL),
    WEBIDL_ATTRIBUTE("ready", writer_ready, NULL),
    WEBIDL_OPERATION("abort", writer_abort, 0),
    WEBIDL_OPERATION("close", writer_close, 0),
    WEBIDL_OPERATION("releaseLock", writer_release_lock, 0),
    WEBIDL_OPERATION("write", writer_write_method, 0),
};

static const JSBuiltin wcontroller_proto[] = {
    WEBIDL_ATTRIBUTE("signal", wcontroller_signal, NULL),
    WEBIDL_OPERATION("error", wcontroller_error, 0),
};

static const JSBuiltin tstream_proto[] = {
    WEBIDL_ATTRIBUTE("readable", tstream_readable, NULL),
    WEBIDL_ATTRIBUTE("writable", tstream_writable, NULL),
};

static const JSBuiltin tcontroller_proto[] = {
    WEBIDL_ATTRIBUTE("desiredSize", tcontroller_desired_size, NULL),
    WEBIDL_OPERATION("enqueue", tcontroller_enqueue, 0),
    WEBIDL_OPERATION("error", tcontroller_error, 0),
    WEBIDL_OPERATION("terminate", tcontroller_terminate, 0),
};

static JSValue define(JSContext *ctx, JSObject *global, const char *name, JSNativeFn ctor, uint32_t length, JSIntrinsic slot,
                      const JSBuiltin *proto, size_t n, JSNativeFn inspect) {
    JSValue c = js_define_web_class(ctx, global, name, ctor, length, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], slot);
    JSValue p = ctx->intrinsics[slot];
    js_define_builtins(ctx, js_as_object(p), proto, n);
    js_define_inspect(ctx, p, inspect, name);
    return c;
}

void js_writable_streams_install(JSContext *ctx, JSObject *global) {
    define(ctx, global, "WritableStream", wstream_ctor, 0, JS_INTRINSIC_WRITABLE_STREAM_PROTOTYPE, wstream_proto, JS_COUNTOF(wstream_proto), wstream_inspect);
    define(ctx, global, "WritableStreamDefaultWriter", writer_ctor, 1, JS_INTRINSIC_WRITABLE_STREAM_WRITER_PROTOTYPE, writer_proto, JS_COUNTOF(writer_proto), writer_inspect);
    define(ctx, global, "WritableStreamDefaultController", illegal_ctor, 0, JS_INTRINSIC_WRITABLE_STREAM_CONTROLLER_PROTOTYPE, wcontroller_proto,
           JS_COUNTOF(wcontroller_proto), wcontroller_inspect);
    define(ctx, global, "TransformStream", tstream_ctor, 0, JS_INTRINSIC_TRANSFORM_STREAM_PROTOTYPE, tstream_proto, JS_COUNTOF(tstream_proto), tstream_inspect);
    define(ctx, global, "TransformStreamDefaultController", illegal_ctor, 0, JS_INTRINSIC_TRANSFORM_STREAM_CONTROLLER_PROTOTYPE, tcontroller_proto,
           JS_COUNTOF(tcontroller_proto), tcontroller_inspect);
}
