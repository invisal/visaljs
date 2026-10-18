/* Function objects and calls (ECMAScript §10.2, §10.3). */
#include "js_function.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_ops.h"
#include "jscontext.h"

/* cell flags (kind-specific): `prototype` hasn't been created yet (lazily, on first observation) */
#define PROTOTYPE_PENDING 0x01u

/* ---- The class: lazy `prototype`, GC fields ------------------------------- */

/* Creates F.prototype = { constructor: F } if it's still pending. */
static void materialize_prototype(JSContext *ctx, JSObject *f) {
    if (!(f->cell.flags & PROTOTYPE_PENDING)) return;
    f->cell.flags &= (uint16_t)~PROTOTYPE_PENDING;
    JSValue proto = js_new_object(ctx);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), js_object_value(f), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, f, JS_ATOM(prototype), proto, JS_PROP_WRITABLE);
}

static bool is_prototype(JSValue key) { return js_same_bits(key, JS_ATOM(prototype)); }

/* Functions with and without a pending `prototype` share shapes, so a missing `prototype` (an
 * arrow's, a bound function's) isn't cached: it would answer for a pending one too. */
static int fn_get_own(JSContext *ctx, JSObject *f, JSValue key, JSPropertyDescriptor *out) {
    if (!is_prototype(key)) return JS_ORDINARY;
    materialize_prototype(ctx, f);
    return js_ordinary_get_own_property(ctx, f, key, out) > 0 ? JS_ORDINARY : JS_ORDINARY_UNCACHED;
}

static int fn_define(JSContext *ctx, JSObject *f, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    (void)desc, (void)throw_on_fail;
    if (is_prototype(key)) materialize_prototype(ctx, f);
    return JS_ORDINARY;
}

static int fn_delete(JSContext *ctx, JSObject *f, JSValue key, bool throw_on_fail) {
    (void)throw_on_fail;
    if (is_prototype(key)) materialize_prototype(ctx, f);
    return JS_ORDINARY;
}

static uint32_t fn_extra_keys(JSContext *ctx, JSObject *f, JSValue *out) {
    (void)out;
    materialize_prototype(ctx, f);  /* enumerating observes it */
    return 0;
}

static void fn_visit(JSCell *c, JSTracer *trc) {
    JSFunction *f = (JSFunction *)c;
    js_trace_value(trc, f->home_object);
    js_trace_value(trc, f->bound_this);
    if (f->env) js_trace_cell(trc, &f->env->cell);
    if (f->instance_shape) js_trace_cell(trc, &f->instance_shape->cell);
}

const JSClass js_class_function = {
    "Function", sizeof(JSFunction), fn_get_own, fn_define, fn_delete, fn_extra_keys, fn_visit, NULL, NULL,
};

/* ---- Creation --------------------------------------------------------------- */

static JSFunction *alloc_function(JSContext *ctx, JSNativeFn entry, uint32_t flags, JSValue name, uint32_t length) {
    /* a generator function inherits from %GeneratorFunction.prototype% (§27.3.3), an async
     * function from %AsyncFunction.prototype% (§27.7.3) */
    bool gen = flags & JS_FN_GENERATOR, async = flags & JS_FN_ASYNC;
    JSIntrinsic proto = gen && async ? JS_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE
                      : gen          ? JS_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE
                      : async        ? JS_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE
                                     : JS_INTRINSIC_FUNCTION_PROTOTYPE;
    JSIntrinsic cache = gen && async ? JS_INTRINSIC_ASYNC_GENERATOR_FUNCTION_SHAPE
                      : gen          ? JS_INTRINSIC_GENERATOR_FUNCTION_SHAPE
                      : async        ? JS_INTRINSIC_ASYNC_FUNCTION_SHAPE
                                     : JS_INTRINSIC_FUNCTION_SHAPE;
    /* length, then name (§10.2.9 order): configurable only, in the shape already */
    JSValue keys[2] = { JS_ATOM(length), JS_ATOM(name) };
    JSShape *shape = js_cached_shape(ctx, cache, &js_class_function, ctx->intrinsics[proto], 3, 2, keys, JS_PROP_CONFIGURABLE);
    JSFunction *f = (JSFunction *)js_alloc_object(ctx, JS_CELL_FUNCTION, shape);
    f->entry = entry;
    f->home_object = JS_UNDEFINED;
    f->bound_this = JS_EMPTY;
    f->realm = ctx;
    f->flags = flags;
    js_init_slot(js_object_slot(&f->obj, 0), js_number((double)length));
    js_init_slot(js_object_slot(&f->obj, 1), name);
    return f;
}

JSValue js_new_function(JSContext *ctx, const JSFunctionInfo *info) {
    JSValue name = info->name ? js_cell((JSCell *)info->name) : js_empty_string();
    JSFunction *f = alloc_function(ctx, info->generic, info->flags, name, info->length);
    f->info = info;
    if ((info->flags & (JS_FN_CONSTRUCTOR | JS_FN_ORDINARY)) == (JS_FN_CONSTRUCTOR | JS_FN_ORDINARY))
        f->obj.cell.flags |= PROTOTYPE_PENDING;
    if (info->flags & JS_FN_GENERATOR) {
        /* its own prototype: what its generators inherit from; no `constructor` (§15.5.4) */
        JSIntrinsic gp = info->flags & JS_FN_ASYNC ? JS_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE : JS_INTRINSIC_GENERATOR_PROTOTYPE;
        JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[gp], JS_DEFAULT_INLINE_SLOTS);
        js_define_data(ctx, &f->obj, JS_ATOM(prototype), proto, JS_PROP_WRITABLE);
    }
    return js_object_value(&f->obj);
}

JSValue js_new_closure(JSContext *ctx, const JSFunctionInfo *info, JSValue env) {
    JSValue f = js_new_function(ctx, info);
    /* not an initializing store: a generator function allocates its prototype after the cell */
    js_store_ptr(ctx, &js_as_function(f)->obj.cell, &js_as_function(f)->env, js_as_env(env));
    return f;
}

/* ---- Environments ---------------------------------------------------------------- */

const JSCellClass js_env_cell_class = { "Env", NULL, NULL, NULL };  /* gc_visit.h visits it */

JSValue js_new_env(JSContext *ctx, JSValue parent, uint32_t count) {
    JSEnv *e = (JSEnv *)js_alloc_cell(ctx, JS_CELL_ENV, sizeof(JSEnv) + (size_t)count * sizeof(JSValue));
    e->cell.aux = count;
    e->parent = js_as_env(parent);  /* barrier: fresh cell */
    return js_cell(&e->cell);
}

JSValue js_env_copy(JSContext *ctx, JSValue env) {
    JSEnv *from = js_as_env(env);
    JSValue copy = js_new_env(ctx, from->parent ? js_cell(&from->parent->cell) : JS_UNDEFINED, from->cell.aux);
    JSEnv *to = js_as_env(copy);
    memcpy(to->vars, from->vars, from->cell.aux * sizeof(JSValue));  /* a fresh cell: no barrier */
    return copy;
}

JSValue js_new_native(JSContext *ctx, JSNativeFn fn, JSValue name, uint32_t length, uint32_t flags) {
    return js_object_value(&alloc_function(ctx, fn, flags, name, length)->obj);
}

JSValue js_define_method(JSContext *ctx, JSObject *o, const char *name, JSNativeFn fn, uint32_t length) {
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue f = js_new_native(ctx, fn, key, length, JS_FN_STRICT);
    js_define_data(ctx, o, key, f, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return f;
}

/* ---- Calls ---------------------------------------------------------------------- */

static JSValue not_callable(JSContext *ctx, JSValue f, const char *callee_text, const char *what) {
    if (callee_text) return js_throw_type_error(ctx, "%s is not a %s", callee_text, what);
    /* no source text: describe the value like V8 does for primitives */
    char buf[64] = "value";
    if (js_is_number(f) || js_is_bool(f) || js_is_nullish(f)) {
        JSValue s = js_to_string(ctx, f);
        if (!js_is_exception(s)) buf[js_view_to_utf8(js_string_view(ctx, s), buf, sizeof buf - 1)] = '\0';
    }
    return js_throw_type_error(ctx, "%s is not a %s", buf, what);
}

JSValue js_call_site(JSContext *ctx, JSValue f, JSValue this_val, uint32_t argc, const JSValue *argv, const char *callee_text) {
    if (JS_UNLIKELY(!js_is_function(f))) return not_callable(ctx, f, callee_text, "function");
    JSFunction *fn = js_as_function(f);
    if (JS_UNLIKELY(fn->flags & JS_FN_CLASS_CTOR)) {
        char name[64] = "";
        JSValue n = js_get_value(ctx, f, JS_ATOM(name));
        if (js_is_exception(n)) return JS_EXCEPTION;
        if (js_is_string(n)) name[js_view_to_utf8(js_string_view(ctx, n), name, sizeof name - 1)] = '\0';
        return js_throw_type_error(ctx, "Class constructor %s cannot be invoked without 'new'", name);
    }
    /* the callee's own realm; a proxy has none (its traps run in the caller's) */
    return fn->entry(JS_UNLIKELY(fn->flags & JS_FN_PROXY) ? ctx : fn->realm, f, this_val, argc, argv, JS_UNDEFINED);
}

JSValue js_call(JSContext *ctx, JSValue f, JSValue this_val, uint32_t argc, const JSValue *argv) {
    return js_call_site(ctx, f, this_val, argc, argv, NULL);
}

/* The arguments of a spread call, from the array the caller built (dense, no holes:
 * js_array_append/js_array_spread only push). The array stays referenced by `args`. */
static const JSValue *spread_args(JSValue args, uint32_t *argc) {
    JSObject *a = js_as_object(args);
    *argc = js_array_length(a);
    return *argc ? a->elements->data : NULL;
}

JSValue js_call_spread(JSContext *ctx, JSValue f, JSValue this_val, JSValue args, const char *callee_text) {
    uint32_t argc;
    const JSValue *argv = spread_args(args, &argc);
    JSValue r = js_call_site(ctx, f, this_val, argc, argv, callee_text);
    js_keep_alive(args);
    return r;
}

JSValue js_construct_spread(JSContext *ctx, JSValue f, JSValue args, const char *callee_text) {
    uint32_t argc;
    const JSValue *argv = spread_args(args, &argc);
    JSValue r = js_construct(ctx, f, argc, argv, JS_UNDEFINED, callee_text);
    js_keep_alive(args);
    return r;
}

/* GetFunctionRealm (§7.3.24): a function's own realm, a proxy's target's; NULL with a
 * TypeError for a revoked proxy. */
JSContext *js_function_realm(JSContext *ctx, JSValue f) {
    for (;;) {
        if (!js_is_function(f)) return ctx;
        if (!(js_as_function(f)->flags & JS_FN_PROXY)) return js_as_function(f)->realm;
        f = js_proxy_target(f);
        if (js_is_null(f)) {
            js_discard(js_throw_type_error(ctx, "Cannot perform 'construct' on a proxy that has been revoked"));
            return NULL;
        }
    }
}

JSValue js_get_prototype_from_constructor(JSContext *ctx, JSValue new_target, JSIntrinsic fallback) {
    JSValue proto = js_get_value(ctx, new_target, JS_ATOM(prototype));
    if (js_is_exception(proto) || js_is_object(proto)) return proto;
    JSContext *realm = js_function_realm(ctx, new_target);
    return realm ? realm->intrinsics[fallback] : JS_EXCEPTION;
}

/* The root shape of the objects `new f` makes, with at least `slots` inline slots: kept on f, and
 * grown by learn_instance_slots to what its instances end up holding. */
static JSShape *instance_root(JSContext *ctx, JSFunction *f, JSValue proto, uint16_t slots) {
    JSShape *s = f->instance_shape;
    if (JS_UNLIKELY(!s || !js_same_bits(s->proto, proto) || s->inline_cap < slots)) {
        s = js_shape_root(ctx, &js_class_object, proto, slots);
        js_store_ptr(ctx, &f->obj.cell, &f->instance_shape, s);
    }
    return s;
}

/* Slack tracking: when the constructors (a class's and its bases') left `v` with more properties
 * than its root shape has inline slots, the next instances get room for them all. A derived
 * class's `this` is made by its base, which can't count its subclasses' properties; the rest
 * would sit out of line, where an inline cache's hit isn't inlined. */
static void learn_instance_slots(JSContext *ctx, JSFunction *f, JSValue v) {
    JSShape *root = f->instance_shape;
    if (!root || !js_is_object(v)) return;
    JSShape *s = js_as_object(v)->shape;
    if (JS_LIKELY(s->prop_count <= root->inline_cap || root->inline_cap >= JS_MAX_INLINE_SLOTS)) return;
    JSShape *r = s;
    while (r->parent) r = r->parent;
    if (r != root) return;  /* not made from it: an object the constructor returned, or a dictionary */
    JSShape *grown = js_shape_root(ctx, &js_class_object, root->proto, (uint16_t)(s->prop_count < JS_MAX_INLINE_SLOTS ? s->prop_count : JS_MAX_INLINE_SLOTS));
    js_store_ptr(ctx, &f->obj.cell, &f->instance_shape, grown);
}

JSValue js_create_from_constructor(JSContext *ctx, JSValue new_target, JSIntrinsic fallback) {
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, fallback);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    if (!js_is_function(new_target)) return js_new_object_proto(ctx, proto, JS_DEFAULT_INLINE_SLOTS);
    return js_object_value(js_alloc_object(ctx, JS_CELL_OBJECT, instance_root(ctx, js_as_function(new_target), proto, JS_DEFAULT_INLINE_SLOTS)));
}

JSValue js_new_instance(JSContext *ctx, JSValue fv, uint16_t slots, JSPropCache *ic) {
    JSObject *fo = js_as_object(fv);
    JSValue proto = fo->shape == ic->shape && ic->kind == JS_IC_OWN ? *js_object_slot(fo, ic->slot)  /* out of line, often */
                                                                    : js_get_prop(ctx, fv, JS_ATOM(prototype), ic);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    if (!js_is_object(proto)) proto = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];  /* OrdinaryCreateFromConstructor's fallback */
    return js_object_value(js_alloc_object(ctx, JS_CELL_OBJECT, instance_root(ctx, js_as_function(fv), proto, slots)));
}

JSValue js_construct(JSContext *ctx, JSValue f, uint32_t argc, const JSValue *argv, JSValue new_target, const char *callee_text) {
    if (JS_UNLIKELY(!js_is_constructor(f))) return not_callable(ctx, f, callee_text, "constructor");
    JSFunction *fn = js_as_function(f);
    bool outermost = js_is_undefined(new_target) || js_same_bits(new_target, f);  /* not a super() */
    if (js_is_undefined(new_target)) new_target = f;
    if (!(fn->flags & JS_FN_ORDINARY)) {  /* builtins create their own object; a derived constructor gets it from super() */
        JSValue r = fn->entry(fn->flags & JS_FN_PROXY ? ctx : fn->realm, f, JS_UNDEFINED, argc, argv, new_target);
        if (outermost && (fn->flags & JS_FN_DERIVED) && !js_is_exception(r)) learn_instance_slots(ctx, fn, r);
        return r;
    }
    /* [[Construct]] of an ordinary function (§10.2.2): this = a new object; an object result wins */
    JSValue this_val = js_create_from_constructor(fn->realm, new_target, JS_INTRINSIC_OBJECT_PROTOTYPE);
    if (js_is_exception(this_val)) return JS_EXCEPTION;
    JSValue r = fn->entry(fn->realm, f, this_val, argc, argv, new_target);
    if (js_is_exception(r)) return JS_EXCEPTION;
    if (outermost) learn_instance_slots(ctx, fn, this_val);
    return js_is_object(r) ? r : this_val;
}

/* ---- Classes and super ------------------------------------------------------------- */

static void describe_value(JSContext *ctx, JSValue v, char *buf, size_t cap) {
    snprintf(buf, cap, "%s", js_is_object(v) ? "[object Object]" : "value");
    if (js_is_object(v)) return;
    JSValue s = js_to_string(ctx, v);
    if (js_is_exception(s)) {
        js_discard(js_take_exception(ctx));
        return;
    }
    buf[js_view_to_utf8(js_string_view(ctx, s), buf, cap - 1)] = '\0';
}

JSValue js_class_setup(JSContext *ctx, JSValue ctor, JSValue heritage) {
    JSValue proto_parent = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];
    JSValue ctor_parent = ctx->intrinsics[JS_INTRINSIC_FUNCTION_PROTOTYPE];
    if (js_is_null(heritage)) {
        proto_parent = JS_NULL;
    } else if (!js_is_empty(heritage)) {
        char buf[64];
        if (!js_is_constructor(heritage)) {
            describe_value(ctx, heritage, buf, sizeof buf);
            return js_throw_type_error(ctx, "Class extends value %s is not a constructor or null", buf);
        }
        proto_parent = js_get_value(ctx, heritage, JS_ATOM(prototype));
        if (js_is_exception(proto_parent)) return JS_EXCEPTION;
        if (!js_is_object(proto_parent) && !js_is_null(proto_parent)) {
            describe_value(ctx, proto_parent, buf, sizeof buf);
            return js_throw_type_error(ctx, "Class extends value does not have valid prototype property %s", buf);
        }
        ctor_parent = heritage;
    }
    JSValue proto = js_new_object_proto(ctx, proto_parent, JS_DEFAULT_INLINE_SLOTS);
    JSObject *f = js_as_object(ctor);
    f->cell.flags &= (uint16_t)~PROTOTYPE_PENDING;  /* set here, not lazily */
    if (!js_same_bits(ctor_parent, ctx->intrinsics[JS_INTRINSIC_FUNCTION_PROTOTYPE])) {
        int r = js_set_prototype_of(ctx, f, ctor_parent);  /* a fresh function: can't fail */
        (void)r;
    }
    js_define_data(ctx, f, JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), ctor, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    js_set_home_object(ctx, ctor, proto);
    return proto;
}

void js_set_home_object(JSContext *ctx, JSValue fn, JSValue home) {
    JSFunction *f = js_as_function(fn);
    js_store(ctx, &f->obj.cell, &f->home_object, home);
}

void js_define_class_member(JSContext *ctx, JSObject *target, JSValue key, int kind, JSValue fn) {
    JSPropertyDescriptor d = { JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE, JS_PROP_CONFIGURABLE, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    if (kind == 0) {
        d.has |= JS_DESC_VALUE | JS_DESC_WRITABLE;
        d.attrs |= JS_PROP_WRITABLE;
        d.value = fn;
    } else if (kind == 1) {
        d.has |= JS_DESC_GET;
        d.get = fn;
    } else {
        d.has |= JS_DESC_SET;
        d.set = fn;
    }
    int r = js_define_own_property(ctx, target, key, &d, true);  /* e.g. a static "prototype" is an early error */
    if (r < 0) js_discard(js_take_exception(ctx));
}

/* GetSuperBase: the home object's [[Prototype]]. */
static JSValue super_base(JSContext *ctx, JSValue callee) {
    JSValue home = js_as_function(callee)->home_object;
    if (!js_is_object(home)) return js_throw_syntax_error(ctx, "'super' keyword unexpected here");
    JSValue base = js_get_prototype_of(js_as_object(home));
    if (!js_is_object(base))
        return js_throw_type_error(ctx, "Cannot read properties of %s (super)", js_is_null(base) ? "null" : "undefined");
    return base;
}

JSValue js_super_get(JSContext *ctx, JSValue callee, JSValue key, JSValue this_val) {
    JSValue base = super_base(ctx, callee);
    if (js_is_exception(base)) return JS_EXCEPTION;
    JSValue k = js_to_property_key(ctx, key);
    if (js_is_exception(k)) return JS_EXCEPTION;
    return js_get(ctx, js_as_object(base), k, this_val);
}

int js_super_set(JSContext *ctx, JSValue callee, JSValue key, JSValue v, JSValue this_val) {
    JSValue base = super_base(ctx, callee);
    if (js_is_exception(base)) return -1;
    JSValue k = js_to_property_key(ctx, key);
    if (js_is_exception(k)) return -1;
    return js_set(ctx, js_as_object(base), k, v, this_val, true);  /* class code is strict */
}

JSValue js_super_construct(JSContext *ctx, JSValue callee, JSValue new_target, uint32_t argc, const JSValue *argv) {
    JSValue parent = js_get_prototype_of(js_as_object(callee));
    if (!js_is_constructor(parent)) return js_throw_type_error(ctx, "Super constructor is not a constructor");
    return js_construct(ctx, parent, argc, argv, new_target, NULL);
}

JSValue js_super_construct_spread(JSContext *ctx, JSValue callee, JSValue new_target, JSValue args) {
    JSObject *a = js_as_object(args);
    uint32_t argc = js_array_length(a);
    JSValue r = js_super_construct(ctx, callee, new_target, argc, argc ? a->elements->data : NULL);
    js_keep_alive(args);
    return r;
}

JSValue js_bind_this(JSContext *ctx, JSValue current, JSValue v) {
    if (!js_is_empty(current)) return js_throw_reference_error(ctx, "Super constructor may only be called once");
    return v;
}

JSValue js_check_this(JSContext *ctx, JSValue this_val) {
    if (js_is_empty(this_val))
        return js_throw_reference_error(ctx, "Must call super constructor in derived class before accessing 'this' or returning from derived constructor");
    return this_val;
}

JSValue js_derived_return(JSContext *ctx, JSValue v, JSValue this_val) {
    if (js_is_object(v)) return v;
    if (!js_is_undefined(v)) return js_throw_type_error(ctx, "Derived constructors may only return object or undefined");
    return js_check_this(ctx, this_val);
}

/* ---- Bound functions (§10.4.1) ------------------------------------------------------ */

/* The bound arguments live in an environment cell: a GC'd array the function already traces. */
static JSValue bound_entry(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)this_val;
    JSFunction *b = js_as_function(callee);
    JSValue target = b->home_object;
    uint32_t nbound = b->env ? b->env->cell.aux : 0;
    JSValueArray *all = js_alloc_value_array(ctx, nbound + argc);  /* GC-visible while the callee runs */
    for (uint32_t i = 0; i < nbound; i++) all->values[i] = b->env->vars[i];  /* barrier: fresh cell */
    for (uint32_t i = 0; i < argc; i++) all->values[nbound + i] = argv[i];  /* barrier: fresh cell */
    JSValue held = js_cell(&all->cell);
    JSValue r;
    if (js_is_undefined(new_target)) {
        r = js_call(ctx, target, b->bound_this, nbound + argc, all->values);
    } else {
        /* new on a bound function: construct the target; new_target, if it's the bound function, becomes the target */
        if (js_same_bits(new_target, callee)) new_target = target;
        r = js_construct(ctx, target, nbound + argc, all->values, new_target, NULL);
    }
    js_keep_alive(held);
    return r;
}

JSValue js_bind_function(JSContext *ctx, JSValue target, JSValue bound_this, uint32_t argc, const JSValue *argv) {
    /* length: max(0, target.length - argc) when target has an own numeric length (§20.2.3.2 steps 4–7) */
    double length = 0;
    JSPropertyDescriptor d;
    int has = js_get_own_property(ctx, js_as_object(target), JS_ATOM(length), &d);
    if (has < 0) return JS_EXCEPTION;
    if (has) {
        JSValue len = js_get_value(ctx, target, JS_ATOM(length));
        if (js_is_exception(len)) return JS_EXCEPTION;
        if (js_is_number(len)) {
            double t = js_as_number(len);
            if (t == INFINITY) length = INFINITY;
            else if (t != -INFINITY && t == t) {
                t = trunc(t) - argc;
                length = t > 0 ? t : 0;
            }
        }
    }
    JSValue name = js_get_value(ctx, target, JS_ATOM(name));
    if (js_is_exception(name)) return JS_EXCEPTION;
    if (!js_is_string(name)) name = js_empty_string();
    JSValue full = js_concat(ctx, js_new_string_cstr(ctx, "bound "), name);
    if (js_is_exception(full)) return JS_EXCEPTION;
    uint32_t flags = JS_FN_BOUND | (js_is_constructor(target) ? JS_FN_CONSTRUCTOR : 0);
    JSValue f = js_new_native(ctx, bound_entry, full, 0, flags);
    JSFunction *b = js_as_function(f);
    /* the bound function's [[Prototype]] is the target's */
    JSValue proto = js_object_get_prototype_of(ctx, js_as_object(target));
    if (js_is_exception(proto)) return proto;
    if (!js_same_bits(proto, ctx->intrinsics[JS_INTRINSIC_FUNCTION_PROTOTYPE])) {
        int r = js_set_prototype_of(ctx, &b->obj, proto);
        (void)r;
    }
    JSPropertyDescriptor len = { JS_DESC_VALUE, 0, js_number(length), JS_UNDEFINED, JS_UNDEFINED };
    int r = js_define_own_property(ctx, &b->obj, JS_ATOM(length), &len, false);
    (void)r;
    js_store(ctx, &b->obj.cell, &b->home_object, target);
    js_store(ctx, &b->obj.cell, &b->bound_this, bound_this);
    if (argc) {
        JSValue env = js_new_env(ctx, JS_UNDEFINED, argc);
        for (uint32_t i = 0; i < argc; i++) js_as_env(env)->vars[i] = argv[i];  /* barrier: fresh cell */
        js_store_ptr(ctx, &b->obj.cell, &b->env, js_as_env(env));
    }
    return f;
}

/* ---- instanceof and in ------------------------------------------------------------ */

/* OrdinaryHasInstance (§7.3.21): a bound function defers to its target. */
JSValue js_ordinary_has_instance(JSContext *ctx, JSValue target, JSValue v) {
    if (!js_is_callable(target)) return JS_FALSE;
    if (js_as_function(target)->flags & JS_FN_BOUND) return js_instanceof(ctx, v, js_as_function(target)->home_object);
    if (!js_is_object(v)) return JS_FALSE;
    JSValue proto = js_get_value(ctx, target, JS_ATOM(prototype));
    if (js_is_exception(proto)) return JS_EXCEPTION;
    if (!js_is_object(proto)) return js_throw_type_error(ctx, "Function has non-object prototype in instanceof check");
    for (JSValue p = js_object_get_prototype_of(ctx, js_as_object(v));; p = js_object_get_prototype_of(ctx, js_as_object(p))) {
        if (js_is_exception(p)) return p;
        if (!js_is_object(p)) return JS_FALSE;
        if (js_same_bits(p, proto)) return JS_TRUE;
    }
}

/* InstanceofOperator (§13.10.2): the target's @@hasInstance decides, when it has one; the
 * built-in Function.prototype[@@hasInstance] goes straight to OrdinaryHasInstance. */
JSValue js_instanceof(JSContext *ctx, JSValue v, JSValue target) {
    if (!js_is_object(target)) return js_throw_type_error(ctx, "Right-hand side of 'instanceof' is not an object");
    JSValue handler = js_get_value(ctx, target, JS_SYMBOL(hasInstance));
    if (js_is_exception(handler)) return handler;
    if (!js_is_nullish(handler) && !js_same_bits(handler, ctx->intrinsics[JS_INTRINSIC_FUNCTION_HAS_INSTANCE])) {
        if (!js_is_callable(handler)) {
            char d[96];
            js_describe_value(ctx, handler, d, sizeof d);
            return js_throw_type_error(ctx, "%s%s is not a function", js_is_number(handler) ? "number " : "", d);
        }
        JSValue r = js_call(ctx, handler, target, 1, &v);
        return js_is_exception(r) ? r : js_bool(js_truthy(r));
    }
    if (!js_is_callable(target)) return js_throw_type_error(ctx, "Right-hand side of 'instanceof' is not callable");
    return js_ordinary_has_instance(ctx, target, v);
}

JSValue js_in(JSContext *ctx, JSValue key, JSValue obj) {
    if (!js_is_object(obj)) {
        char k[64] = "", o[64] = "";
        JSValue ks = js_to_string(ctx, key);
        if (js_is_exception(ks)) return JS_EXCEPTION;
        k[js_view_to_utf8(js_string_view(ctx, ks), k, sizeof k - 1)] = '\0';
        JSValue os = js_is_string(obj) ? obj : js_to_string(ctx, obj);
        if (js_is_exception(os)) return JS_EXCEPTION;
        o[js_view_to_utf8(js_string_view(ctx, os), o, sizeof o - 1)] = '\0';
        return js_throw_type_error(ctx, "Cannot use 'in' operator to search for '%s' in %s", k, o);
    }
    JSValue k = js_to_property_key(ctx, key);
    if (js_is_exception(k)) return JS_EXCEPTION;
    int r = js_has_property(ctx, js_as_object(obj), k);
    return r < 0 ? JS_EXCEPTION : js_bool(r);
}

/* ---- Realm --------------------------------------------------------------------- */

/* %Function.prototype% (§20.2.3) is itself a function: it accepts anything and returns undefined. */
static JSValue function_prototype_call(JSContext *ctx, JSValue callee, JSValue this_val,
                                       uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)ctx, (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    return JS_UNDEFINED;
}

/* %ThrowTypeError% (§10.2.4.1). */
static JSValue throw_type_error_fn(JSContext *ctx, JSValue callee, JSValue this_val,
                                   uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    return js_throw_type_error(ctx, "'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions or the arguments objects for calls to them");
}

void js_function_realm_init(JSContext *ctx) {
    JSShape *shape = js_shape_root(ctx, &js_class_function, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 3);
    JSFunction *f = (JSFunction *)js_alloc_object(ctx, JS_CELL_FUNCTION, shape);
    f->entry = function_prototype_call;
    f->home_object = JS_UNDEFINED;
    f->bound_this = JS_EMPTY;
    f->realm = ctx;
    ctx->intrinsics[JS_INTRINSIC_FUNCTION_PROTOTYPE] = js_object_value(&f->obj);
    js_define_data(ctx, &f->obj, JS_ATOM(length), js_int32(0), JS_PROP_CONFIGURABLE);
    js_define_data(ctx, &f->obj, JS_ATOM(name), js_empty_string(), JS_PROP_CONFIGURABLE);

    /* %ThrowTypeError%: length and name fixed, not extensible */
    JSValue thrower = js_new_native(ctx, throw_type_error_fn, js_empty_string(), 0, JS_FN_STRICT);
    JSPropertyDescriptor fixed = { JS_DESC_CONFIGURABLE, 0, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    int r = js_define_own_property(ctx, js_as_object(thrower), JS_ATOM(length), &fixed, false);
    r = js_define_own_property(ctx, js_as_object(thrower), JS_ATOM(name), &fixed, false);
    r = js_prevent_extensions(ctx, js_as_object(thrower));
    (void)r;
    ctx->intrinsics[JS_INTRINSIC_THROW_TYPE_ERROR] = thrower;
}
