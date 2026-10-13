/* Promises (ECMAScript §27.2): the promise object, reactions and their jobs,
 * the Promise constructor, its statics and Promise.prototype. */
#include "js_promise.h"

#include "internal.h"
#include "js_atoms.h"
#include "js_builtins.h"
#include "js_error.h"
#include "js_function.h"
#include "js_generator.h"
#include "js_jobs.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jscontext.h"

#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)
#define BUILTIN(fn)                                                                            \
    static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,          \
                      const JSValue *argv, JSValue new_target)
#define UNUSED_ARGS (void)ctx, (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target

/* The realm a builtin was created in: where its %Promise% comes from. */
#define REALM(callee) (js_as_function(callee)->realm)

static void promise_visit(JSCell *c, JSTracer *trc) {
    JSPromise *p = (JSPromise *)c;
    js_trace_value(trc, p->result);
    js_trace_value(trc, p->reactions);
}

static const JSClass promise_class = { "Promise", sizeof(JSPromise), NULL, NULL, NULL, NULL, promise_visit, NULL, NULL };

bool js_is_promise(JSValue v) { return js_is_object(v) && js_as_object(v)->shape->cls == &promise_class; }

static JSValue alloc_promise(JSContext *ctx, JSValue proto) {
    JSPromise *p = (JSPromise *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &promise_class, proto, 0));
    js_init_slot(&p->result, JS_UNDEFINED);
    js_init_slot(&p->reactions, JS_UNDEFINED);
    p->state = JS_PROMISE_PENDING;
    return js_object_value(&p->obj);
}

JSValue js_new_promise(JSContext *ctx) { return alloc_promise(ctx, ctx->intrinsics[JS_INTRINSIC_PROMISE_PROTOTYPE]); }

/* A builtin closure: `data` (any value) is kept in its home_object slot, which only
 * compiled methods use otherwise. */
static JSValue native_with(JSContext *ctx, JSNativeFn fn, uint32_t length, JSValue data) {
    JSValue f = js_new_native(ctx, fn, js_empty_string(), length, JS_FN_STRICT);
    js_store(ctx, &js_as_function(f)->obj.cell, &js_as_function(f)->home_object, data);
    return f;
}
static JSValue data_of(JSValue callee) { return js_as_function(callee)->home_object; }
static JSValue *record_of(JSValue callee) { return ((JSValueArray *)js_as_cell(data_of(callee)))->values; }

static JSValue new_record(JSContext *ctx, uint32_t n) {
    JSValueArray *a = js_alloc_value_array(ctx, n);
    for (uint32_t i = 0; i < n; i++) js_init_slot(&a->values[i], JS_UNDEFINED);
    return js_cell(&a->cell);
}
static void record_set(JSContext *ctx, JSValue rec, uint32_t i, JSValue v) {
    JSValueArray *a = (JSValueArray *)js_as_cell(rec);
    js_store(ctx, &a->cell, &a->values[i], v);
}

/* ---- Reactions --------------------------------------------------------------------- */

/* One per then(): both handlers, and what to settle with the handler's result. */
enum { REACTION_THEN, REACTION_AWAIT };

typedef struct Reaction {
    JSHostCell host;
    uint8_t    kind;          /* AWAIT: on_fulfilled is the async state to resume */
    JSValue    on_fulfilled;  /* a function, or EMPTY: the value passes through */
    JSValue    on_rejected;   /* a function, or EMPTY: the reason passes through */
    JSValue    capability;    /* the derived promise (settled directly), a Capability cell, or undefined */
    JSValue    next;          /* the next (older) reaction, or undefined */
    JSValue    context;       /* the async context of its then() or await, which its job runs under */
} Reaction;

static void reaction_visit(JSCell *c, JSTracer *trc) {
    Reaction *r = (Reaction *)c;
    js_trace_value(trc, r->on_fulfilled);
    js_trace_value(trc, r->on_rejected);
    js_trace_value(trc, r->capability);
    js_trace_value(trc, r->next);
    js_trace_value(trc, r->context);
}
static const JSCellClass reaction_class = { "PromiseReaction", reaction_visit, NULL, NULL };

static void enqueue_reaction(JSContext *ctx, JSValue reaction, JSValue argument, int state) {
    JSJob job = { JS_JOB_PROMISE_REACTION, NULL, reaction, argument, js_int32(state), JS_UNDEFINED };
    js_enqueue_microtask(ctx, &job);
}

/* FulfillPromise / RejectPromise (§27.2.1.4, §27.2.1.7) and TriggerPromiseReactions. */
static void settle(JSContext *ctx, JSValue promise, int state, JSValue v) {
    JSPromise *p = js_as_promise(promise);
    JSValue list = p->reactions;
    js_store(ctx, &p->obj.cell, &p->result, v);
    js_store(ctx, &p->obj.cell, &p->reactions, JS_UNDEFINED);
    p->state = (uint8_t)state;
    if (state == JS_PROMISE_REJECTED && !p->is_handled) js_track_rejection(ctx, promise, true);
    JSValue ordered = JS_UNDEFINED;  /* the list is newest first: reverse it */
    while (!js_is_undefined(list)) {
        Reaction *r = (Reaction *)js_as_cell(list);
        JSValue next = r->next;
        js_store(ctx, &r->host.cell, &r->next, ordered);
        ordered = list;
        list = next;
    }
    for (; !js_is_undefined(ordered); ordered = ((Reaction *)js_as_cell(ordered))->next)
        enqueue_reaction(ctx, ordered, v, state);
}

/* The body of a promise resolve function (§27.2.1.3.2), after its alreadyResolved check. */
static void resolve(JSContext *ctx, JSValue promise, JSValue resolution) {
    if (js_same_bits(resolution, promise)) {
        JSValue e = js_new_error(ctx, JS_TYPE_ERROR, js_new_string_cstr(ctx, "Chaining cycle detected for promise #<Promise>"));
        settle(ctx, promise, JS_PROMISE_REJECTED, e);
        return;
    }
    if (!js_is_object(resolution)) {
        settle(ctx, promise, JS_PROMISE_FULFILLED, resolution);
        return;
    }
    JSValue then = js_get_value(ctx, resolution, JS_ATOM(then));
    if (js_is_exception(then)) {
        settle(ctx, promise, JS_PROMISE_REJECTED, js_take_exception(ctx));
        return;
    }
    if (!js_is_callable(then)) {
        settle(ctx, promise, JS_PROMISE_FULFILLED, resolution);
        return;
    }
    JSJob job = { JS_JOB_RESOLVE_THENABLE, NULL, promise, resolution, then, JS_UNDEFINED };
    js_enqueue_microtask(ctx, &job);
}

void js_promise_resolve_internal(JSContext *ctx, JSValue promise, JSValue resolution) {
    JSPromise *p = js_as_promise(promise);
    if (p->already_resolved) return;
    p->already_resolved = 1;
    resolve(ctx, promise, resolution);
}

void js_promise_reject_internal(JSContext *ctx, JSValue promise, JSValue reason) {
    JSPromise *p = js_as_promise(promise);
    if (p->already_resolved) return;
    p->already_resolved = 1;
    settle(ctx, promise, JS_PROMISE_REJECTED, reason);
}

/* ---- Resolving functions (§27.2.1.3) ----------------------------------------------- */

/* Both share a record: [promise, alreadyResolved]. */
BUILTIN(resolve_function) {
    (void)this_val, (void)new_target;
    JSValue *rec = record_of(callee);
    if (js_truthy(rec[1])) return JS_UNDEFINED;
    record_set(ctx, data_of(callee), 1, JS_TRUE);
    resolve(ctx, rec[0], ARG(0));
    return JS_UNDEFINED;
}

BUILTIN(reject_function) {
    (void)this_val, (void)new_target;
    JSValue *rec = record_of(callee);
    if (js_truthy(rec[1])) return JS_UNDEFINED;
    record_set(ctx, data_of(callee), 1, JS_TRUE);
    settle(ctx, rec[0], JS_PROMISE_REJECTED, ARG(0));
    return JS_UNDEFINED;
}

static void resolving_functions(JSContext *ctx, JSValue promise, JSValue out[2]) {
    JSValue rec = new_record(ctx, 2);
    record_set(ctx, rec, 0, promise);
    record_set(ctx, rec, 1, JS_FALSE);
    out[0] = native_with(ctx, resolve_function, 1, rec);
    out[1] = native_with(ctx, reject_function, 1, rec);
}

/* ---- Capabilities (§27.2.1.5) -------------------------------------------------------- */

/* A PromiseCapability. resolve and reject EMPTY: the promise is native and settled
 * directly (js_promise_*_internal); nothing outside the runtime can see the difference. */
typedef struct Cap {
    JSValue promise, resolve, reject;
} Cap;

typedef struct Capability {
    JSHostCell host;
    JSValue    promise, resolve, reject;
} Capability;

static void capability_visit(JSCell *c, JSTracer *trc) {
    Capability *k = (Capability *)c;
    js_trace_value(trc, k->promise);
    js_trace_value(trc, k->resolve);
    js_trace_value(trc, k->reject);
}
static const JSCellClass capability_class = { "PromiseCapability", capability_visit, NULL, NULL };

/* As a value for a reaction: the promise itself when it is settled directly. */
static JSValue cap_store(JSContext *ctx, const Cap *cap) {
    if (js_is_empty(cap->resolve)) return cap->promise;
    Capability *k = (Capability *)js_alloc_host_cell(ctx, &capability_class, sizeof(Capability));
    js_store(ctx, &k->host.cell, &k->promise, cap->promise);
    js_store(ctx, &k->host.cell, &k->resolve, cap->resolve);
    js_store(ctx, &k->host.cell, &k->reject, cap->reject);
    return js_cell(&k->host.cell);
}

static Cap cap_load(JSValue v) {
    if (js_is_object(v)) return (Cap){ v, JS_EMPTY, JS_EMPTY };
    Capability *k = (Capability *)js_as_cell(v);
    return (Cap){ k->promise, k->resolve, k->reject };
}

static JSValue cap_resolve(JSContext *ctx, const Cap *cap, JSValue v) {
    if (!js_is_empty(cap->resolve)) return js_call(ctx, cap->resolve, JS_UNDEFINED, 1, &v);
    js_promise_resolve_internal(ctx, cap->promise, v);
    return JS_UNDEFINED;
}

static JSValue cap_reject(JSContext *ctx, const Cap *cap, JSValue v) {
    if (!js_is_empty(cap->reject)) return js_call(ctx, cap->reject, JS_UNDEFINED, 1, &v);
    js_promise_reject_internal(ctx, cap->promise, v);
    return JS_UNDEFINED;
}

/* The executor NewPromiseCapability passes to C: it keeps C's resolve and reject in
 * its record [resolve, reject]. */
BUILTIN(capability_executor) {
    (void)this_val, (void)new_target;
    JSValue *rec = record_of(callee);
    if (!js_is_undefined(rec[0]) || !js_is_undefined(rec[1]))
        return js_throw_type_error(ctx, "Promise executor has already been invoked with non-undefined arguments");
    record_set(ctx, data_of(callee), 0, ARG(0));
    record_set(ctx, data_of(callee), 1, ARG(1));
    return JS_UNDEFINED;
}

static bool is_intrinsic_promise(JSValue c);

/* NewPromiseCapability(C). `functions`: resolve and reject must be real functions
 * (they are handed to user code). %Promise% itself takes a shortcut: constructing it
 * is unobservable. 0, or -1 on exception. */
static int new_capability(JSContext *ctx, JSValue c, Cap *cap, bool functions) {
    if (is_intrinsic_promise(c)) {
        JSContext *realm = js_as_function(c)->realm;
        cap->promise = alloc_promise(ctx, realm->intrinsics[JS_INTRINSIC_PROMISE_PROTOTYPE]);
        cap->resolve = cap->reject = JS_EMPTY;
        if (functions) {
            JSValue fns[2];
            resolving_functions(ctx, cap->promise, fns);
            cap->resolve = fns[0];
            cap->reject = fns[1];
        }
        return 0;
    }
    if (!js_is_constructor(c)) {
        js_discard(js_throw_type_error(ctx, "Promise capability constructor is not a constructor"));
        return -1;
    }
    JSValue rec = new_record(ctx, 2);
    JSValue executor = native_with(ctx, capability_executor, 2, rec);
    JSValue promise = js_construct(ctx, c, 1, &executor, c, NULL);
    if (js_is_exception(promise)) return -1;
    JSValue *fns = ((JSValueArray *)js_as_cell(rec))->values;
    if (!js_is_callable(fns[0]) || !js_is_callable(fns[1])) {
        js_discard(js_throw_type_error(ctx, "Promise resolve or reject function is not callable"));
        return -1;
    }
    *cap = (Cap){ promise, fns[0], fns[1] };
    return 0;
}

/* ---- then (§27.2.5.4.1 PerformPromiseThen) and the jobs ----------------------------- */

static void add_reaction(JSContext *ctx, JSValue promise, Reaction *r);

static void perform_then(JSContext *ctx, JSValue promise, JSValue on_fulfilled, JSValue on_rejected, JSValue capability) {
    Reaction *r = (Reaction *)js_alloc_host_cell(ctx, &reaction_class, sizeof(Reaction));
    r->kind = REACTION_THEN;
    js_init_slot(&r->on_fulfilled, js_is_callable(on_fulfilled) ? on_fulfilled : JS_EMPTY);
    js_init_slot(&r->on_rejected, js_is_callable(on_rejected) ? on_rejected : JS_EMPTY);
    js_init_slot(&r->capability, capability);
    js_init_slot(&r->next, JS_UNDEFINED);
    js_init_slot(&r->context, ctx->rt->async_context);
    add_reaction(ctx, promise, r);
}

void js_promise_then_internal(JSContext *ctx, JSValue promise, JSValue on_fulfilled, JSValue on_rejected, JSValue derived) {
    perform_then(ctx, promise, on_fulfilled, on_rejected, derived);
}

void js_promise_await(JSContext *ctx, JSValue promise, JSValue gen) {
    Reaction *r = (Reaction *)js_alloc_host_cell(ctx, &reaction_class, sizeof(Reaction));
    r->kind = REACTION_AWAIT;
    js_init_slot(&r->on_fulfilled, gen);
    js_init_slot(&r->on_rejected, JS_EMPTY);
    js_init_slot(&r->capability, JS_UNDEFINED);
    js_init_slot(&r->next, JS_UNDEFINED);
    js_init_slot(&r->context, ctx->rt->async_context);
    add_reaction(ctx, promise, r);
}

static void add_reaction(JSContext *ctx, JSValue promise, Reaction *r) {
    JSValue reaction = js_cell(&r->host.cell);
    JSPromise *p = js_as_promise(promise);
    if (p->state == JS_PROMISE_PENDING) {
        js_store(ctx, &r->host.cell, &r->next, p->reactions);
        js_store(ctx, &p->obj.cell, &p->reactions, reaction);
    } else {
        if (p->state == JS_PROMISE_REJECTED && !p->is_handled) js_track_rejection(ctx, promise, false);
        enqueue_reaction(ctx, reaction, p->result, p->state);
    }
    p->is_handled = 1;
}

/* NewPromiseReactionJob (§27.2.2.1): a handler's throw rejects the derived promise; only
 * a throwing resolve or reject of a foreign capability escapes, as an uncaught error. */
int js_promise_reaction_job(JSContext *ctx, JSValue reaction, JSValue argument, JSValue state) {
    Reaction *r = (Reaction *)js_as_cell(reaction);
    ctx->rt->async_context = r->context;  /* run_job restores the one before */
    bool rejected = js_as_int32(state) == JS_PROMISE_REJECTED;
    if (r->kind == REACTION_AWAIT) {  /* resume the async call; its outcome settles its own promise */
        js_async_resume(ctx, js_as_generator(r->on_fulfilled), argument, rejected ? JS_RESUME_THROW : JS_RESUME_NEXT);
        return 0;
    }
    JSValue handler = rejected ? r->on_rejected : r->on_fulfilled;
    JSValue result = argument;
    bool threw = rejected;
    if (!js_is_empty(handler)) {
        result = js_call(ctx, handler, JS_UNDEFINED, 1, &argument);
        threw = js_is_exception(result);
        if (threw) result = js_take_exception(ctx);
    }
    if (js_is_undefined(r->capability)) return 0;
    Cap cap = cap_load(r->capability);
    JSValue s = threw ? cap_reject(ctx, &cap, result) : cap_resolve(ctx, &cap, result);
    return js_is_exception(s) ? -1 : 0;
}

/* NewPromiseResolveThenableJob (§27.2.2.2): thenable.then(resolve, reject). */
int js_promise_thenable_job(JSContext *ctx, JSValue promise, JSValue thenable, JSValue then) {
    JSValue fns[2];
    resolving_functions(ctx, promise, fns);
    JSValue r = js_call(ctx, then, thenable, 2, fns);
    if (js_is_exception(r)) {
        JSValue e = js_take_exception(ctx);
        r = js_call(ctx, fns[1], JS_UNDEFINED, 1, &e);
        if (js_is_exception(r)) return -1;
    }
    return 0;
}

/* ---- Helpers ------------------------------------------------------------------------ */

/* Invoke(v, "then", args). */
static JSValue invoke_then(JSContext *ctx, JSValue v, uint32_t argc, const JSValue *argv) {
    JSValue then = js_get_value(ctx, v, JS_ATOM(then));
    if (js_is_exception(then)) return JS_EXCEPTION;
    return js_call_site(ctx, then, v, argc, argv, "then");
}

/* PromiseResolve(C, x) (§27.2.4.7.1). */
static JSValue promise_resolve(JSContext *ctx, JSValue c, JSValue x) {
    if (js_is_promise(x)) {
        JSValue xc = js_get_value(ctx, x, JS_ATOM(constructor));
        if (js_is_exception(xc)) return JS_EXCEPTION;
        if (js_same_bits(xc, c)) return x;
    }
    Cap cap;
    if (new_capability(ctx, c, &cap, false) < 0) return JS_EXCEPTION;
    if (js_is_exception(cap_resolve(ctx, &cap, x))) return JS_EXCEPTION;
    return cap.promise;
}

JSValue js_promise_resolve(JSContext *ctx, JSValue v) {
    return promise_resolve(ctx, ctx->intrinsics[JS_INTRINSIC_PROMISE], v);
}

/* SpeciesConstructor(o, default) (§7.3.22). */
static JSValue species_constructor(JSContext *ctx, JSValue o, JSValue fallback) {
    JSValue c = js_get_value(ctx, o, JS_ATOM(constructor));
    if (js_is_exception(c)) return JS_EXCEPTION;
    if (js_is_undefined(c)) return fallback;
    if (!js_is_object(c)) return js_throw_type_error(ctx, "The .constructor property is not an object");
    JSValue s = js_get_value(ctx, c, JS_SYMBOL(species));
    if (js_is_exception(s)) return JS_EXCEPTION;
    if (js_is_nullish(s)) return fallback;
    if (js_is_constructor(s)) return s;
    return js_throw_type_error(ctx, "object.constructor[Symbol.species] is not a constructor");
}

/* IfAbruptRejectPromise: rejects the capability with the pending exception. */
static JSValue reject_abrupt(JSContext *ctx, const Cap *cap) {
    JSValue e = js_take_exception(ctx);
    if (js_is_exception(cap_reject(ctx, cap, e))) return JS_EXCEPTION;
    return cap->promise;
}

static JSValue this_constructor(JSContext *ctx, JSValue this_val, const char *method) {
    if (js_is_object(this_val)) return this_val;
    return js_throw_type_error(ctx, "%s called on non-object", method);
}

/* ---- The constructor and its statics (§27.2.3, §27.2.4) ---------------------------- */

BUILTIN(promise_ctor) {
    (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Promise constructor cannot be invoked without 'new'");
    JSValue executor = ARG(0);
    if (!js_is_callable(executor)) return js_throw_type_error(ctx, "Promise resolver is not a function");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_PROMISE_PROTOTYPE);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    JSValue promise = alloc_promise(ctx, proto);
    JSValue fns[2];
    resolving_functions(ctx, promise, fns);
    JSValue r = js_call(ctx, executor, JS_UNDEFINED, 2, fns);
    if (js_is_exception(r)) {
        JSValue e = js_take_exception(ctx);
        if (js_is_exception(js_call(ctx, fns[1], JS_UNDEFINED, 1, &e))) return JS_EXCEPTION;
    }
    (void)callee;
    return promise;
}

static bool is_intrinsic_promise(JSValue c) { return js_is_function(c) && js_as_function(c)->entry == promise_ctor; }

BUILTIN(promise_resolve_static) {
    (void)callee, (void)new_target;
    JSValue c = this_constructor(ctx, this_val, "Promise.resolve");
    if (js_is_exception(c)) return JS_EXCEPTION;
    return promise_resolve(ctx, c, ARG(0));
}

BUILTIN(promise_reject_static) {
    (void)callee, (void)new_target;
    Cap cap;
    if (new_capability(ctx, this_val, &cap, false) < 0) return JS_EXCEPTION;
    if (js_is_exception(cap_reject(ctx, &cap, ARG(0)))) return JS_EXCEPTION;
    return cap.promise;
}

BUILTIN(promise_with_resolvers) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    Cap cap;
    if (new_capability(ctx, this_val, &cap, true) < 0) return JS_EXCEPTION;
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "promise"), cap.promise, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "resolve"), cap.resolve, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "reject"), cap.reject, JS_PROP_DEFAULT);
    return o;
}

/* Promise.try(callback, ...args) (ES2025) */
BUILTIN(promise_try) {
    (void)callee, (void)new_target;
    JSValue c = this_constructor(ctx, this_val, "Promise.try");
    if (js_is_exception(c)) return JS_EXCEPTION;
    Cap cap;
    if (new_capability(ctx, c, &cap, false) < 0) return JS_EXCEPTION;
    JSValue r = js_call(ctx, ARG(0), JS_UNDEFINED, argc > 1 ? argc - 1 : 0, argc > 1 ? argv + 1 : NULL);
    if (js_is_exception(r)) return reject_abrupt(ctx, &cap);
    if (js_is_exception(cap_resolve(ctx, &cap, r))) return JS_EXCEPTION;
    return cap.promise;
}

BUILTIN(promise_species) {
    UNUSED_ARGS;
    return this_val;
}

/* ---- Promise.all, allSettled, any, race (§27.2.4.1–5) -------------------------------- */

enum { ALL, ALL_SETTLED, ANY, RACE };

/* What the element functions share: [values, promise, resolve, reject, remaining]. */
enum { ST_VALUES, ST_PROMISE, ST_RESOLVE, ST_REJECT, ST_REMAINING, ST_SIZE };
/* Each element's record: [state, index, alreadyCalled]. */
enum { EL_STATE, EL_INDEX, EL_CALLED, EL_SIZE };

/* remaining -= 1; at zero, settle with the values (ANY: reject with an AggregateError). */
static JSValue element_done(JSContext *ctx, JSValue st, bool any) {
    JSValue *s = ((JSValueArray *)js_as_cell(st))->values;
    int32_t remaining = js_as_int32(s[ST_REMAINING]) - 1;
    record_set(ctx, st, ST_REMAINING, js_int32(remaining));
    if (remaining) return JS_UNDEFINED;
    JSValue values = s[ST_VALUES];
    if (!any) return js_call(ctx, s[ST_RESOLVE], JS_UNDEFINED, 1, &values);
    JSValue e = js_new_error(ctx, JS_AGGREGATE_ERROR, js_new_string_cstr(ctx, "All promises were rejected"));
    js_define_data(ctx, js_as_object(e), js_atom_from_cstr(ctx, "errors"), values, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return js_call(ctx, s[ST_REJECT], JS_UNDEFINED, 1, &e);
}

/* Stores x at the element's index, once; then element_done. */
static JSValue element_call(JSContext *ctx, JSValue callee, JSValue x, bool any) {
    JSValue *el = record_of(callee);
    if (js_truthy(el[EL_CALLED])) return JS_UNDEFINED;
    record_set(ctx, data_of(callee), EL_CALLED, JS_TRUE);
    JSValue st = el[EL_STATE];
    JSValue values = ((JSValueArray *)js_as_cell(st))->values[ST_VALUES];
    JSPropertyDescriptor d = js_data_descriptor(x, JS_PROP_DEFAULT);
    if (js_define_own_property(ctx, js_as_object(values), el[EL_INDEX], &d, true) < 0) return JS_EXCEPTION;
    return element_done(ctx, st, any);
}

/* allSettled's { status, value } / { status, reason }. */
static JSValue settled_record(JSContext *ctx, bool fulfilled, JSValue x) {
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "status"), js_new_string_cstr(ctx, fulfilled ? "fulfilled" : "rejected"), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), fulfilled ? JS_ATOM(value) : js_atom_from_cstr(ctx, "reason"), x, JS_PROP_DEFAULT);
    return o;
}

BUILTIN(all_resolve_element) {
    (void)this_val, (void)new_target;
    return element_call(ctx, callee, ARG(0), false);
}
BUILTIN(settled_fulfilled_element) {
    (void)this_val, (void)new_target;
    return element_call(ctx, callee, settled_record(ctx, true, ARG(0)), false);
}
BUILTIN(settled_rejected_element) {
    (void)this_val, (void)new_target;
    return element_call(ctx, callee, settled_record(ctx, false, ARG(0)), false);
}
BUILTIN(any_reject_element) {
    (void)this_val, (void)new_target;
    return element_call(ctx, callee, ARG(0), true);
}

/* PerformPromiseAll / AllSettled / Any / Race: the loop over the iterator. */
static JSValue perform_combinator(JSContext *ctx, int kind, JSValue rec, JSValue c, const Cap *cap, JSValue promise_resolve_fn) {
    JSValue st = new_record(ctx, ST_SIZE);
    record_set(ctx, st, ST_VALUES, js_new_array(ctx, 0));
    record_set(ctx, st, ST_PROMISE, cap->promise);
    record_set(ctx, st, ST_RESOLVE, cap->resolve);
    record_set(ctx, st, ST_REJECT, cap->reject);
    record_set(ctx, st, ST_REMAINING, js_int32(1));
    JSValue values = ((JSValueArray *)js_as_cell(st))->values[ST_VALUES];
    for (uint32_t index = 0;; index++) {
        JSValue next = js_iter_next(ctx, rec);
        if (js_is_exception(next)) return JS_EXCEPTION;
        if (js_is_empty(next)) {
            if (kind == RACE) return cap->promise;
            JSValue r = element_done(ctx, st, kind == ANY);
            return js_is_exception(r) ? JS_EXCEPTION : cap->promise;
        }
        JSValue next_promise = js_call(ctx, promise_resolve_fn, c, 1, &next);
        if (js_is_exception(next_promise)) return JS_EXCEPTION;
        JSValue handlers[2] = { cap->resolve, cap->reject };
        if (kind != RACE) {
            if (js_array_push(ctx, js_as_object(values), JS_UNDEFINED) < 0) return JS_EXCEPTION;
            JSValue el = new_record(ctx, EL_SIZE);
            record_set(ctx, el, EL_STATE, st);
            record_set(ctx, el, EL_INDEX, js_index_key(index));
            record_set(ctx, el, EL_CALLED, JS_FALSE);
            if (kind == ALL) handlers[0] = native_with(ctx, all_resolve_element, 1, el);
            else if (kind == ANY) handlers[1] = native_with(ctx, any_reject_element, 1, el);
            else {
                handlers[0] = native_with(ctx, settled_fulfilled_element, 1, el);
                handlers[1] = native_with(ctx, settled_rejected_element, 1, el);
            }
            JSValue *s = ((JSValueArray *)js_as_cell(st))->values;
            record_set(ctx, st, ST_REMAINING, js_int32(js_as_int32(s[ST_REMAINING]) + 1));
        }
        if (js_is_exception(invoke_then(ctx, next_promise, 2, handlers))) return JS_EXCEPTION;
    }
}

static JSValue combinator(JSContext *ctx, JSValue c, JSValue iterable, int kind) {
    Cap cap;
    if (new_capability(ctx, c, &cap, true) < 0) return JS_EXCEPTION;
    /* GetPromiseResolve (§27.2.4.1.1) */
    JSValue promise_resolve_fn = js_get_value(ctx, c, js_atom_from_cstr(ctx, "resolve"));
    if (js_is_exception(promise_resolve_fn)) return reject_abrupt(ctx, &cap);
    if (!js_is_callable(promise_resolve_fn)) {
        js_discard(js_throw_type_error(ctx, "Promise resolve is not a function"));
        return reject_abrupt(ctx, &cap);
    }
    JSValue rec = js_iter_start(ctx, iterable);
    if (js_is_exception(rec)) return reject_abrupt(ctx, &cap);
    JSValue r = perform_combinator(ctx, kind, rec, c, &cap, promise_resolve_fn);
    if (!js_is_exception(r)) return r;
    JSValue e = js_take_exception(ctx);
    js_iter_close_throw(ctx, rec);  /* unless the iterator itself failed (then it is done) */
    js_discard(js_throw(ctx, e));
    return reject_abrupt(ctx, &cap);
}

#define COMBINATOR(fn, kind)                                                                   \
    BUILTIN(fn) {                                                                              \
        (void)callee, (void)new_target;                                                        \
        return combinator(ctx, this_val, ARG(0), kind);                                        \
    }
COMBINATOR(promise_all, ALL)
COMBINATOR(promise_all_settled, ALL_SETTLED)
COMBINATOR(promise_any, ANY)
COMBINATOR(promise_race, RACE)

/* ---- Promise.prototype (§27.2.5) ------------------------------------------------------- */

/* An own data property's value, or EMPTY (none, or an accessor), without running code. */
static JSValue own_data(JSObject *o, JSValue key) {
    uint8_t attrs;
    int32_t slot = js_shape_find(o->shape, key, &attrs);
    return slot < 0 || (attrs & JS_PROP_ACCESSOR) ? JS_EMPTY : *js_object_slot(o, (uint32_t)slot);
}

/* SpeciesConstructor(p, %Promise%) without the lookups when it can only be %Promise%: p has no
 * own properties and inherits from %Promise.prototype%, whose `constructor` is still %Promise%,
 * whose @@species is still the original getter (which returns `this`). */
static bool species_is_intrinsic(JSContext *realm, JSValue promise) {
    JSObject *o = js_as_object(promise);
    JSValue proto = realm->intrinsics[JS_INTRINSIC_PROMISE_PROTOTYPE];
    JSValue ctor = realm->intrinsics[JS_INTRINSIC_PROMISE];
    if (o->shape->prop_count != 0 || !js_same_bits(o->shape->proto, proto) || (o->shape->flags & JS_SHAPE_DICTIONARY)) return false;
    if (!js_same_bits(own_data(js_as_object(proto), JS_ATOM(constructor)), ctor)) return false;
    uint8_t attrs;
    JSObject *c = js_as_object(ctor);
    int32_t slot = js_shape_find(c->shape, JS_SYMBOL(species), &attrs);
    if (slot < 0 || !(attrs & JS_PROP_ACCESSOR)) return false;
    JSAccessorPair *pair = (JSAccessorPair *)js_as_cell(*js_object_slot(c, (uint32_t)slot));
    return js_same_bits(pair->get, realm->intrinsics[JS_INTRINSIC_PROMISE_SPECIES_GETTER]);
}

BUILTIN(promise_proto_then) {
    (void)new_target;
    if (!js_is_promise(this_val))
        return js_throw_type_error(ctx, "Method Promise.prototype.then called on incompatible receiver");
    JSContext *realm = REALM(callee);
    JSValue c = species_is_intrinsic(realm, this_val) ? realm->intrinsics[JS_INTRINSIC_PROMISE]
                                                      : species_constructor(ctx, this_val, realm->intrinsics[JS_INTRINSIC_PROMISE]);
    if (js_is_exception(c)) return JS_EXCEPTION;
    Cap cap;
    if (new_capability(ctx, c, &cap, false) < 0) return JS_EXCEPTION;
    perform_then(ctx, this_val, ARG(0), ARG(1), cap_store(ctx, &cap));
    return cap.promise;
}

BUILTIN(promise_proto_catch) {
    (void)callee, (void)new_target;
    JSValue args[2] = { JS_UNDEFINED, ARG(0) };
    return invoke_then(ctx, this_val, 2, args);
}

/* finally's helpers: a thunk returning its value, and one throwing it. */
BUILTIN(value_thunk) {
    UNUSED_ARGS;
    return data_of(callee);
}
BUILTIN(thrower) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    return js_throw(ctx, data_of(callee));
}

/* Then Finally / Catch Finally (§27.2.5.3.1–2): record [onFinally, C]. */
static JSValue finally_step(JSContext *ctx, JSValue callee, JSValue arg, bool rejected) {
    JSValue *rec = record_of(callee);
    JSValue result = js_call(ctx, rec[0], JS_UNDEFINED, 0, NULL);
    if (js_is_exception(result)) return JS_EXCEPTION;
    JSValue p = promise_resolve(ctx, rec[1], result);
    if (js_is_exception(p)) return JS_EXCEPTION;
    JSValue thunk = native_with(ctx, rejected ? thrower : value_thunk, 0, arg);
    return invoke_then(ctx, p, 1, &thunk);
}
BUILTIN(then_finally) {
    (void)this_val, (void)new_target;
    return finally_step(ctx, callee, ARG(0), false);
}
BUILTIN(catch_finally) {
    (void)this_val, (void)new_target;
    return finally_step(ctx, callee, ARG(0), true);
}

BUILTIN(promise_proto_finally) {
    (void)new_target;
    if (!js_is_object(this_val)) return js_throw_type_error(ctx, "Promise.prototype.finally called on non-object");
    JSValue c = species_constructor(ctx, this_val, REALM(callee)->intrinsics[JS_INTRINSIC_PROMISE]);
    if (js_is_exception(c)) return JS_EXCEPTION;
    JSValue on_finally = ARG(0);
    JSValue handlers[2] = { on_finally, on_finally };
    if (js_is_callable(on_finally)) {
        JSValue rec = new_record(ctx, 2);
        record_set(ctx, rec, 0, on_finally);
        record_set(ctx, rec, 1, c);
        handlers[0] = native_with(ctx, then_finally, 1, rec);
        handlers[1] = native_with(ctx, catch_finally, 1, rec);
    }
    return invoke_then(ctx, this_val, 2, handlers);
}

/* ---- Realm ------------------------------------------------------------------------------ */

static void install_promise(JSContext *ctx, JSObject *global) {
    JSValue *in = ctx->intrinsics;
    JSValue proto = js_new_object_proto(ctx, in[JS_INTRINSIC_OBJECT_PROTOTYPE], 8);
    in[JS_INTRINSIC_PROMISE_PROTOTYPE] = proto;
    JSValue ctor = js_new_native(ctx, promise_ctor, js_atom_from_cstr(ctx, "Promise"), 1, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    in[JS_INTRINSIC_PROMISE] = ctor;
    JSObject *c = js_as_object(ctor), *p = js_as_object(proto);
    js_define_data(ctx, c, JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, p, JS_ATOM(constructor), ctor, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, global, js_atom_from_cstr(ctx, "Promise"), ctor, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    (void)js_define_method(ctx, c, "all", promise_all, 1);
    (void)js_define_method(ctx, c, "allSettled", promise_all_settled, 1);
    (void)js_define_method(ctx, c, "any", promise_any, 1);
    (void)js_define_method(ctx, c, "race", promise_race, 1);
    (void)js_define_method(ctx, c, "reject", promise_reject_static, 1);
    (void)js_define_method(ctx, c, "resolve", promise_resolve_static, 1);
    (void)js_define_method(ctx, c, "try", promise_try, 1);
    (void)js_define_method(ctx, c, "withResolvers", promise_with_resolvers, 0);
    JSValue species = js_new_native(ctx, promise_species, js_atom_from_cstr(ctx, "get [Symbol.species]"), 0, JS_FN_STRICT);
    ctx->intrinsics[JS_INTRINSIC_PROMISE_SPECIES_GETTER] = species;
    JSPropertyDescriptor d = { JS_DESC_GET | JS_DESC_SET | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE, JS_PROP_CONFIGURABLE,
                               JS_UNDEFINED, species, JS_UNDEFINED };
    if (js_define_own_property(ctx, c, JS_SYMBOL(species), &d, true) < 0) js_fatal("promise realm init");

    (void)js_define_method(ctx, p, "then", promise_proto_then, 2);
    (void)js_define_method(ctx, p, "catch", promise_proto_catch, 1);
    (void)js_define_method(ctx, p, "finally", promise_proto_finally, 1);
    js_define_data(ctx, p, JS_SYMBOL(toStringTag), js_atom_from_cstr(ctx, "Promise"), JS_PROP_CONFIGURABLE);
    js_async_function_realm_init(ctx);  /* generator.c */
}
const JSComponent js_component_promise = { "promise", install_promise };
