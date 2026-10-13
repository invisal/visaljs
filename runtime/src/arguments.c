/* Arguments objects (ECMAScript §10.4.4).
 *
 * Unmapped (strict code, or a non-simple parameter list): an ordinary object of
 * the Arguments class holding the argument values, `length`, and a `callee` that
 * throws. Mapped (sloppy, simple parameters): indices below the parameter count
 * alias the parameters, which then live in the function's environment; the class
 * hooks read and write those slots until the index is redefined or deleted. */
#include "js_function.h"

#include "internal.h"
#include "js_atoms.h"
#include "js_symbol.h"
#include "jscontext.h"

typedef struct JSArgumentsObject {
    JSObject        obj;
    JSEnv          *env;       /* the parameters' environment (mapped), or NULL */
    const uint32_t *slots;     /* env slot of each mapped index (generated, static) */
    uint64_t        mapped;    /* bit i: index i still aliases its parameter */
} JSArgumentsObject;

static JSArgumentsObject *as_args(JSObject *o) { return (JSArgumentsObject *)o; }

/* The mapped index a key names, or -1. */
static int mapped_index(JSObject *o, JSValue key) {
    if (!js_key_is_index(key)) return -1;
    uint32_t i = js_key_index(key);
    return i < 64 && (as_args(o)->mapped & ((uint64_t)1 << i)) ? (int)i : -1;
}

static JSValue *mapped_slot(JSObject *o, int i) {
    JSArgumentsObject *a = as_args(o);
    return &a->env->vars[a->slots[i]];
}

/* [[GetOwnProperty]] (§10.4.4.1): the ordinary property, with a mapped index's value from the parameter. */
static int args_get_own(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out) {
    int i = mapped_index(o, key);
    if (i < 0) return JS_ORDINARY;
    int r = js_ordinary_get_own_property(ctx, o, key, out);
    if (r == 1) out->value = *mapped_slot(o, i);
    return r;
}

/* [[DefineOwnProperty]] (§10.4.4.2): a value goes to the parameter too; an accessor or
 * writable: false ends the aliasing. */
static int args_define(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    int i = mapped_index(o, key);
    if (i < 0) return JS_ORDINARY;
    JSPropertyDescriptor d = *desc;
    /* making a mapped index read-only without a value first fixes the current value (step 3) */
    if (!(d.has & (JS_DESC_VALUE | JS_DESC_GET | JS_DESC_SET)) && (d.has & JS_DESC_WRITABLE) && !(d.attrs & JS_PROP_WRITABLE)) {
        d.has |= JS_DESC_VALUE;
        d.value = *mapped_slot(o, i);
    }
    int r = js_ordinary_define_own_property(ctx, o, key, &d, throw_on_fail);
    if (r != 1) return r;
    if (d.has & (JS_DESC_GET | JS_DESC_SET)) {
        as_args(o)->mapped &= ~((uint64_t)1 << i);
    } else {
        if (d.has & JS_DESC_VALUE) js_store(ctx, &as_args(o)->env->cell, mapped_slot(o, i), d.value);
        if ((d.has & JS_DESC_WRITABLE) && !(d.attrs & JS_PROP_WRITABLE)) as_args(o)->mapped &= ~((uint64_t)1 << i);
    }
    return 1;
}

/* [[Delete]] (§10.4.4.5): deleting ends the aliasing. */
static int args_delete(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail) {
    int i = mapped_index(o, key);
    if (i < 0) return JS_ORDINARY;
    int r = js_ordinary_delete(ctx, o, key, throw_on_fail);
    if (r == 1) as_args(o)->mapped &= ~((uint64_t)1 << i);
    return r;
}

static void args_visit(JSCell *c, JSTracer *trc) {
    JSArgumentsObject *a = (JSArgumentsObject *)c;
    if (a->env) js_trace_cell(trc, &a->env->cell);
}

const JSClass js_class_arguments = {
    "Arguments", sizeof(JSArgumentsObject), args_get_own, args_define, args_delete, NULL, args_visit, NULL, NULL,
};

JSValue js_new_arguments(JSContext *ctx, JSValue args, JSValue callee, JSValue env, const uint32_t *slots, uint32_t nmapped) {
    JSObject *list = js_as_object(args);
    uint32_t argc = js_array_length(list);
    JSShape *shape = js_shape_root(ctx, &js_class_arguments, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 3);
    JSArgumentsObject *a = (JSArgumentsObject *)js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    JSObject *o = &a->obj;
    for (uint32_t i = 0; i < argc; i++)
        js_define_data(ctx, o, js_index_key(i), js_get_value(ctx, args, js_index_key(i)), JS_PROP_DEFAULT);
    js_define_data(ctx, o, JS_ATOM(length), js_number((double)argc), JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, o, JS_SYMBOL(iterator), ctx->intrinsics[JS_INTRINSIC_ARRAY_VALUES], JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    if (slots) {
        /* mapped: only the parameters actually passed alias (§10.4.4.7 step 15), and at most 64 */
        js_store_ptr(ctx, &a->obj.cell, &a->env, js_as_env(env));
        a->slots = slots;
        for (uint32_t i = 0; i < nmapped && i < argc && i < 64; i++)
            if (slots[i] != UINT32_MAX) a->mapped |= (uint64_t)1 << i;  /* duplicate names: only the last maps */
        js_define_data(ctx, o, JS_ATOM(callee), callee, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    } else {
        /* unmapped: callee throws (§10.4.4.6 step 8) */
        JSValue thrower = ctx->intrinsics[JS_INTRINSIC_THROW_TYPE_ERROR];
        JSPropertyDescriptor d = { JS_DESC_GET | JS_DESC_SET | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE, 0,
                                   JS_UNDEFINED, thrower, thrower };
        int r = js_define_own_property(ctx, o, JS_ATOM(callee), &d, false);
        (void)r;
    }
    return js_object_value(o);
}

bool js_is_arguments(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &js_class_arguments;
}
