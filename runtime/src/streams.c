/* ReadableStream (WHATWG Streams §4), the streams component, as Node has it:
 * default streams (an underlying source's start, pull and cancel, a queuing strategy's
 * highWaterMark and size), their default reader and controller, async iteration, and tee. Byte
 * streams' BYOB readers aren't provided yet; `type: 'bytes'` makes a default stream. WritableStream,
 * TransformStream, pipeTo and pipeThrough are writable.c's. Streams the runtime makes
 * (a body's) have a C source: pull and cancel functions with a value they keep. Node's errors
 * (ERR_INVALID_STATE, ERR_INVALID_ARG_TYPE) and inspection. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_promise.h"
#include "js_symbol.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"
#include "streams.h"

/* A failure's -1, after the call that threw (the throwers' results must be used). */
static int fail(JSValue thrown) {
    (void)thrown;
    return -1;
}

enum { STATE_READABLE, STATE_CLOSED, STATE_ERRORED };

typedef struct StreamObject {
    JSObject obj;
    JSValue  controller;
    JSValue  reader;        /* a reader, or undefined */
    JSValue  stored_error;
    uint8_t  state;
    uint8_t  disturbed;
    uint8_t  bytes;         /* a byte stream (`type: 'bytes'`, a body): inspection's supportsBYOB */
} StreamObject;

typedef struct ControllerObject {
    JSObject obj;
    JSValue  stream;
    JSValue *queue;          /* chunk, size; … (a ring would do; reads shift the head) */
    uint32_t head, n, cap;   /* JSValues: [head, n) are queued */
    double   queue_size;
    double   high_water_mark;
    JSValue  size;           /* the strategy's size function, or undefined */
    JSValue  source;         /* the underlying source (`this` for its methods), or a C source's data */
    JSValue  pull, cancel;   /* functions, or undefined */
    const JSStreamSource *native;  /* a C source, or NULL */
    uint8_t  close_requested, pull_again, pulling, started;
} ControllerObject;

typedef struct ReaderObject {
    JSObject obj;
    JSValue  stream;         /* undefined once released */
    JSValue  closed;         /* a promise */
    JSValue  requests;       /* pending read() promises: an array */
} ReaderObject;

typedef struct AsyncIteratorObject {
    JSObject obj;
    JSValue  reader;
    uint8_t  prevent_cancel, done;
} AsyncIteratorObject;

static void stream_visit(JSCell *c, JSTracer *trc) {
    StreamObject *s = (StreamObject *)c;
    js_trace_value(trc, s->controller);
    js_trace_value(trc, s->reader);
    js_trace_value(trc, s->stored_error);
}
static void controller_visit(JSCell *c, JSTracer *trc) {
    ControllerObject *k = (ControllerObject *)c;
    js_trace_value(trc, k->stream);
    for (uint32_t i = k->head; i < k->n; i++) js_trace_value(trc, k->queue[i]);
    js_trace_value(trc, k->size);
    js_trace_value(trc, k->source);
    js_trace_value(trc, k->pull);
    js_trace_value(trc, k->cancel);
}
static void controller_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    free(((ControllerObject *)c)->queue);
}
static void reader_visit(JSCell *c, JSTracer *trc) {
    ReaderObject *r = (ReaderObject *)c;
    js_trace_value(trc, r->stream);
    js_trace_value(trc, r->closed);
    js_trace_value(trc, r->requests);
}
static void iterator_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((AsyncIteratorObject *)c)->reader); }

static const JSClass stream_class = { "ReadableStream", sizeof(StreamObject), NULL, NULL, NULL, NULL, stream_visit, NULL, NULL };
static const JSClass controller_class = { "ReadableStreamDefaultController", sizeof(ControllerObject), NULL, NULL, NULL, NULL, controller_visit, controller_finalize, NULL };
static const JSClass reader_class = { "ReadableStreamDefaultReader", sizeof(ReaderObject), NULL, NULL, NULL, NULL, reader_visit, NULL, NULL };
static const JSClass iterator_class = { "ReadableStreamAsyncIterator", sizeof(AsyncIteratorObject), NULL, NULL, NULL, NULL, iterator_visit, NULL, NULL };

#define AS(kind, type) \
    static type *as_##kind(JSValue v) { return js_is_object(v) && js_as_object(v)->shape->cls == &kind##_class ? (type *)js_as_object(v) : NULL; }
AS(stream, StreamObject)
AS(controller, ControllerObject)
AS(reader, ReaderObject)
AS(iterator, AsyncIteratorObject)

static JSValue invalid_state(JSContext *ctx, const char *what) {
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_STATE", "Invalid state: %s", what);
}

/* The error invalid_state throws, as a value (for rejections). */
static JSValue invalid_state_value(JSContext *ctx, const char *what) {
    JSValue r = invalid_state(ctx, what);
    (void)r;
    return js_take_exception(ctx);
}

static JSValue resolved(JSContext *ctx, JSValue v) {
    JSValue p = js_new_promise(ctx);
    js_promise_resolve_internal(ctx, p, v);
    return p;
}

static JSValue rejected(JSContext *ctx, JSValue reason) {
    JSValue p = js_new_promise(ctx);
    js_promise_reject_internal(ctx, p, reason);
    return p;
}

/* A rejection no one needs to handle (the spec's [[PromiseIsHandled]] = true). */
static void reject_handled(JSContext *ctx, JSValue p, JSValue reason) {
    js_as_promise(p)->is_handled = 1;
    js_promise_reject_internal(ctx, p, reason);
}

/* The pending exception as a rejected promise. */
static JSValue rejected_with_exception(JSContext *ctx) { return rejected(ctx, js_take_exception(ctx)); }

/* ---- The queue ------------------------------------------------------------------------------ */

static void queue_push(JSContext *ctx, ControllerObject *k, JSValue chunk, double size) {
    if (k->head > 0 && k->n == k->cap) {  /* reclaim what reads consumed */
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

static bool queue_empty(const ControllerObject *k) { return k->head == k->n; }

static JSValue queue_shift(ControllerObject *k) {
    JSValue chunk = k->queue[k->head];
    k->queue_size -= js_as_number(k->queue[k->head + 1]);
    if (k->queue_size < 0) k->queue_size = 0;
    k->head += 2;
    if (k->head == k->n) k->head = k->n = 0;
    return chunk;
}

static void queue_reset(ControllerObject *k) {
    k->head = k->n = 0;
    k->queue_size = 0;
}

/* ---- Stream algorithms (§4.9) --------------------------------------------------------------- */

static ControllerObject *controller_of(StreamObject *s) { return as_controller(s->controller); }

static uint32_t request_count(StreamObject *s) {
    ReaderObject *r = as_reader(s->reader);
    return r ? js_array_length(js_as_object(r->requests)) : 0;
}

/* The oldest pending read, removed. */
static JSValue take_request(JSContext *ctx, ReaderObject *r) {
    JSObject *a = js_as_object(r->requests);
    uint32_t n = js_array_length(a);
    JSValue first = js_get_elem(ctx, r->requests, js_int32(0));
    JSValue rest = js_new_array(ctx, n ? n - 1 : 0);
    for (uint32_t i = 1; i < n; i++) {
        JSValue v = js_get_elem(ctx, r->requests, js_int32((int32_t)i));
        if (js_is_exception(v) || js_array_push(ctx, js_as_object(rest), v) < 0) js_discard(js_take_exception(ctx));
    }
    js_store(ctx, &r->obj.cell, &r->requests, rest);
    return first;
}

static void clear_algorithms(JSContext *ctx, ControllerObject *k) {
    js_store(ctx, &k->obj.cell, &k->pull, JS_UNDEFINED);
    js_store(ctx, &k->obj.cell, &k->cancel, JS_UNDEFINED);
    js_store(ctx, &k->obj.cell, &k->size, JS_UNDEFINED);
    k->native = NULL;
}

static void stream_close(JSContext *ctx, StreamObject *s) {
    s->state = STATE_CLOSED;
    ReaderObject *r = as_reader(s->reader);
    if (!r) return;
    js_promise_resolve_internal(ctx, r->closed, JS_UNDEFINED);
    while (js_array_length(js_as_object(r->requests))) {
        JSValue p = take_request(ctx, r);
        js_promise_resolve_internal(ctx, p, js_iter_result(ctx, JS_UNDEFINED, true));
    }
}

static void stream_error(JSContext *ctx, StreamObject *s, JSValue e) {
    if (s->state != STATE_READABLE) return;
    s->state = STATE_ERRORED;
    js_store(ctx, &s->obj.cell, &s->stored_error, e);
    ReaderObject *r = as_reader(s->reader);
    if (!r) return;
    reject_handled(ctx, r->closed, e);
    while (js_array_length(js_as_object(r->requests))) {
        JSValue p = take_request(ctx, r);
        js_promise_reject_internal(ctx, p, e);
    }
}

static bool can_close_or_enqueue(const ControllerObject *k) {
    return !k->close_requested && as_stream(k->stream)->state == STATE_READABLE;
}

static double desired_size(const ControllerObject *k) { return k->high_water_mark - k->queue_size; }

static void controller_error(JSContext *ctx, ControllerObject *k, JSValue e) {
    StreamObject *s = as_stream(k->stream);
    if (s->state != STATE_READABLE) return;
    queue_reset(k);
    clear_algorithms(ctx, k);
    stream_error(ctx, s, e);
}

static void call_pull_if_needed(JSContext *ctx, ControllerObject *k);

BUILTIN(pull_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    ControllerObject *k = as_controller(js_closure_data(callee));
    k->pulling = 0;
    if (k->pull_again) {
        k->pull_again = 0;
        call_pull_if_needed(ctx, k);
    }
    return JS_UNDEFINED;
}

BUILTIN(pull_rejected) {
    (void)this_val, (void)new_target;
    controller_error(ctx, as_controller(js_closure_data(callee)), ARG(0));
    return JS_UNDEFINED;
}

/* A source method's result as a promise: an exception becomes a rejection. */
static JSValue promise_of(JSContext *ctx, JSValue r) {
    if (js_is_exception(r)) return rejected_with_exception(ctx);
    JSValue p = js_promise_resolve(ctx, r);
    return js_is_exception(p) ? rejected_with_exception(ctx) : p;
}

static void call_pull_if_needed(JSContext *ctx, ControllerObject *k) {
    StreamObject *s = as_stream(k->stream);
    if (!can_close_or_enqueue(k) || !k->started) return;
    if (!(request_count(s) > 0 || desired_size(k) > 0)) return;
    if (k->pulling) {
        k->pull_again = 1;
        return;
    }
    JSValue kv = js_object_value(&k->obj);
    JSValue p;
    if (k->native) p = promise_of(ctx, k->native->pull(ctx, kv, k->source));
    else if (js_is_undefined(k->pull)) p = resolved(ctx, JS_UNDEFINED);
    else p = promise_of(ctx, js_call(ctx, k->pull, k->source, 1, &kv));
    k->pulling = 1;
    js_promise_then_internal(ctx, p, js_new_closure_native(ctx, pull_fulfilled, 1, kv), js_new_closure_native(ctx, pull_rejected, 1, kv), JS_UNDEFINED);
}

/* ReadableStreamDefaultControllerEnqueue: 0, or -1 with an exception */
static int enqueue(JSContext *ctx, ControllerObject *k, JSValue chunk) {
    if (!can_close_or_enqueue(k)) return fail(invalid_state(ctx, "Controller is already closed"));
    StreamObject *s = as_stream(k->stream);
    ReaderObject *r = as_reader(s->reader);
    if (r && request_count(s) > 0) {
        JSValue p = take_request(ctx, r);
        js_promise_resolve_internal(ctx, p, js_iter_result(ctx, chunk, false));
    } else {
        double size = 1;
        if (!js_is_undefined(k->size)) {
            JSValue sv = js_call(ctx, k->size, JS_UNDEFINED, 1, &chunk);
            if (js_is_exception(sv) || js_to_number(ctx, &size, sv) < 0) {
                JSValue e = js_take_exception(ctx);
                controller_error(ctx, k, e);
                return fail(js_throw(ctx, e));
            }
            if (!(size >= 0) || isinf(size)) {
                JSValue e = js_new_error(ctx, JS_RANGE_ERROR, js_new_string_cstr(ctx, "Invalid size"));
                controller_error(ctx, k, e);
                return fail(js_throw(ctx, e));
            }
        }
        queue_push(ctx, k, chunk, size);
    }
    call_pull_if_needed(ctx, k);
    return 0;
}

static int close_controller(JSContext *ctx, ControllerObject *k) {
    if (!can_close_or_enqueue(k)) return fail(invalid_state(ctx, "Controller is already closed"));
    k->close_requested = 1;
    if (queue_empty(k)) {
        clear_algorithms(ctx, k);
        stream_close(ctx, as_stream(k->stream));
    }
    return 0;
}

BUILTIN(cancel_fulfilled) {
    UNUSED_ARGS;
    return JS_UNDEFINED;
}

/* ReadableStreamCancel: a promise */
static JSValue stream_cancel(JSContext *ctx, StreamObject *s, JSValue reason) {
    s->disturbed = 1;
    if (s->state == STATE_CLOSED) return resolved(ctx, JS_UNDEFINED);
    if (s->state == STATE_ERRORED) return rejected(ctx, s->stored_error);
    stream_close(ctx, s);
    ControllerObject *k = controller_of(s);
    queue_reset(k);
    JSValue r;
    if (k->native) r = k->native->cancel ? k->native->cancel(ctx, k->source, reason) : JS_UNDEFINED;
    else if (js_is_undefined(k->cancel)) r = JS_UNDEFINED;
    else r = js_call(ctx, k->cancel, k->source, 1, &reason);
    clear_algorithms(ctx, k);
    JSValue p = promise_of(ctx, r);
    JSValue derived = js_new_promise(ctx);
    js_promise_then_internal(ctx, p, js_new_native(ctx, cancel_fulfilled, js_empty_string(), 0, JS_FN_STRICT), JS_UNDEFINED, derived);
    return derived;
}

/* ---- Setting up ----------------------------------------------------------------------------- */

BUILTIN(start_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    ControllerObject *k = as_controller(js_closure_data(callee));
    k->started = 1;
    call_pull_if_needed(ctx, k);
    return JS_UNDEFINED;
}

static JSValue new_stream(JSContext *ctx, JSValue proto, double hwm, JSValue size) {
    StreamObject *s = (StreamObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &stream_class, proto, 4));
    js_init_slot(&s->controller, JS_UNDEFINED);
    js_init_slot(&s->reader, JS_UNDEFINED);
    js_init_slot(&s->stored_error, JS_UNDEFINED);
    s->state = STATE_READABLE;
    s->disturbed = 0;
    s->bytes = 0;
    JSValue sv = js_object_value(&s->obj);
    ControllerObject *k = (ControllerObject *)js_alloc_object(ctx, JS_CELL_OBJECT,
        js_shape_root(ctx, &controller_class, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_CONTROLLER_PROTOTYPE], 0));
    js_init_slot(&k->stream, sv);
    k->queue = NULL;
    k->head = k->n = k->cap = 0;
    k->queue_size = 0;
    k->high_water_mark = hwm;
    js_init_slot(&k->size, size);
    js_init_slot(&k->source, JS_UNDEFINED);
    js_init_slot(&k->pull, JS_UNDEFINED);
    js_init_slot(&k->cancel, JS_UNDEFINED);
    k->native = NULL;
    k->close_requested = k->pull_again = k->pulling = k->started = 0;
    js_store(ctx, &s->obj.cell, &s->controller, js_object_value(&k->obj));
    return sv;
}

/* A method of the underlying source: a function, or undefined. */
static JSValue source_method(JSContext *ctx, JSValue source, const char *name) {
    if (!js_is_object(source)) return JS_UNDEFINED;
    JSValue f = js_get_value(ctx, source, js_atom_from_cstr(ctx, name));
    if (js_is_exception(f) || js_is_undefined(f) || js_is_callable(f)) return f;
    char received[256];
    js_node_received(ctx, f, received, sizeof received);
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "The \"source.%s\" property must be of type function.%s", name, received);
}

/* new ReadableStream(underlyingSource, { highWaterMark, size }) */
BUILTIN(stream_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "ReadableStream");
    JSValue source = ARG(0), strategy = ARG(1);
    if (!js_is_undefined(source) && !js_is_object(source)) return js_throw_invalid_arg_type(ctx, "source", "of type object", source);
    if (!js_is_undefined(strategy) && !js_is_object(strategy)) return js_throw_invalid_arg_type(ctx, "strategy", "of type object", strategy);
    JSValue start = source_method(ctx, source, "start");
    if (js_is_exception(start)) return start;
    JSValue pull = source_method(ctx, source, "pull");
    if (js_is_exception(pull)) return pull;
    JSValue cancel = source_method(ctx, source, "cancel");
    if (js_is_exception(cancel)) return cancel;
    double hwm = 1;
    JSValue size = JS_UNDEFINED;
    if (js_is_object(strategy)) {
        JSValue h = js_get_value(ctx, strategy, js_atom_from_cstr(ctx, "highWaterMark"));
        if (js_is_exception(h)) return h;
        if (!js_is_undefined(h)) {
            if (js_to_number(ctx, &hwm, h) < 0) return JS_EXCEPTION;
            if (isnan(hwm) || hwm < 0) {
                char received[64];
                js_describe_value(ctx, h, received, sizeof received);
                return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_INVALID_ARG_VALUE", "The property 'strategy.highWaterMark' is invalid. Received %s", received);
            }
        }
        size = js_get_value(ctx, strategy, js_atom_from_cstr(ctx, "size"));
        if (js_is_exception(size)) return size;
        if (!js_is_undefined(size) && !js_is_callable(size)) {
            char received[256];
            js_node_received(ctx, size, received, sizeof received);
            return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "The \"strategy.size\" property must be of type function.%s", received);
        }
    }
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_READABLE_STREAM_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    JSValue type = js_is_object(source) ? js_get_value(ctx, source, js_atom_from_cstr(ctx, "type")) : JS_UNDEFINED;
    if (js_is_exception(type)) return type;
    JSValue sv = new_stream(ctx, proto, hwm, size);
    as_stream(sv)->bytes = js_is_string(type) && js_string_length(type) == 5;  /* 'bytes' */
    ControllerObject *k = controller_of(as_stream(sv));
    js_store(ctx, &k->obj.cell, &k->source, source);
    js_store(ctx, &k->obj.cell, &k->pull, pull);
    js_store(ctx, &k->obj.cell, &k->cancel, cancel);
    JSValue kv = js_object_value(&k->obj);
    JSValue r = js_is_undefined(start) ? JS_UNDEFINED : js_call(ctx, start, source, 1, &kv);
    if (js_is_exception(r)) return r;  /* start throwing makes the constructor throw */
    JSValue p = promise_of(ctx, r);
    js_promise_then_internal(ctx, p, js_new_closure_native(ctx, start_fulfilled, 1, kv), js_new_closure_native(ctx, pull_rejected, 1, kv), JS_UNDEFINED);
    return sv;
}

JSValue js_rs_new(JSContext *ctx, const JSStreamSource *source, JSValue data, double hwm, JSValue size, JSValue start) {
    JSValue sv = new_stream(ctx, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_PROTOTYPE], hwm, size);
    ControllerObject *k = controller_of(as_stream(sv));
    k->native = source;
    js_store(ctx, &k->obj.cell, &k->source, data);
    JSValue kv = js_object_value(&k->obj);
    JSValue p = js_is_undefined(start) ? resolved(ctx, JS_UNDEFINED) : start;
    js_promise_then_internal(ctx, p, js_new_closure_native(ctx, start_fulfilled, 1, kv), js_new_closure_native(ctx, pull_rejected, 1, kv), JS_UNDEFINED);
    return sv;
}

JSValue js_new_readable_stream(JSContext *ctx, const JSStreamSource *source, JSValue data, double high_water_mark) {
    return js_rs_new(ctx, source, data, high_water_mark, JS_UNDEFINED, JS_UNDEFINED);
}

/* A closed stream of one chunk (none when undefined): a byte stream, or not */
static JSValue stream_of(JSContext *ctx, JSValue chunk, bool bytes) {
    JSValue sv = new_stream(ctx, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_PROTOTYPE], 0, JS_UNDEFINED);
    as_stream(sv)->bytes = bytes;
    ControllerObject *k = controller_of(as_stream(sv));
    k->started = 1;
    if (!js_is_undefined(chunk) && enqueue(ctx, k, chunk) < 0) return JS_EXCEPTION;
    return close_controller(ctx, k) < 0 ? JS_EXCEPTION : sv;
}

JSValue js_readable_stream_of_bytes(JSContext *ctx, JSValue chunk) { return stream_of(ctx, chunk, true); }
JSValue js_readable_stream_of_chunk(JSContext *ctx, JSValue chunk) { return stream_of(ctx, chunk, false); }

/* ---- ReadableStream.prototype --------------------------------------------------------------- */

#define THIS_STREAM()                         \
    StreamObject *s = as_stream(this_val);     \
    if (!s) return js_throw_invalid_this(ctx, "ReadableStream")

BUILTIN(stream_locked) {
    UNUSED_ARGS;
    THIS_STREAM();
    return js_bool(!js_is_undefined(s->reader));
}

BUILTIN(stream_cancel_method) {
    UNUSED_ARGS;
    StreamObject *s = as_stream(this_val);
    if (!s) return rejected(ctx, invalid_state_value(ctx, "The ReadableStream is not a ReadableStream"));
    if (!js_is_undefined(s->reader)) return rejected(ctx, invalid_state_value(ctx, "ReadableStream is locked"));
    return stream_cancel(ctx, s, ARG(0));
}

static JSValue new_reader(JSContext *ctx, JSValue proto, JSValue sv) {
    StreamObject *s = as_stream(sv);
    ReaderObject *r = (ReaderObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &reader_class, proto, 0));
    js_init_slot(&r->stream, sv);
    js_init_slot(&r->closed, JS_UNDEFINED);
    js_init_slot(&r->requests, JS_UNDEFINED);
    JSValue rv = js_object_value(&r->obj);
    js_store(ctx, &r->obj.cell, &r->requests, js_new_array(ctx, 0));
    JSValue closed = js_new_promise(ctx);
    js_store(ctx, &r->obj.cell, &r->closed, closed);
    if (s->state == STATE_CLOSED) js_promise_resolve_internal(ctx, closed, JS_UNDEFINED);
    else if (s->state == STATE_ERRORED) reject_handled(ctx, closed, s->stored_error);
    js_store(ctx, &s->obj.cell, &s->reader, rv);
    return rv;
}

/* getReader({ mode }) */
BUILTIN(stream_get_reader) {
    UNUSED_ARGS;
    THIS_STREAM();
    JSValue options = ARG(0);
    if (js_is_object(options)) {
        JSValue mode = js_get_value(ctx, options, js_atom_from_cstr(ctx, "mode"));
        if (js_is_exception(mode)) return mode;
        if (!js_is_undefined(mode))
            return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_VISALJS_UNSUPPORTED", "ReadableStream BYOB readers are not supported yet");
    }
    if (!js_is_undefined(s->reader)) return invalid_state(ctx, "ReadableStream is locked");
    return new_reader(ctx, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE], this_val);
}

/* `ReadableStream { locked: false, state: 'readable', supportsBYOB: false }` */
BUILTIN(stream_inspect) {
    UNUSED_ARGS;
    THIS_STREAM();
    static const char *const states[] = { "readable", "closed", "errored" };
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "locked"), js_bool(!js_is_undefined(s->reader)), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "state"), js_new_string_cstr(ctx, states[s->state]), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "supportsBYOB"), js_bool(s->bytes), JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "ReadableStream", o, ARG(0), ARG(1));
}

/* ---- Reader --------------------------------------------------------------------------------- */

#define THIS_READER()                         \
    ReaderObject *r = as_reader(this_val);     \
    if (!r) return js_throw_invalid_this(ctx, "ReadableStreamDefaultReader")

BUILTIN(reader_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "ReadableStreamDefaultReader");
    if (!as_stream(ARG(0))) return js_throw_invalid_arg_type(ctx, "stream", "an instance of ReadableStream", ARG(0));
    if (!js_is_undefined(as_stream(ARG(0))->reader)) return invalid_state(ctx, "ReadableStream is locked");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    return new_reader(ctx, proto, ARG(0));
}

/* A chunk read at once from the queue: Node 24's fast path makes it { done: false, value }, where
 * a read that waits for its chunk gets { value, done: false } */
static JSValue queued_result(JSContext *ctx, JSValue chunk) {
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), JS_ATOM(done), JS_FALSE, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), JS_ATOM(value), chunk, JS_PROP_DEFAULT);
    return o;
}

/* ReadableStreamDefaultReaderRead: a promise of { value, done } */
static JSValue reader_read(JSContext *ctx, ReaderObject *r) {
    StreamObject *s = as_stream(r->stream);
    if (!s) return rejected(ctx, invalid_state_value(ctx, "The reader is not attached to a stream"));
    s->disturbed = 1;
    if (s->state == STATE_CLOSED) return resolved(ctx, js_iter_result(ctx, JS_UNDEFINED, true));
    if (s->state == STATE_ERRORED) return rejected(ctx, s->stored_error);
    ControllerObject *k = controller_of(s);
    if (!queue_empty(k)) {
        JSValue chunk = queue_shift(k);
        if (k->close_requested && queue_empty(k)) {
            clear_algorithms(ctx, k);
            stream_close(ctx, s);
        } else {
            call_pull_if_needed(ctx, k);
        }
        return resolved(ctx, queued_result(ctx, chunk));
    }
    JSValue p = js_new_promise(ctx);
    if (js_array_push(ctx, js_as_object(r->requests), p) < 0) return JS_EXCEPTION;
    call_pull_if_needed(ctx, k);
    return p;
}

BUILTIN(reader_read_method) {
    UNUSED_ARGS;
    ReaderObject *r = as_reader(this_val);
    if (!r) return rejected(ctx, invalid_state_value(ctx, "The reader is not a ReadableStreamDefaultReader"));
    return reader_read(ctx, r);
}

static void release(JSContext *ctx, ReaderObject *r) {
    StreamObject *s = as_stream(r->stream);
    if (!s) return;
    JSValue e = invalid_state_value(ctx, "Reader released");
    if (s->state == STATE_READABLE) reject_handled(ctx, r->closed, e);
    else {
        JSValue closed = js_new_promise(ctx);
        reject_handled(ctx, closed, e);
        js_store(ctx, &r->obj.cell, &r->closed, closed);
    }
    while (js_array_length(js_as_object(r->requests))) {
        JSValue p = take_request(ctx, r);
        js_promise_reject_internal(ctx, p, e);
    }
    js_store(ctx, &s->obj.cell, &s->reader, JS_UNDEFINED);
    js_store(ctx, &r->obj.cell, &r->stream, JS_UNDEFINED);
}

BUILTIN(reader_release_lock) {
    UNUSED_ARGS;
    THIS_READER();
    release(ctx, r);
    return JS_UNDEFINED;
}

BUILTIN(reader_closed) {
    UNUSED_ARGS;
    ReaderObject *r = as_reader(this_val);
    if (!r) return rejected(ctx, invalid_state_value(ctx, "The reader is not a ReadableStreamDefaultReader"));
    return r->closed;
}

BUILTIN(reader_cancel) {
    UNUSED_ARGS;
    ReaderObject *r = as_reader(this_val);
    if (!r) return rejected(ctx, invalid_state_value(ctx, "The reader is not a ReadableStreamDefaultReader"));
    StreamObject *s = as_stream(r->stream);
    if (!s) return rejected(ctx, invalid_state_value(ctx, "The reader is not attached to a stream"));
    return stream_cancel(ctx, s, ARG(0));
}

/* `ReadableStreamDefaultReader { stream: …, readRequests: 0, close: Promise { … } }` */
BUILTIN(reader_inspect) {
    UNUSED_ARGS;
    THIS_READER();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "stream"), r->stream, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "readRequests"), js_int32((int32_t)js_array_length(js_as_object(r->requests))), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "close"), r->closed, JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "ReadableStreamDefaultReader", o, ARG(0), ARG(1));
}

/* ---- Controller ----------------------------------------------------------------------------- */

#define THIS_CONTROLLER()                         \
    ControllerObject *k = as_controller(this_val); \
    if (!k) return js_throw_invalid_this(ctx, "ReadableStreamDefaultController")

BUILTIN(controller_ctor) {
    UNUSED_ARGS;
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
}

BUILTIN(controller_desired_size) {
    UNUSED_ARGS;
    THIS_CONTROLLER();
    uint8_t state = as_stream(k->stream)->state;
    return state == STATE_ERRORED ? JS_NULL : state == STATE_CLOSED ? js_int32(0) : js_number(desired_size(k));
}

BUILTIN(controller_close) {
    UNUSED_ARGS;
    THIS_CONTROLLER();
    return close_controller(ctx, k) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

BUILTIN(controller_enqueue) {
    UNUSED_ARGS;
    THIS_CONTROLLER();
    return enqueue(ctx, k, ARG(0)) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

BUILTIN(controller_error_method) {
    UNUSED_ARGS;
    THIS_CONTROLLER();
    controller_error(ctx, k, ARG(0));
    return JS_UNDEFINED;
}

BUILTIN(controller_inspect) {
    UNUSED_ARGS;
    return js_inspect_as(ctx, this_val, "ReadableStreamDefaultController", js_new_object(ctx), ARG(0), ARG(1));
}

/* ---- Async iteration ------------------------------------------------------------------------ */

/* values({ preventCancel }) and [Symbol.asyncIterator]() */
BUILTIN(stream_values) {
    UNUSED_ARGS;
    THIS_STREAM();
    bool prevent_cancel = false;
    if (js_is_object(ARG(0))) {
        JSValue v = js_get_value(ctx, ARG(0), js_atom_from_cstr(ctx, "preventCancel"));
        if (js_is_exception(v)) return v;
        prevent_cancel = js_truthy(v);
    }
    if (!js_is_undefined(s->reader)) return invalid_state(ctx, "ReadableStream is locked");
    JSValue reader = new_reader(ctx, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE], this_val);
    AsyncIteratorObject *it = (AsyncIteratorObject *)js_alloc_object(ctx, JS_CELL_OBJECT,
        js_shape_root(ctx, &iterator_class, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_ITERATOR_PROTOTYPE], 0));
    js_init_slot(&it->reader, reader);
    it->prevent_cancel = prevent_cancel;
    it->done = 0;
    return js_object_value(&it->obj);
}

/* A read's result settles the iterator: done releases the reader; an error does too. */
BUILTIN(iter_read_fulfilled) {
    (void)this_val, (void)new_target;
    AsyncIteratorObject *it = as_iterator(js_closure_data(callee));
    JSValue result = ARG(0);
    JSValue done = js_get_value(ctx, result, JS_ATOM(done));
    if (js_is_exception(done)) return done;
    if (js_truthy(done)) {
        it->done = 1;
        release(ctx, as_reader(it->reader));
    }
    return result;
}

BUILTIN(iter_read_rejected) {
    (void)this_val, (void)new_target;
    AsyncIteratorObject *it = as_iterator(js_closure_data(callee));
    it->done = 1;
    release(ctx, as_reader(it->reader));
    return js_throw(ctx, ARG(0));
}

BUILTIN(iterator_next) {
    UNUSED_ARGS;
    AsyncIteratorObject *it = as_iterator(this_val);
    if (!it) return rejected(ctx, invalid_state_value(ctx, "The object is not a ReadableStreamAsyncIterator"));
    if (it->done) return resolved(ctx, js_iter_result(ctx, JS_UNDEFINED, true));
    ReaderObject *r = as_reader(it->reader);
    if (!as_stream(r->stream)) return rejected(ctx, invalid_state_value(ctx, "The reader is not attached to a stream"));
    JSValue p = reader_read(ctx, r);
    JSValue derived = js_new_promise(ctx);
    js_promise_then_internal(ctx, p, js_new_closure_native(ctx, iter_read_fulfilled, 1, this_val),
                             js_new_closure_native(ctx, iter_read_rejected, 1, this_val), derived);
    return derived;
}

BUILTIN(iter_return_fulfilled) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    return js_iter_result(ctx, js_closure_data(callee), true);
}

/* return(value): cancels the stream (unless preventCancel) and releases the reader */
BUILTIN(iterator_return) {
    UNUSED_ARGS;
    AsyncIteratorObject *it = as_iterator(this_val);
    if (!it) return rejected(ctx, invalid_state_value(ctx, "The object is not a ReadableStreamAsyncIterator"));
    JSValue value = ARG(0);
    if (it->done) return resolved(ctx, js_iter_result(ctx, value, true));
    it->done = 1;
    ReaderObject *r = as_reader(it->reader);
    StreamObject *s = as_stream(r->stream);
    if (!s) return resolved(ctx, js_iter_result(ctx, value, true));
    JSValue p = it->prevent_cancel ? resolved(ctx, JS_UNDEFINED) : stream_cancel(ctx, s, value);
    release(ctx, r);
    JSValue derived = js_new_promise(ctx);
    js_promise_then_internal(ctx, p, js_new_closure_native(ctx, iter_return_fulfilled, 1, value), JS_UNDEFINED, derived);
    return derived;
}

/* ---- tee (§4.9.1 ReadableStreamDefaultTee) -------------------------------------------------- */

/* The tee's state: [reader, branch1, branch2, reading, readAgain, canceled1, canceled2, reason1, reason2, cancelPromise] */
enum { T_READER, T_B1, T_B2, T_READING, T_AGAIN, T_C1, T_C2, T_R1, T_R2, T_CANCEL, T_COUNT };

static JSValue tget(JSContext *ctx, JSValue t, int i) { return js_get_elem(ctx, t, js_int32(i)); }
static void tset(JSContext *ctx, JSValue t, int i, JSValue v) {
    if (js_set_elem(ctx, t, js_int32(i), v, true) < 0) js_discard(js_take_exception(ctx));
}

static JSValue tee_pull(JSContext *ctx, JSValue controller, JSValue t);

BUILTIN(tee_chunk) {
    (void)this_val, (void)new_target;
    JSValue t = js_closure_data(callee);
    JSValue result = ARG(0);
    JSValue done = js_get_value(ctx, result, JS_ATOM(done));
    if (js_is_exception(done)) return done;
    JSValue b1 = tget(ctx, t, T_B1), b2 = tget(ctx, t, T_B2);
    if (js_truthy(done)) {
        tset(ctx, t, T_READING, JS_FALSE);
        if (!js_truthy(tget(ctx, t, T_C1)) && can_close_or_enqueue(controller_of(as_stream(b1)))) (void)close_controller(ctx, controller_of(as_stream(b1)));
        if (!js_truthy(tget(ctx, t, T_C2)) && can_close_or_enqueue(controller_of(as_stream(b2)))) (void)close_controller(ctx, controller_of(as_stream(b2)));
        JSValue cp = tget(ctx, t, T_CANCEL);
        if (js_is_promise(cp)) js_promise_resolve_internal(ctx, cp, JS_UNDEFINED);
        return JS_UNDEFINED;
    }
    JSValue chunk = js_get_value(ctx, result, JS_ATOM(value));
    if (js_is_exception(chunk)) return chunk;
    if (!js_truthy(tget(ctx, t, T_C1)) && can_close_or_enqueue(controller_of(as_stream(b1))) && enqueue(ctx, controller_of(as_stream(b1)), chunk) < 0)
        js_discard(js_take_exception(ctx));
    if (!js_truthy(tget(ctx, t, T_C2)) && can_close_or_enqueue(controller_of(as_stream(b2))) && enqueue(ctx, controller_of(as_stream(b2)), chunk) < 0)
        js_discard(js_take_exception(ctx));
    tset(ctx, t, T_READING, JS_FALSE);
    if (js_truthy(tget(ctx, t, T_AGAIN))) {
        tset(ctx, t, T_AGAIN, JS_FALSE);
        (void)tee_pull(ctx, JS_UNDEFINED, t);
    }
    return JS_UNDEFINED;
}

BUILTIN(tee_error) {
    (void)this_val, (void)new_target;
    JSValue t = js_closure_data(callee);
    tset(ctx, t, T_READING, JS_FALSE);
    controller_error(ctx, controller_of(as_stream(tget(ctx, t, T_B1))), ARG(0));
    controller_error(ctx, controller_of(as_stream(tget(ctx, t, T_B2))), ARG(0));
    JSValue cp = tget(ctx, t, T_CANCEL);
    if (js_is_promise(cp)) js_promise_resolve_internal(ctx, cp, JS_UNDEFINED);
    return JS_UNDEFINED;
}

static JSValue tee_pull(JSContext *ctx, JSValue controller, JSValue t) {
    (void)controller;
    if (js_truthy(tget(ctx, t, T_READING))) {
        tset(ctx, t, T_AGAIN, JS_TRUE);
        return JS_UNDEFINED;
    }
    tset(ctx, t, T_READING, JS_TRUE);
    JSValue p = reader_read(ctx, as_reader(tget(ctx, t, T_READER)));
    js_promise_then_internal(ctx, p, js_new_closure_native(ctx, tee_chunk, 1, t), js_new_closure_native(ctx, tee_error, 1, t), JS_UNDEFINED);
    return JS_UNDEFINED;
}

static JSValue tee_cancel(JSContext *ctx, JSValue t, JSValue reason, int which) {
    tset(ctx, t, which == 1 ? T_C1 : T_C2, JS_TRUE);
    tset(ctx, t, which == 1 ? T_R1 : T_R2, reason);
    JSValue cp = tget(ctx, t, T_CANCEL);
    if (js_truthy(tget(ctx, t, T_C1)) && js_truthy(tget(ctx, t, T_C2))) {
        JSValue reasons[2] = { tget(ctx, t, T_R1), tget(ctx, t, T_R2) };
        JSValue composite = js_new_array_from(ctx, reasons, 2);
        StreamObject *s = as_stream(as_reader(tget(ctx, t, T_READER))->stream);
        if (s) {
            JSValue r = stream_cancel(ctx, s, composite);
            js_promise_then_internal(ctx, r, JS_UNDEFINED, JS_UNDEFINED, cp);
        }
    }
    return cp;
}

static JSValue tee_cancel1(JSContext *ctx, JSValue t, JSValue reason) { return tee_cancel(ctx, t, reason, 1); }
static JSValue tee_cancel2(JSContext *ctx, JSValue t, JSValue reason) { return tee_cancel(ctx, t, reason, 2); }

static const JSStreamSource tee_source1 = { tee_pull, tee_cancel1 };
static const JSStreamSource tee_source2 = { tee_pull, tee_cancel2 };

JSValue js_readable_stream_tee(JSContext *ctx, JSValue stream) {
    StreamObject *s = as_stream(stream);
    if (!js_is_undefined(s->reader)) return invalid_state(ctx, "ReadableStream is locked");
    JSValue t = js_new_array(ctx, T_COUNT);
    for (int i = 0; i < T_COUNT; i++) tset(ctx, t, i, JS_FALSE);
    tset(ctx, t, T_READER, new_reader(ctx, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE], stream));
    tset(ctx, t, T_CANCEL, js_new_promise(ctx));
    JSValue b1 = js_new_readable_stream(ctx, &tee_source1, t, 1);
    tset(ctx, t, T_B1, b1);
    JSValue b2 = js_new_readable_stream(ctx, &tee_source2, t, 1);
    tset(ctx, t, T_B2, b2);
    JSValue pair[2] = { b1, b2 };
    return js_new_array_from(ctx, pair, 2);
}

BUILTIN(stream_tee) {
    UNUSED_ARGS;
    THIS_STREAM();
    (void)s;
    return js_readable_stream_tee(ctx, this_val);
}


/* ---- For writable.c (streams.h) ----------------------------------------------------------- */

int js_rs_state(JSValue stream) { return as_stream(stream)->state; }
JSValue js_rs_stored_error(JSValue stream) { return as_stream(stream)->stored_error; }
bool js_rs_locked(JSValue stream) { return !js_is_undefined(as_stream(stream)->reader); }
JSValue js_rs_controller(JSValue stream) { return as_stream(stream)->controller; }
JSValue js_rs_cancel(JSContext *ctx, JSValue stream, JSValue reason) { return stream_cancel(ctx, as_stream(stream), reason); }
bool js_rs_can_close_or_enqueue(JSValue controller) { return can_close_or_enqueue(as_controller(controller)); }

bool js_rs_has_backpressure(JSValue controller) {
    ControllerObject *k = as_controller(controller);
    StreamObject *s = as_stream(k->stream);
    bool should_pull = can_close_or_enqueue(k) && k->started && (request_count(s) > 0 || desired_size(k) > 0);
    return !should_pull;
}

JSValue js_rs_desired_size(JSValue controller) {
    ControllerObject *k = as_controller(controller);
    uint8_t state = as_stream(k->stream)->state;
    return state == STATE_ERRORED ? JS_NULL : state == STATE_CLOSED ? js_int32(0) : js_number(desired_size(k));
}

JSValue js_rs_reader(JSContext *ctx, JSValue stream) {
    if (!js_is_undefined(as_stream(stream)->reader)) return invalid_state(ctx, "ReadableStream is locked");
    return new_reader(ctx, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE], stream);
}
JSValue js_rs_read(JSContext *ctx, JSValue reader) { return reader_read(ctx, as_reader(reader)); }
JSValue js_rs_reader_closed(JSValue reader) { return as_reader(reader)->closed; }
void js_rs_release(JSContext *ctx, JSValue reader) { release(ctx, as_reader(reader)); }

JSValue js_streams_resolved(JSContext *ctx, JSValue v) { return resolved(ctx, v); }
JSValue js_streams_rejected(JSContext *ctx, JSValue reason) { return rejected(ctx, reason); }
JSValue js_streams_promise_of(JSContext *ctx, JSValue r) { return promise_of(ctx, r); }
void js_streams_reject_handled(JSContext *ctx, JSValue promise, JSValue reason) { reject_handled(ctx, promise, reason); }
JSValue js_streams_invalid_state(JSContext *ctx, const char *what) { return invalid_state_value(ctx, what); }

/* ---- C callers (the fetch component's bodies) ----------------------------------------------- */

bool js_is_readable_stream(JSValue v) { return as_stream(v) != NULL; }
bool js_readable_stream_locked(JSValue v) { return !js_is_undefined(as_stream(v)->reader); }
bool js_readable_stream_disturbed(JSValue v) { return as_stream(v)->disturbed != 0; }

int js_readable_stream_enqueue(JSContext *ctx, JSValue controller, JSValue chunk) { return enqueue(ctx, as_controller(controller), chunk); }
int js_readable_stream_close(JSContext *ctx, JSValue controller) { return close_controller(ctx, as_controller(controller)); }
void js_readable_stream_error(JSContext *ctx, JSValue controller, JSValue e) { controller_error(ctx, as_controller(controller), e); }

/* Reading a whole stream of byte chunks: the state is [reader, chunks array, total, result promise]. */
BUILTIN(read_all_step);

BUILTIN(read_all_failed) {
    (void)this_val, (void)new_target;
    JSValue state = js_closure_data(callee);
    js_promise_reject_internal(ctx, js_get_elem(ctx, state, js_int32(3)), ARG(0));
    return JS_UNDEFINED;
}

static void read_all_next(JSContext *ctx, JSValue state) {
    JSValue reader = js_get_elem(ctx, state, js_int32(0));
    JSValue p = reader_read(ctx, as_reader(reader));
    js_promise_then_internal(ctx, p, js_new_closure_native(ctx, read_all_step, 1, state),
                             js_new_closure_native(ctx, read_all_failed, 1, state), JS_UNDEFINED);
}

BUILTIN(read_all_step) {
    (void)this_val, (void)new_target;
    JSValue state = js_closure_data(callee);
    JSValue result = ARG(0), promise = js_get_elem(ctx, state, js_int32(3));
    JSValue done = js_get_value(ctx, result, JS_ATOM(done));
    if (js_is_exception(done)) goto fail;
    JSValue chunks = js_get_elem(ctx, state, js_int32(1));
    if (js_truthy(done)) {
        double total = js_as_number(js_get_elem(ctx, state, js_int32(2)));
        JSValue bytes = js_new_uint8_array(ctx, (size_t)total);
        if (js_is_exception(bytes)) goto fail;
        uint8_t *out;
        size_t cap, at = 0;
        js_buffer_source_bytes(bytes, &out, &cap);
        for (uint32_t i = 0; i < js_array_length(js_as_object(chunks)); i++) {
            uint8_t *p;
            size_t n;
            js_buffer_source_bytes(js_get_elem(ctx, chunks, js_int32((int32_t)i)), &p, &n);
            if (n > cap - at) n = cap - at;
            if (n) memcpy(out + at, p, n);
            at += n;
        }
        release(ctx, as_reader(js_get_elem(ctx, state, js_int32(0))));
        js_promise_resolve_internal(ctx, promise, bytes);
        return JS_UNDEFINED;
    }
    JSValue chunk = js_get_value(ctx, result, JS_ATOM(value));
    if (js_is_exception(chunk)) goto fail;
    uint8_t *p;
    size_t n;
    if (!js_is_uint8_array(chunk)) {
        js_promise_reject_internal(ctx, promise, js_new_error(ctx, JS_TYPE_ERROR, js_new_string_cstr(ctx, "Received non-Uint8Array chunk")));
        return JS_UNDEFINED;
    }
    js_buffer_source_bytes(chunk, &p, &n);
    if (js_array_push(ctx, js_as_object(chunks), chunk) < 0) goto fail;
    double total = js_as_number(js_get_elem(ctx, state, js_int32(2))) + (double)n;
    if (js_set_elem(ctx, state, js_int32(2), js_number(total), true) < 0) goto fail;
    read_all_next(ctx, state);
    return JS_UNDEFINED;
fail:
    js_promise_reject_internal(ctx, promise, js_take_exception(ctx));
    return JS_UNDEFINED;
}

JSValue js_readable_stream_read_all(JSContext *ctx, JSValue stream) {
    StreamObject *s = as_stream(stream);
    if (!js_is_undefined(s->reader)) return rejected(ctx, js_new_error(ctx, JS_TYPE_ERROR, js_new_string_cstr(ctx, "Body is unusable: Body has already been read")));
    JSValue reader = new_reader(ctx, ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE], stream);
    JSValue promise = js_new_promise(ctx);
    JSValue items[4] = { reader, js_new_array(ctx, 0), js_int32(0), promise };
    JSValue state = js_new_array_from(ctx, items, 4);
    JSValue p = reader_read(ctx, as_reader(reader));
    js_promise_then_internal(ctx, p, js_new_closure_native(ctx, read_all_step, 1, state), js_new_closure_native(ctx, read_all_failed, 1, state), JS_UNDEFINED);
    return promise;
}

/* ---- Realm ---------------------------------------------------------------------------------- */

static const JSBuiltin stream_proto[] = {
    WEBIDL_ATTRIBUTE("locked", stream_locked, NULL),
    WEBIDL_OPERATION("cancel", stream_cancel_method, 0),
    WEBIDL_OPERATION("getReader", stream_get_reader, 0),
    WEBIDL_OPERATION("pipeThrough", js_rs_pipe_through, 1),
    WEBIDL_OPERATION("pipeTo", js_rs_pipe_to, 1),
    WEBIDL_OPERATION("tee", stream_tee, 0),
    WEBIDL_OPERATION("values", stream_values, 0),
};

static const JSBuiltin reader_proto[] = {
    WEBIDL_OPERATION("read", reader_read_method, 0),
    WEBIDL_OPERATION("releaseLock", reader_release_lock, 0),
    WEBIDL_ATTRIBUTE("closed", reader_closed, NULL),
    WEBIDL_OPERATION("cancel", reader_cancel, 0),
};

static const JSBuiltin controller_proto[] = {
    WEBIDL_ATTRIBUTE("desiredSize", controller_desired_size, NULL),
    WEBIDL_OPERATION("close", controller_close, 0),
    WEBIDL_OPERATION("enqueue", controller_enqueue, 0),
    WEBIDL_OPERATION("error", controller_error_method, 0),
};

static const JSBuiltin iterator_proto[] = {
    JS_BUILTIN_FN("next", iterator_next, 0),
    JS_BUILTIN_FN("return", iterator_return, 1),
};

static void install_streams(JSContext *ctx, JSObject *global) {
    JSValue object_proto = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];
    js_define_web_class(ctx, global, "ReadableStream", stream_ctor, 0, object_proto, JS_INTRINSIC_READABLE_STREAM_PROTOTYPE);
    JSValue sp = ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(sp), stream_proto, JS_COUNTOF(stream_proto));
    js_define_inspect(ctx, sp, stream_inspect, "ReadableStream");
    JSValue values = js_get_value(ctx, sp, js_atom_from_cstr(ctx, "values"));
    js_define_data(ctx, js_as_object(sp), JS_SYMBOL(asyncIterator), values, JS_BUILTIN_METHOD_ATTRS);

    js_define_web_class(ctx, global, "ReadableStreamDefaultReader", reader_ctor, 1, object_proto, JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE);
    JSValue rp = ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(rp), reader_proto, JS_COUNTOF(reader_proto));
    js_define_inspect(ctx, rp, reader_inspect, "ReadableStreamDefaultReader");

    js_define_web_class(ctx, global, "ReadableStreamDefaultController", controller_ctor, 0, object_proto, JS_INTRINSIC_READABLE_STREAM_CONTROLLER_PROTOTYPE);
    JSValue cp = ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_CONTROLLER_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(cp), controller_proto, JS_COUNTOF(controller_proto));
    js_define_inspect(ctx, cp, controller_inspect, "ReadableStreamDefaultController");

    JSValue ip = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE], 4);
    ctx->intrinsics[JS_INTRINSIC_READABLE_STREAM_ITERATOR_PROTOTYPE] = ip;
    js_define_builtins(ctx, js_as_object(ip), iterator_proto, JS_COUNTOF(iterator_proto));

    js_writable_streams_install(ctx, global);
}

const JSComponent js_component_streams = { "streams", install_streams };
