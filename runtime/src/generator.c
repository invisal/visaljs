/* Generators (ECMAScript §27.3–27.5, §15.5.5): the generator object, its driver
 * (%GeneratorPrototype%.next / return / throw) and yield* delegation. */
#include "js_generator.h"

#include "internal.h"
#include "js_atoms.h"
#include "js_builtins.h"
#include "js_function.h"
#include "js_ops.h"
#include "js_promise.h"
#include "js_symbol.h"
#include "jscontext.h"

void js_generator_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((JSGenerator *)c)->frame);
    js_trace_value(trc, ((JSGenerator *)c)->driver);
}

static const JSClass generator_class = { "Generator", sizeof(JSGenerator), NULL, NULL, NULL, NULL, js_generator_visit, NULL, NULL };

JSGenerator *js_generator_alloc(JSContext *ctx, const JSClass *cls, JSValue proto, JSGeneratorResume resume, uint32_t slots) {
    JSValueArray *frame = js_alloc_value_array(ctx, slots);
    JSGenerator *g = (JSGenerator *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, cls, proto, 0));
    g->resume = resume;
    js_store(ctx, &g->obj.cell, &g->frame, js_cell(&frame->cell));
    js_store(ctx, &g->obj.cell, &g->driver, JS_UNDEFINED);
    g->state = 0;
    g->status = JS_GEN_START;
    return g;
}

/* OrdinaryCreateFromConstructor(callee, fallback): callee.prototype, else the realm's. */
JSValue js_generator_proto(JSContext *ctx, JSValue callee, JSIntrinsic fallback) {
    JSValue proto = js_get_value(ctx, callee, JS_ATOM(prototype));
    if (js_is_exception(proto) || js_is_object(proto)) return proto;
    JSContext *realm = js_function_realm(ctx, callee);
    return realm ? realm->intrinsics[fallback] : JS_EXCEPTION;
}

JSValue js_generator_new(JSContext *ctx, JSValue callee, JSGeneratorResume resume, uint32_t slots) {
    JSValue proto = js_generator_proto(ctx, callee, JS_INTRINSIC_GENERATOR_PROTOTYPE);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    return js_object_value(&js_generator_alloc(ctx, &generator_class, proto, resume, slots)->obj);
}

/* GeneratorResume / GeneratorResumeAbrupt (§27.5.3.3–4) */
static JSValue generator_resume(JSContext *ctx, JSValue this_val, JSValue value, int mode, const char *method) {
    if (!js_is_object(this_val) || js_as_object(this_val)->shape->cls != &generator_class)
        return js_throw_type_error(ctx, "%s method called on incompatible receiver (not a generator)", method);
    JSGenerator *g = js_as_generator(this_val);
    if (g->status == JS_GEN_EXECUTING) return js_throw_type_error(ctx, "Generator is already running");
    if (g->status == JS_GEN_START && mode != JS_RESUME_NEXT) {
        g->status = JS_GEN_COMPLETED;  /* never started: its body doesn't run at all */
        js_store(ctx, &g->obj.cell, &g->frame, JS_UNDEFINED);
    }
    if (g->status == JS_GEN_COMPLETED) {
        if (mode == JS_RESUME_THROW) return js_throw(ctx, value);
        return js_iter_result(ctx, mode == JS_RESUME_RETURN ? value : JS_UNDEFINED, true);
    }
    g->status = JS_GEN_EXECUTING;
    g->raw = 0;
    JSValue r = g->resume(ctx, g, value, mode);
    if (g->status == JS_GEN_EXECUTING) {  /* it returned or threw: done for good */
        g->status = JS_GEN_COMPLETED;
        js_store(ctx, &g->obj.cell, &g->frame, JS_UNDEFINED);
        return js_is_exception(r) ? JS_EXCEPTION : js_iter_result(ctx, r, true);
    }
    return g->raw ? r : js_iter_result(ctx, r, false);
}

#define DRIVER(fn, mode, name)                                                                              \
    static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, \
                      JSValue new_target) {                                                                 \
        (void)callee, (void)new_target;                                                                     \
        return generator_resume(ctx, this_val, argc ? argv[0] : JS_UNDEFINED, mode, name);                  \
    }
DRIVER(generator_next, JS_RESUME_NEXT, "next")
DRIVER(generator_return, JS_RESUME_RETURN, "return")
DRIVER(generator_throw, JS_RESUME_THROW, "throw")

/* ---- yield* (§15.5.5) ------------------------------------------------------------------ */

enum { YS_YIELD, YS_DONE, YS_RETURN };

typedef struct YieldStar {
    JSHostCell host;
    JSValue    iterator;
    JSValue    next;
    int        status;
} YieldStar;

static void yield_star_visit(JSCell *c, JSTracer *trc) {
    YieldStar *y = (YieldStar *)c;
    js_trace_value(trc, y->iterator);
    js_trace_value(trc, y->next);
}

static const JSCellClass yield_star_class = { "YieldStar", yield_star_visit, NULL, NULL };

JSValue js_yield_star_start(JSContext *ctx, JSValue iterable) {
    JSValue method = js_is_nullish(iterable) ? JS_UNDEFINED : js_get_value(ctx, iterable, JS_SYMBOL(iterator));
    if (js_is_exception(method)) return JS_EXCEPTION;
    if (!js_is_callable(method)) return js_throw_type_error(ctx, "yield* operand is not iterable");
    JSValue it = js_call(ctx, method, iterable, 0, NULL);
    if (js_is_exception(it)) return JS_EXCEPTION;
    if (!js_is_object(it)) return js_throw_type_error(ctx, "Result of the Symbol.iterator method is not an object");
    JSValue next = js_get_value(ctx, it, JS_ATOM(next));
    if (js_is_exception(next)) return JS_EXCEPTION;
    YieldStar *y = (YieldStar *)js_alloc_host_cell(ctx, &yield_star_class, sizeof(YieldStar));
    js_store(ctx, &y->host.cell, &y->iterator, it);
    js_store(ctx, &y->host.cell, &y->next, next);
    return js_cell(&y->host.cell);
}

JSValue js_yield_star_status(JSValue rec) { return js_int32(((YieldStar *)js_as_cell(rec))->status); }

/* An inner result: done → its value (status DONE, or RETURN after a return()); else the result itself. */
static JSValue inner_result(JSContext *ctx, YieldStar *y, JSValue result, int when_done) {
    if (js_is_exception(result)) return JS_EXCEPTION;
    if (!js_is_object(result)) return js_throw_type_error(ctx, "Iterator result is not an object");
    JSValue done = js_get_value(ctx, result, JS_ATOM(done));
    if (js_is_exception(done)) return JS_EXCEPTION;
    if (!js_truthy(done)) {
        y->status = YS_YIELD;
        return result;
    }
    y->status = when_done;
    return js_get_value(ctx, result, JS_ATOM(value));
}

JSValue js_yield_star_step(JSContext *ctx, JSValue rec, JSValue received, JSValue mode_value) {
    YieldStar *y = (YieldStar *)js_as_cell(rec);
    int mode = js_as_int32(mode_value);
    if (mode == JS_RESUME_NEXT) return inner_result(ctx, y, js_call(ctx, y->next, y->iterator, 1, &received), YS_DONE);
    JSValue method = js_get_value(ctx, y->iterator, mode == JS_RESUME_THROW ? js_atom_from_cstr(ctx, "throw") : JS_ATOM(return));
    if (js_is_exception(method)) return JS_EXCEPTION;
    if (!js_is_nullish(method) && !js_is_callable(method)) return js_throw_type_error(ctx, "The iterator's method is not callable");
    if (mode == JS_RESUME_RETURN) {
        if (js_is_nullish(method)) {  /* no return(): this generator returns the value itself */
            y->status = YS_RETURN;
            return received;
        }
        return inner_result(ctx, y, js_call(ctx, method, y->iterator, 1, &received), YS_RETURN);
    }
    if (!js_is_nullish(method)) return inner_result(ctx, y, js_call(ctx, method, y->iterator, 1, &received), YS_DONE);
    /* no throw(): close the inner iterator (its errors win), then a TypeError */
    JSValue ret = js_get_value(ctx, y->iterator, JS_ATOM(return));
    if (js_is_exception(ret)) return JS_EXCEPTION;
    if (!js_is_nullish(ret)) {
        if (!js_is_callable(ret)) return js_throw_type_error(ctx, "The iterator's 'return' method is not callable");
        JSValue r = js_call(ctx, ret, y->iterator, 0, NULL);
        if (js_is_exception(r)) return JS_EXCEPTION;
        if (!js_is_object(r)) return js_throw_type_error(ctx, "The iterator's 'return' method returned a non-object");
    }
    return js_throw_type_error(ctx, "The iterator does not provide a 'throw' method");
}

/* ---- Async functions (§27.7) ----------------------------------------------------------- */

static const JSClass async_class = { "AsyncFunctionState", sizeof(JSGenerator), NULL, NULL, NULL, NULL, js_generator_visit, NULL, NULL };

JSValue js_async_new(JSContext *ctx, JSGeneratorResume resume, uint32_t slots) {
    JSGenerator *g = js_generator_alloc(ctx, &async_class, JS_NULL, resume, slots);
    g->kind = JS_GEN_ASYNC_FUNCTION;
    JSValue promise = js_new_promise(ctx);  /* after the frame: the cell is fully set when it allocates */
    js_store(ctx, &g->obj.cell, &g->driver, promise);
    return js_object_value(&g->obj);
}

/* The async driver: after the body returns or throws, settle the promise. */
void js_async_resume(JSContext *ctx, JSGenerator *g, JSValue value, int mode) {
    if (g->kind == JS_GEN_ASYNC_GENERATOR) {
        js_async_generator_resume(ctx, g, value, mode);
        return;
    }
    g->status = JS_GEN_EXECUTING;
    JSValue r = g->resume(ctx, g, value, mode);
    if (g->status != JS_GEN_EXECUTING) return;  /* paused at an await */
    g->status = JS_GEN_COMPLETED;
    js_store(ctx, &g->obj.cell, &g->frame, JS_UNDEFINED);
    if (js_is_exception(r)) js_promise_reject_internal(ctx, g->driver, js_take_exception(ctx));
    else js_promise_resolve_internal(ctx, g->driver, r);
}

JSValue js_async_start(JSContext *ctx, JSGenerator *g) {
    js_async_resume(ctx, g, JS_UNDEFINED, JS_RESUME_NEXT);
    return g->driver;
}

int js_await(JSContext *ctx, JSGenerator *g, JSValue v) {
    JSValue promise = js_promise_resolve(ctx, v);
    if (js_is_exception(promise)) return -1;
    js_promise_await(ctx, promise, js_object_value(&g->obj));
    g->status = JS_GEN_AWAITING;
    return 0;
}

/* ---- Realm (§27.3, §27.5, §27.7) ------------------------------------------------------ */

static void install_generator(JSContext *ctx, JSObject *global) {
    (void)global;
    JSValue *in = ctx->intrinsics;
    /* %GeneratorFunction.prototype%: the [[Prototype]] of every generator function */
    in[JS_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_FUNCTION_PROTOTYPE], 4);
    JSObject *gfp = js_as_object(in[JS_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE]);
    /* %GeneratorPrototype%: the [[Prototype]] of each generator function's prototype */
    in[JS_INTRINSIC_GENERATOR_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_ITERATOR_PROTOTYPE], 8);
    JSObject *gp = js_as_object(in[JS_INTRINSIC_GENERATOR_PROTOTYPE]);
    js_define_data(ctx, gfp, JS_ATOM(prototype), in[JS_INTRINSIC_GENERATOR_PROTOTYPE], JS_PROP_CONFIGURABLE);
    js_define_data(ctx, gfp, JS_SYMBOL(toStringTag), js_atom_from_cstr(ctx, "GeneratorFunction"), JS_PROP_CONFIGURABLE);
    js_define_function_kind_ctor(ctx, in[JS_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE], 0);
    js_define_data(ctx, gp, JS_ATOM(constructor), in[JS_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE], JS_PROP_CONFIGURABLE);
    (void)js_define_method(ctx, gp, "next", generator_next, 1);
    (void)js_define_method(ctx, gp, "return", generator_return, 1);
    (void)js_define_method(ctx, gp, "throw", generator_throw, 1);
    js_define_data(ctx, gp, JS_SYMBOL(toStringTag), js_atom_from_cstr(ctx, "Generator"), JS_PROP_CONFIGURABLE);
}
const JSComponent js_component_generator = { "generator", install_generator };

void js_async_function_realm_init(JSContext *ctx) {
    JSValue *in = ctx->intrinsics;
    /* %AsyncFunction.prototype%: the [[Prototype]] of every async function */
    in[JS_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_FUNCTION_PROTOTYPE], 4);
    js_define_data(ctx, js_as_object(in[JS_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE]), JS_SYMBOL(toStringTag),
                   js_atom_from_cstr(ctx, "AsyncFunction"), JS_PROP_CONFIGURABLE);
    js_define_function_kind_ctor(ctx, in[JS_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE], 1);
}
