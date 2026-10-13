/*
 * js_generator.h — generators (ECMAScript §27.5).
 *
 * The compiler turns a function* into an entry (its prologue, which ends by creating the
 * generator with js_generator_new) and a resume function: a state machine that saves the
 * values live across each pause point into the generator's frame.
 */
#ifndef JS_GENERATOR_H
#define JS_GENERATOR_H

#include "js_object.h"

typedef struct JSGenerator JSGenerator;

/* Runs from the pause point g->state to the next one (returns the yielded value, status
 * SUSPENDED) or to the end (returns the result or JS_EXCEPTION, status still EXECUTING). */
typedef JSValue (*JSGeneratorResume)(JSContext *ctx, JSGenerator *g, JSValue sent, int mode);

enum { JS_RESUME_NEXT, JS_RESUME_THROW, JS_RESUME_RETURN };
enum {
    JS_GEN_START, JS_GEN_SUSPENDED, JS_GEN_EXECUTING, JS_GEN_COMPLETED,
    JS_GEN_AWAITING,         /* async: paused at an await (still running, to the async generator's queue) */
    JS_GEN_AWAITING_RETURN,  /* async generator: awaiting a return(v)'s value after completing */
};
enum { JS_GEN_SYNC, JS_GEN_ASYNC_FUNCTION, JS_GEN_ASYNC_GENERATOR };  /* JSGenerator.kind */

struct JSGenerator {
    JSObject          obj;
    JSGeneratorResume resume;
    JSValue           frame;   /* a value array: the saved live values; undefined once completed */
    JSValue           driver;  /* async functions: the promise the call returned */
    uint32_t          state;   /* the pause point to resume at: 0 = the start of the body */
    uint8_t           status;  /* JS_GEN_* */
    uint8_t           raw;     /* the last pause handed on yield*'s inner result object as it is */
    uint8_t           kind;    /* JS_GEN_SYNC, ASYNC_FUNCTION, ASYNC_GENERATOR */
};

static inline JSGenerator *js_as_generator(JSValue v) { return (JSGenerator *)js_as_object(v); }

/* The entry's last step: a generator whose prototype is callee.prototype (or the realm's
 * %GeneratorPrototype%), with `slots` frame slots. */
JSValue js_generator_new(JSContext *ctx, JSValue callee, JSGeneratorResume resume, uint32_t slots);

static inline void js_generator_save(JSContext *ctx, JSGenerator *g, uint32_t slot, JSValue v) {
    JSValueArray *f = (JSValueArray *)js_as_cell(g->frame);
    js_store(ctx, &f->cell, &f->values[slot], v);
}
static inline JSValue js_generator_load(JSGenerator *g, uint32_t slot) {
    return ((JSValueArray *)js_as_cell(g->frame))->values[slot];
}

/* yield* (§15.5.5): the inner iterator as a record, one step forwarding a resume (mode as a
 * number) to it, and that step's outcome: 0 yield the value (an inner result object),
 * 1 done (the value is yield*'s), 2 return the value from the generator. */
JSValue js_yield_star_start(JSContext *ctx, JSValue iterable);
JSValue js_yield_star_step(JSContext *ctx, JSValue rec, JSValue received, JSValue mode);
JSValue js_yield_star_status(JSValue rec);

/* ---- Async functions (§27.7) ----------------------------------------------------------- */

/* An async call's state: a generator-like object nothing in JS can reach. */
JSValue js_async_new(JSContext *ctx, JSGeneratorResume resume, uint32_t slots);
/* The entry's last step: runs the body to its first await (or the end) and returns the
 * promise, which the body's outcome settles. Never throws. */
JSValue js_async_start(JSContext *ctx, JSGenerator *g);
/* await v: registers the resume on PromiseResolve(v); 0 (paused: status AWAITING), or -1
 * if PromiseResolve threw (the exception is pending, at the await). */
JS_WARN_UNUSED int js_await(JSContext *ctx, JSGenerator *g, JSValue v);
/* Resumes a paused async call or async generator (a promise reaction job): mode NEXT with
 * the value, THROW with the reason. */
void js_async_resume(JSContext *ctx, JSGenerator *g, JSValue value, int mode);

/* ---- Async generators and async iteration (§27.6, §27.1; async_iter.c) ---------------- */

/* The entry's last step for an async function*: like js_generator_new. */
JSValue js_async_generator_new(JSContext *ctx, JSValue callee, JSGeneratorResume resume, uint32_t slots);
void js_async_generator_resume(JSContext *ctx, JSGenerator *g, JSValue value, int mode);
/* for await: GetIterator(v, async) as a record (a sync iterator is wrapped,
 * CreateAsyncFromSyncIterator); next() called; the awaited result's value (EMPTY when done);
 * return() called (EMPTY: none, or the record is done); an awaited return() result checked. */
JSValue js_async_iter_start(JSContext *ctx, JSValue v);
JSValue js_async_iter_next(JSContext *ctx, JSValue rec);
JSValue js_async_iter_value(JSContext *ctx, JSValue rec, JSValue result);
JSValue js_async_iter_return(JSContext *ctx, JSValue rec);
JSValue js_async_iter_check(JSContext *ctx, JSValue result);
/* yield* in an async generator: a step (mode as a number) gives a value to await; settling
 * it with the awaited value gives the outcome: status 0 yield it, 1 done (yield*'s value),
 * 2 return it from the generator, 3 await it and settle again. */
JSValue js_async_yield_star_step(JSContext *ctx, JSValue rec, JSValue received, JSValue mode);
JSValue js_async_yield_star_settled(JSContext *ctx, JSValue rec, JSValue awaited);
JSValue js_async_yield_star_status(JSValue rec);
/* %AsyncFunction.prototype%: the promise component installs it (async functions return promises) */
void js_async_function_realm_init(JSContext *ctx);

#endif /* JS_GENERATOR_H */
