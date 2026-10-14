/* Async generators (ECMAScript §27.6) and async iteration (§27.1.4–6): the request queue
 * and its driver, %AsyncIteratorPrototype%, the async-from-sync iterator, for await, and
 * yield* in async generators (§15.5.5). */
#include "internal.h"
#include "js_atoms.h"
#include "js_builtins.h"
#include "js_error.h"
#include "js_function.h"
#include "js_generator.h"
#include "js_ops.h"
#include "js_promise.h"
#include "js_symbol.h"
#include "jscontext.h"

#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)
#define BUILTIN(fn)                                                                            \
    static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,          \
                      const JSValue *argv, JSValue new_target)

/* A builtin closure: `data` kept in its home_object slot (as in promise.c). */
static JSValue native_with(JSContext *ctx, JSNativeFn fn, uint32_t length, JSValue data) {
    JSValue f = js_new_native(ctx, fn, js_empty_string(), length, JS_FN_STRICT);
    js_store(ctx, &js_as_function(f)->obj.cell, &js_as_function(f)->home_object, data);
    return f;
}
static JSValue data_of(JSValue callee) { return js_as_function(callee)->home_object; }

/* GetMethod (§7.3.10): undefined for null or undefined, a TypeError if not callable. */
static JSValue get_method(JSContext *ctx, JSValue v, JSValue key, const char *what) {
    JSValue m = js_get_value(ctx, v, key);
    if (js_is_exception(m) || js_is_callable(m)) return m;
    if (js_is_nullish(m)) return JS_UNDEFINED;
    return js_throw_type_error(ctx, "%s is not a function", what);
}

/* Rejects `promise` with the pending exception (IfAbruptRejectPromise) and returns it. */
static JSValue reject_pending(JSContext *ctx, JSValue promise) {
    js_promise_reject_internal(ctx, promise, js_take_exception(ctx));
    return promise;
}

/* ---- The async generator's request queue (§27.6.3) ------------------------------------- */

typedef struct Request {
    JSHostCell host;
    int32_t    mode;     /* JS_RESUME_NEXT / THROW / RETURN */
    JSValue    value;
    JSValue    promise;  /* what next/throw/return returned */
    JSValue    next;
} Request;

static void request_visit(JSCell *c, JSTracer *trc) {
    Request *r = (Request *)c;
    js_trace_value(trc, r->value);
    js_trace_value(trc, r->promise);
    js_trace_value(trc, r->next);
}
static const JSCellClass request_class = { "AsyncGeneratorRequest", request_visit, NULL, NULL };

static const JSClass async_generator_class = { "AsyncGenerator", sizeof(JSGenerator), NULL, NULL, NULL, NULL, js_generator_visit, NULL, NULL };

JSValue js_async_generator_new(JSContext *ctx, JSValue callee, JSGeneratorResume resume, uint32_t slots) {
    JSValue proto = js_generator_proto(ctx, callee, JS_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    JSGenerator *g = js_generator_alloc(ctx, &async_generator_class, proto, resume, slots);
    g->kind = JS_GEN_ASYNC_GENERATOR;  /* driver: the queue's first request, or undefined */
    return js_object_value(&g->obj);
}

static Request *head_of(JSGenerator *g) { return js_is_cell(g->driver) ? (Request *)js_as_cell(g->driver) : NULL; }

/* AsyncGeneratorEnqueue */
static void enqueue(JSContext *ctx, JSGenerator *g, int mode, JSValue value, JSValue promise) {
    Request *r = (Request *)js_alloc_host_cell(ctx, &request_class, sizeof(Request));
    r->mode = mode;
    js_init_slot(&r->value, value);
    js_init_slot(&r->promise, promise);
    js_init_slot(&r->next, JS_UNDEFINED);
    JSValue rv = js_cell(&r->host.cell);
    Request *tail = head_of(g);
    if (!tail) {
        js_store(ctx, &g->obj.cell, &g->driver, rv);
        return;
    }
    while (js_is_cell(tail->next)) tail = (Request *)js_as_cell(tail->next);
    js_store(ctx, &tail->host.cell, &tail->next, rv);
}

/* AsyncGeneratorCompleteStep: settles the first request's promise and removes it. */
static void complete_step(JSContext *ctx, JSGenerator *g, bool threw, JSValue value, bool done) {
    Request *r = head_of(g);
    JSValue promise = r->promise;
    js_store(ctx, &g->obj.cell, &g->driver, r->next);
    if (threw) js_promise_reject_internal(ctx, promise, value);
    else js_promise_resolve_internal(ctx, promise, js_iter_result(ctx, value, done));
}

static void finish(JSContext *ctx, JSGenerator *g) {
    g->status = JS_GEN_COMPLETED;
    js_store(ctx, &g->obj.cell, &g->frame, JS_UNDEFINED);
}

/* AsyncGeneratorAwaitReturn: return(v) on a finished generator awaits v first. */
static void await_return(JSContext *ctx, JSGenerator *g) {
    g->status = JS_GEN_AWAITING_RETURN;
    JSValue promise = js_promise_resolve(ctx, head_of(g)->value);
    if (js_is_exception(promise)) {
        g->status = JS_GEN_COMPLETED;
        complete_step(ctx, g, true, js_take_exception(ctx), true);
        return;
    }
    js_promise_await(ctx, promise, js_object_value(&g->obj));
}

/* Runs the body from where it paused to its next pause point (AsyncGeneratorResume). */
static void resume_body(JSContext *ctx, JSGenerator *g, JSValue value, int mode) {
    g->status = JS_GEN_EXECUTING;
    g->raw = 0;
    JSValue r = g->resume(ctx, g, value, mode);
    if (g->status == JS_GEN_AWAITING) return;
    if (g->status == JS_GEN_SUSPENDED) {  /* AsyncGeneratorYield: still running while the request settles */
        g->status = JS_GEN_EXECUTING;
        complete_step(ctx, g, false, r, false);
        g->status = JS_GEN_SUSPENDED;
        return;
    }
    finish(ctx, g);
    if (js_is_exception(r)) complete_step(ctx, g, true, js_take_exception(ctx), true);
    else complete_step(ctx, g, false, r, true);
}

/* Serves queued requests while the generator can take one (AsyncGeneratorDrainQueue and the
 * resumes the methods start): a finished generator answers next() with done, throw() with a
 * rejection, and awaits return()'s value. */
static void drain(JSContext *ctx, JSGenerator *g) {
    for (Request *r; (r = head_of(g));) {
        uint8_t s = g->status;
        if (s == JS_GEN_EXECUTING || s == JS_GEN_AWAITING || s == JS_GEN_AWAITING_RETURN) return;
        if (s == JS_GEN_START && r->mode != JS_RESUME_NEXT) {  /* never started: the body never runs */
            finish(ctx, g);
            s = JS_GEN_COMPLETED;
        }
        if (s == JS_GEN_COMPLETED) {
            if (r->mode == JS_RESUME_RETURN) await_return(ctx, g);
            else if (r->mode == JS_RESUME_THROW) complete_step(ctx, g, true, r->value, true);
            else complete_step(ctx, g, false, JS_UNDEFINED, true);
            continue;
        }
        resume_body(ctx, g, r->value, r->mode);
    }
}

/* An await in the body settled, or return()'s value did. */
void js_async_generator_resume(JSContext *ctx, JSGenerator *g, JSValue value, int mode) {
    if (g->status == JS_GEN_AWAITING_RETURN) {
        g->status = JS_GEN_COMPLETED;
        complete_step(ctx, g, mode == JS_RESUME_THROW, value, true);
    } else {
        resume_body(ctx, g, value, mode);
    }
    drain(ctx, g);
}

/* %AsyncGeneratorPrototype%.next / return / throw (§27.6.1.2–4) */
static JSValue request(JSContext *ctx, JSValue callee, JSValue this_val, JSValue value, int mode, const char *name) {
    JSValue promise = js_new_promise(js_as_function(callee)->realm);
    if (!js_is_object(this_val) || js_as_object(this_val)->shape->cls != &async_generator_class) {
        js_discard(js_throw_type_error(ctx, "%s method called on incompatible receiver (not an async generator)", name));
        return reject_pending(ctx, promise);
    }
    JSGenerator *g = js_as_generator(this_val);
    enqueue(ctx, g, mode, value, promise);
    drain(ctx, g);
    return promise;
}

#define METHOD(fn, mode, name)                                                                 \
    BUILTIN(fn) {                                                                              \
        (void)new_target;                                                                      \
        return request(ctx, callee, this_val, ARG(0), mode, name);                             \
    }
METHOD(async_generator_next, JS_RESUME_NEXT, "next")
METHOD(async_generator_return, JS_RESUME_RETURN, "return")
METHOD(async_generator_throw, JS_RESUME_THROW, "throw")

/* ---- The async-from-sync iterator (§27.1.6) ------------------------------------------------ */

typedef struct AsyncFromSync {
    JSObject obj;
    JSValue  iterator;  /* the sync iterator record */
    JSValue  next;
} AsyncFromSync;

static void afs_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((AsyncFromSync *)c)->iterator);
    js_trace_value(trc, ((AsyncFromSync *)c)->next);
}
static const JSClass afs_class = { "AsyncFromSyncIterator", sizeof(AsyncFromSync), NULL, NULL, NULL, NULL, afs_visit, NULL, NULL };

static JSValue create_async_from_sync(JSContext *ctx, JSValue iterator, JSValue next) {
    JSShape *shape = js_shape_root(ctx, &afs_class, ctx->intrinsics[JS_INTRINSIC_ASYNC_FROM_SYNC_ITERATOR_PROTOTYPE], 0);
    AsyncFromSync *a = (AsyncFromSync *)js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    js_init_slot(&a->iterator, iterator);
    js_init_slot(&a->next, next);
    return js_object_value(&a->obj);
}

/* IteratorClose(sync, throw completion): return() runs, its errors are ignored. */
static void close_sync_quietly(JSContext *ctx, JSValue iterator) {
    JSValue ret = js_get_value(ctx, iterator, JS_ATOM(return));
    if (!js_is_exception(ret) && js_is_callable(ret)) ret = js_call(ctx, ret, iterator, 0, NULL);
    if (js_is_exception(ret)) js_discard(js_take_exception(ctx));
}

BUILTIN(unwrap_fulfilled) {
    (void)this_val, (void)new_target;
    return js_iter_result(ctx, ARG(0), js_truthy(data_of(callee)));
}

BUILTIN(unwrap_rejected) {  /* closes the sync iterator, then rejects with the same reason */
    (void)this_val, (void)new_target;
    close_sync_quietly(ctx, data_of(callee));
    return js_throw(ctx, ARG(0));
}

/* AsyncFromSyncIteratorContinuation: the result's value is awaited before it is handed on. */
static JSValue continuation(JSContext *ctx, JSValue result, JSValue promise, JSValue iterator, bool close_on_rejection) {
    JSValue done_value = js_get_value(ctx, result, JS_ATOM(done));
    if (js_is_exception(done_value)) return reject_pending(ctx, promise);
    bool done = js_truthy(done_value);
    JSValue value = js_get_value(ctx, result, JS_ATOM(value));
    if (js_is_exception(value)) return reject_pending(ctx, promise);
    JSValue wrapper = js_promise_resolve(ctx, value);
    if (js_is_exception(wrapper)) {
        if (!done && close_on_rejection) {
            JSValue e = js_take_exception(ctx);
            close_sync_quietly(ctx, iterator);
            js_discard(js_throw(ctx, e));
        }
        return reject_pending(ctx, promise);
    }
    JSValue on_fulfilled = native_with(ctx, unwrap_fulfilled, 1, js_bool(done));
    JSValue on_rejected = done || !close_on_rejection ? JS_UNDEFINED : native_with(ctx, unwrap_rejected, 1, iterator);
    js_promise_then_internal(ctx, wrapper, on_fulfilled, on_rejected, promise);
    return promise;
}

static AsyncFromSync *afs_this(JSContext *ctx, JSValue this_val) {
    if (js_is_object(this_val) && js_as_object(this_val)->shape->cls == &afs_class) return (AsyncFromSync *)js_as_object(this_val);
    js_discard(js_throw_type_error(ctx, "not an async-from-sync iterator"));
    return NULL;
}

/* A sync result that must be an object, or a rejection. */
static bool result_is_object(JSContext *ctx, JSValue result) {
    if (js_is_exception(result)) return false;
    if (js_is_object(result)) return true;
    js_discard(js_throw_type_error(ctx, "Iterator result is not an object"));
    return false;
}

BUILTIN(afs_next) {
    (void)new_target;
    JSValue promise = js_new_promise(js_as_function(callee)->realm);
    AsyncFromSync *a = afs_this(ctx, this_val);
    if (!a) return reject_pending(ctx, promise);
    JSValue result = js_call(ctx, a->next, a->iterator, argc ? 1 : 0, argv);
    if (!result_is_object(ctx, result)) return reject_pending(ctx, promise);
    return continuation(ctx, result, promise, a->iterator, true);
}

BUILTIN(afs_return) {
    (void)new_target;
    JSValue promise = js_new_promise(js_as_function(callee)->realm);
    AsyncFromSync *a = afs_this(ctx, this_val);
    if (!a) return reject_pending(ctx, promise);
    JSValue ret = get_method(ctx, a->iterator, JS_ATOM(return), "The iterator's 'return' method");
    if (js_is_exception(ret)) return reject_pending(ctx, promise);
    if (js_is_undefined(ret)) {
        js_promise_resolve_internal(ctx, promise, js_iter_result(ctx, ARG(0), true));
        return promise;
    }
    JSValue result = js_call(ctx, ret, a->iterator, argc ? 1 : 0, argv);
    if (!result_is_object(ctx, result)) return reject_pending(ctx, promise);
    return continuation(ctx, result, promise, a->iterator, false);
}

BUILTIN(afs_throw) {
    (void)new_target;
    JSValue promise = js_new_promise(js_as_function(callee)->realm);
    AsyncFromSync *a = afs_this(ctx, this_val);
    if (!a) return reject_pending(ctx, promise);
    JSValue thr = get_method(ctx, a->iterator, js_atom_from_cstr(ctx, "throw"), "The iterator's 'throw' method");
    if (js_is_exception(thr)) return reject_pending(ctx, promise);
    if (js_is_undefined(thr)) {  /* close the sync iterator (normally: its errors win), then a TypeError */
        JSValue ret = get_method(ctx, a->iterator, JS_ATOM(return), "The iterator's 'return' method");
        if (js_is_exception(ret)) return reject_pending(ctx, promise);
        if (!js_is_undefined(ret) && !result_is_object(ctx, js_call(ctx, ret, a->iterator, 0, NULL))) return reject_pending(ctx, promise);
        js_discard(js_throw_type_error(ctx, "The iterator does not provide a 'throw' method"));
        return reject_pending(ctx, promise);
    }
    JSValue value = ARG(0);
    JSValue result = js_call(ctx, thr, a->iterator, 1, &value);
    if (!result_is_object(ctx, result)) return reject_pending(ctx, promise);
    return continuation(ctx, result, promise, a->iterator, true);
}

/* ---- for await and yield*: the async iterator record -------------------------------------- */

enum { PHASE_CALL, PHASE_CLOSE, PHASE_RETURN_VALUE };  /* what yield*'s awaited value is */
enum { AYS_YIELD, AYS_DONE, AYS_RETURN, AYS_AWAIT };

typedef struct AsyncIter {
    JSHostCell host;
    JSValue    iterator;
    JSValue    next;
    int32_t    phase;
    int32_t    mode;
    int32_t    status;
    bool       done;  /* exhausted, or closed */
} AsyncIter;

static void async_iter_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((AsyncIter *)c)->iterator);
    js_trace_value(trc, ((AsyncIter *)c)->next);
}
static const JSCellClass async_iter_class = { "AsyncIteratorRecord", async_iter_visit, NULL, NULL };

static AsyncIter *rec_of(JSValue rec) { return (AsyncIter *)js_as_cell(rec); }

/* GetIterator(v, async) (§7.4.3): v[@@asyncIterator](), else v[@@iterator]() wrapped. */
JSValue js_async_iter_start(JSContext *ctx, JSValue v) {
    if (js_is_nullish(v)) return js_throw_type_error(ctx, "%s is not async iterable", js_is_null(v) ? "null" : "undefined");
    JSValue method = get_method(ctx, v, JS_SYMBOL(asyncIterator), "Symbol.asyncIterator");
    if (js_is_exception(method)) return JS_EXCEPTION;
    JSValue iterator;
    if (js_is_undefined(method)) {
        JSValue sync = get_method(ctx, v, JS_SYMBOL(iterator), "Symbol.iterator");
        if (js_is_exception(sync)) return JS_EXCEPTION;
        if (js_is_undefined(sync)) return js_throw_type_error(ctx, "object is not async iterable");
        JSValue it = js_call(ctx, sync, v, 0, NULL);
        if (js_is_exception(it)) return JS_EXCEPTION;
        if (!js_is_object(it)) return js_throw_type_error(ctx, "Result of the Symbol.iterator method is not an object");
        JSValue next = js_get_value(ctx, it, JS_ATOM(next));
        if (js_is_exception(next)) return JS_EXCEPTION;
        iterator = create_async_from_sync(ctx, it, next);
    } else {
        iterator = js_call(ctx, method, v, 0, NULL);
        if (js_is_exception(iterator)) return JS_EXCEPTION;
        if (!js_is_object(iterator)) return js_throw_type_error(ctx, "Result of the Symbol.asyncIterator method is not an object");
    }
    JSValue next = js_get_value(ctx, iterator, JS_ATOM(next));
    if (js_is_exception(next)) return JS_EXCEPTION;
    AsyncIter *r = (AsyncIter *)js_alloc_host_cell(ctx, &async_iter_class, sizeof(AsyncIter));
    js_init_slot(&r->iterator, iterator);
    js_init_slot(&r->next, next);
    return js_cell(&r->host.cell);
}

JSValue js_async_iter_next(JSContext *ctx, JSValue rec) {
    AsyncIter *r = rec_of(rec);
    return js_call(ctx, r->next, r->iterator, 0, NULL);
}

JSValue js_async_iter_value(JSContext *ctx, JSValue rec, JSValue result) {
    AsyncIter *r = rec_of(rec);
    if (!js_is_object(result)) return js_throw_type_error(ctx, "Iterator result is not an object");
    JSValue done = js_get_value(ctx, result, JS_ATOM(done));
    if (js_is_exception(done)) return JS_EXCEPTION;
    if (js_truthy(done)) {
        r->done = true;
        return JS_EMPTY;
    }
    return js_get_value(ctx, result, JS_ATOM(value));
}

/* AsyncIteratorClose's call: once only (a failed close isn't retried by the loop's handler). */
JSValue js_async_iter_return(JSContext *ctx, JSValue rec) {
    AsyncIter *r = rec_of(rec);
    if (r->done) return JS_EMPTY;
    r->done = true;
    JSValue ret = get_method(ctx, r->iterator, JS_ATOM(return), "The iterator's 'return' method");
    if (js_is_exception(ret)) return JS_EXCEPTION;
    if (js_is_undefined(ret)) return JS_EMPTY;
    return js_call(ctx, ret, r->iterator, 0, NULL);
}

JSValue js_async_iter_check(JSContext *ctx, JSValue result) {
    if (js_is_object(result)) return JS_UNDEFINED;
    return js_throw_type_error(ctx, "The iterator's 'return' method returned a non-object");
}

/* yield* (§15.5.5, async): one step, forwarding how the generator was resumed. */
JSValue js_async_yield_star_step(JSContext *ctx, JSValue rec, JSValue received, JSValue mode_value) {
    AsyncIter *r = rec_of(rec);
    int mode = js_as_int32(mode_value);
    r->mode = mode;
    r->phase = PHASE_CALL;
    if (mode == JS_RESUME_NEXT) return js_call(ctx, r->next, r->iterator, 1, &received);
    if (mode == JS_RESUME_THROW) {
        JSValue thr = get_method(ctx, r->iterator, js_atom_from_cstr(ctx, "throw"), "The iterator's 'throw' method");
        if (js_is_exception(thr)) return JS_EXCEPTION;
        if (!js_is_undefined(thr)) return js_call(ctx, thr, r->iterator, 1, &received);
        /* no throw(): AsyncIteratorClose (awaiting return()), then a TypeError */
        JSValue ret = get_method(ctx, r->iterator, JS_ATOM(return), "The iterator's 'return' method");
        if (js_is_exception(ret)) return JS_EXCEPTION;
        if (js_is_undefined(ret)) return js_throw_type_error(ctx, "The iterator does not provide a 'throw' method");
        r->phase = PHASE_CLOSE;
        return js_call(ctx, ret, r->iterator, 0, NULL);
    }
    JSValue ret = get_method(ctx, r->iterator, JS_ATOM(return), "The iterator's 'return' method");
    if (js_is_exception(ret)) return JS_EXCEPTION;
    if (js_is_undefined(ret)) {  /* this generator returns the (awaited) value itself */
        r->phase = PHASE_RETURN_VALUE;
        return received;
    }
    return js_call(ctx, ret, r->iterator, 1, &received);
}

JSValue js_async_yield_star_settled(JSContext *ctx, JSValue rec, JSValue awaited) {
    AsyncIter *r = rec_of(rec);
    if (r->phase == PHASE_RETURN_VALUE) {
        r->status = AYS_RETURN;
        return awaited;
    }
    if (r->phase == PHASE_CLOSE) {
        if (!js_is_object(awaited)) return js_throw_type_error(ctx, "The iterator's 'return' method returned a non-object");
        return js_throw_type_error(ctx, "The iterator does not provide a 'throw' method");
    }
    if (!js_is_object(awaited)) return js_throw_type_error(ctx, "Iterator result is not an object");
    JSValue done = js_get_value(ctx, awaited, JS_ATOM(done));
    if (js_is_exception(done)) return JS_EXCEPTION;
    JSValue value = js_get_value(ctx, awaited, JS_ATOM(value));
    if (js_is_exception(value)) return JS_EXCEPTION;
    if (!js_truthy(done)) r->status = AYS_YIELD;
    else if (r->mode != JS_RESUME_RETURN) r->status = AYS_DONE;
    else {  /* the inner iterator finished a return(): await its value, then return it */
        r->phase = PHASE_RETURN_VALUE;
        r->status = AYS_AWAIT;
    }
    return value;
}

JSValue js_async_yield_star_status(JSValue rec) { return js_int32(rec_of(rec)->status); }

/* ---- Realm (§27.1.3, §27.1.6, §27.4, §27.6) ------------------------------------------------ */

BUILTIN(async_iterator_proto_iterator) {
    (void)ctx, (void)callee, (void)argc, (void)argv, (void)new_target;
    return this_val;
}

static void install_async_iterator(JSContext *ctx, JSObject *global) {
    (void)global;
    JSValue *in = ctx->intrinsics;
    const uint8_t wc = JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE;
    /* %AsyncIteratorPrototype%: [Symbol.asyncIterator]() returns this */
    in[JS_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_OBJECT_PROTOTYPE], 4);
    JSObject *aip = js_as_object(in[JS_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE]);
    JSValue f = js_new_native(ctx, async_iterator_proto_iterator, js_atom_from_cstr(ctx, "[Symbol.asyncIterator]"), 0, JS_FN_STRICT);
    js_define_data(ctx, aip, JS_SYMBOL(asyncIterator), f, wc);

    in[JS_INTRINSIC_ASYNC_FROM_SYNC_ITERATOR_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE], 4);
    JSObject *afs = js_as_object(in[JS_INTRINSIC_ASYNC_FROM_SYNC_ITERATOR_PROTOTYPE]);
    (void)js_define_method(ctx, afs, "next", afs_next, 1);
    (void)js_define_method(ctx, afs, "return", afs_return, 1);
    (void)js_define_method(ctx, afs, "throw", afs_throw, 1);

    /* %AsyncGeneratorFunction.prototype% and %AsyncGeneratorPrototype% */
    in[JS_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_FUNCTION_PROTOTYPE], 4);
    JSObject *agfp = js_as_object(in[JS_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE]);
    in[JS_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE], 8);
    JSObject *agp = js_as_object(in[JS_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE]);
    js_define_data(ctx, agfp, JS_ATOM(prototype), in[JS_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE], JS_PROP_CONFIGURABLE);
    js_define_data(ctx, agfp, JS_SYMBOL(toStringTag), js_atom_from_cstr(ctx, "AsyncGeneratorFunction"), JS_PROP_CONFIGURABLE);
    js_define_function_kind_ctor(ctx, in[JS_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE], 2);
    js_define_data(ctx, agp, JS_ATOM(constructor), in[JS_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE], JS_PROP_CONFIGURABLE);
    (void)js_define_method(ctx, agp, "next", async_generator_next, 1);
    (void)js_define_method(ctx, agp, "return", async_generator_return, 1);
    (void)js_define_method(ctx, agp, "throw", async_generator_throw, 1);
    js_define_data(ctx, agp, JS_SYMBOL(toStringTag), js_atom_from_cstr(ctx, "AsyncGenerator"), JS_PROP_CONFIGURABLE);
}
const JSComponent js_component_asynciterator = { "asynciterator", install_async_iterator };
