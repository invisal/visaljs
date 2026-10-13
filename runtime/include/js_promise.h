/*
 * js_promise.h — promises (ECMAScript §27.2).
 *
 * A promise keeps its reactions in a list until it settles; settling queues one
 * microtask per reaction (js_jobs.h). Async functions build on these.
 */
#ifndef JS_PROMISE_H
#define JS_PROMISE_H

#include "js_object.h"

enum { JS_PROMISE_PENDING, JS_PROMISE_FULFILLED, JS_PROMISE_REJECTED };

typedef struct JSPromise {
    JSObject obj;
    JSValue  result;            /* the value or reason once settled */
    JSValue  reactions;         /* while pending: reaction records, newest first; else undefined */
    uint8_t  state;             /* JS_PROMISE_* */
    uint8_t  is_handled;        /* [[PromiseIsHandled]]: rejection tracking */
    uint8_t  already_resolved;  /* settled through the runtime (no resolving functions) */
    uint8_t  reported;          /* rejected, unhandled and handled by the host (rt->on_uncaught) */
} JSPromise;

bool js_is_promise(JSValue v);
static inline JSPromise *js_as_promise(JSValue v) { return (JSPromise *)js_as_object(v); }

/* A new pending promise of ctx's realm, settled only through the two calls below. */
JSValue js_new_promise(JSContext *ctx);
/* Resolves it (a thenable is followed) or rejects it; once only, later calls do nothing. */
void js_promise_resolve_internal(JSContext *ctx, JSValue promise, JSValue resolution);
void js_promise_reject_internal(JSContext *ctx, JSValue promise, JSValue reason);
/* PromiseResolve(%Promise%, v) (§27.2.4.7.1): v if it is a native promise of this realm. */
JS_WARN_UNUSED JSValue js_promise_resolve(JSContext *ctx, JSValue v);

/* await: when the promise settles, a job resumes the async state `gen` (a
 * reaction with no derived promise and no JS closure); marks the promise handled. */
void js_promise_await(JSContext *ctx, JSValue promise, JSValue gen);

/* The jobs (js_jobs.h) run these. 0, or -1 with an exception that is uncaught. */
int js_promise_reaction_job(JSContext *ctx, JSValue reaction, JSValue argument, JSValue state);
int js_promise_thenable_job(JSContext *ctx, JSValue promise, JSValue thenable, JSValue then);


#endif /* JS_PROMISE_H */
