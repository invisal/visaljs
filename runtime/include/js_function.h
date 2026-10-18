/*
 * js_function.h — function objects and calls.
 *
 * A function is an object (a JSFunction cell). Every function has a generic
 * entry with one signature; compiled functions also have a direct entry the
 * compiler calls when it knows the callee.
 */
#ifndef JS_FUNCTION_H
#define JS_FUNCTION_H

#include "js_object.h"

/* The generic entry: `this_val` is raw (coercion happens in the
 * callee); `new_target` is undefined for [[Call]], the constructor for [[Construct]]. */
typedef JSValue (*JSNativeFn)(JSContext *ctx, JSValue callee, JSValue this_val,
                              uint32_t argc, const JSValue *argv, JSValue new_target);

/* JSFunction.flags */
#define JS_FN_STRICT       0x01u
#define JS_FN_CONSTRUCTOR  0x02u  /* has [[Construct]] */
#define JS_FN_ORDINARY     0x04u  /* compiled ordinary function: [[Construct]] creates `this` (OrdinaryCreateFromConstructor) */
#define JS_FN_ARROW        0x08u
#define JS_FN_CLASS_CTOR   0x10u  /* throws when called without new */
#define JS_FN_DERIVED      0x20u  /* a derived class constructor: [[Construct]] doesn't create `this` (super() does) */
#define JS_FN_BOUND        0x40u  /* a bound function (Function.prototype.bind): home_object is the target */
#define JS_FN_GENERATOR    0x80u  /* function*: its [[Prototype]] and `prototype` differ */
#define JS_FN_ASYNC        0x100u /* async function: [[Prototype]] %AsyncFunction.prototype% */
#define JS_FN_PROXY        0x200u /* a callable proxy: it runs in its caller's realm */

/* Emitted by the compiler as static const data, one per function in the source. */
typedef struct JSFunctionInfo {
    JSNativeFn      generic;
    const JSString *name;         /* a static string cell */
    uint32_t        length;       /* params before the first default or rest */
    uint32_t        flags;        /* JS_FN_* */
    const JSString *source_text;  /* the module's whole source (static); NULL for builtins */
    const char     *file;
    uint32_t        source_start; /* Function.prototype.toString: this function's slice of it */
    uint32_t        source_length;
} JSFunctionInfo;

/* A scope's captured variables: one cell per scope that has
 * any, linked to the enclosing scope's. Generated code reaches a variable by a static
 * (depth, slot). Slots start EMPTY (zeroed memory): uninitialized let/const. */
typedef struct JSEnv {            /* kind = ENV */
    JSCell         cell;          /* aux = number of slots */
    struct JSEnv  *parent;        /* NULL at the outermost */
    JSValue        vars[];
} JSEnv;

/* The environment in a JSValue: generated code keeps it in an ordinary C local. */
static inline JSEnv *js_as_env(JSValue v) { return js_is_cell(v) ? (JSEnv *)js_as_cell(v) : NULL; }

/* A new environment of `count` slots (EMPTY) whose parent is `parent` (an environment or undefined). */
JSValue js_new_env(JSContext *ctx, JSValue parent, uint32_t count);
/* A copy with the same parent and values: `for (let …)` gives each iteration its own (§14.7.4.4). */
JSValue js_env_copy(JSContext *ctx, JSValue env);

static inline JSEnv *js_env_up(JSValue env, uint32_t depth) {
    JSEnv *e = js_as_env(env);
    while (depth--) e = e->parent;
    return e;
}
static inline JSValue js_env_get(JSValue env, uint32_t depth, uint32_t slot) {
    return js_env_up(env, depth)->vars[slot];
}
static inline void js_env_set(JSContext *ctx, JSValue env, uint32_t depth, uint32_t slot, JSValue v) {
    JSEnv *e = js_env_up(env, depth);
    js_store(ctx, &e->cell, &e->vars[slot], v);
}

typedef struct JSFunction {       /* kind = FUNCTION */
    JSObject               obj;
    JSNativeFn             entry;        /* copy of info->generic: one load at call time */
    const JSFunctionInfo  *info;         /* NULL for builtins created at runtime */
    struct JSEnv          *env;          /* captured scope, or NULL */
    JSValue                home_object;  /* methods: where `super` looks */
    JSValue                bound_this;   /* arrows: the captured `this`, else EMPTY */
    JSContext             *realm;        /* the realm the function was created in */
    uint32_t               flags;
    uint32_t               pad_;
    struct JSShape        *instance_shape;  /* the root shape of the objects `new` makes with it as new.target: inline slots for all their constructors add */
} JSFunction;

extern const JSClass js_class_function;

static inline bool js_is_function(JSValue v) {
    return js_is_cell(v) && js_as_cell(v)->kind == JS_CELL_FUNCTION;
}
static inline JSFunction *js_as_function(JSValue v) { return (JSFunction *)js_as_cell(v); }

/* IsCallable / IsConstructor (Proxy and bound functions arrive later). */
static inline bool js_is_callable(JSValue v) { return js_is_function(v); }
static inline bool js_is_constructor(JSValue v) {
    return js_is_function(v) && (js_as_function(v)->flags & JS_FN_CONSTRUCTOR);
}

/* A function object for compiled code: name and length from `info`. */
JSValue js_new_function(JSContext *ctx, const JSFunctionInfo *info);
/* The same, closing over `env` (an environment, or undefined for none). */
JSValue js_new_closure(JSContext *ctx, const JSFunctionInfo *info, JSValue env);
/* The environment a closure captured, as a JSValue (undefined if none): for generic entries. */
static inline JSValue js_function_env(JSValue f) {
    JSEnv *e = js_as_function(f)->env;
    return e ? js_cell(&e->cell) : JS_UNDEFINED;
}
/* A builtin: `name` is a string, `flags` JS_FN_*. Constructors get no automatic
 * `prototype`: builtins define theirs. */
JSValue js_new_native(JSContext *ctx, JSNativeFn fn, JSValue name, uint32_t length, uint32_t flags);
/* Defines a builtin method `name` on `o` (writable, configurable, not enumerable). */
JSValue js_define_method(JSContext *ctx, JSObject *o, const char *name, JSNativeFn fn, uint32_t length);

/* [[Call]] and [[Construct]]. `callee_text` names the callee in "x is not a function"
 * (the source text at a call site; NULL for runtime callers). */
JS_WARN_UNUSED JSValue js_call(JSContext *ctx, JSValue f, JSValue this_val, uint32_t argc, const JSValue *argv);
JS_WARN_UNUSED JSValue js_call_site(JSContext *ctx, JSValue f, JSValue this_val, uint32_t argc, const JSValue *argv, const char *callee_text);

/* Math.f(x) in generated code: when the callee is the built-in (its entry, from
 * any realm) and x a Number, the C function inline; anything else is the call. The entries are
 * math.c's (a program naming Math links it). */
enum { JS_MATH_SQRT, JS_MATH_ABS, JS_MATH_FLOOR, JS_MATH_CEIL, JS_MATH_TRUNC, JS_MATH_INLINE_COUNT };
extern const JSNativeFn js_math_inline[JS_MATH_INLINE_COUNT];
#define JS_MATH_CALL(name, index, cfn)                                                                       \
    static inline JSValue js_call_math_##name(JSContext *ctx, JSValue f, JSValue this_val, JSValue x, const char *site) { \
        if (JS_LIKELY(js_is_number(x) && js_is_function(f) && js_as_function(f)->entry == js_math_inline[index])) \
            return js_number(cfn(js_as_number(x)));                                                          \
        return js_call_site(ctx, f, this_val, 1, &x, site);                                                  \
    }
JS_MATH_CALL(sqrt, JS_MATH_SQRT, sqrt)
JS_MATH_CALL(abs, JS_MATH_ABS, fabs)
JS_MATH_CALL(floor, JS_MATH_FLOOR, floor)
JS_MATH_CALL(ceil, JS_MATH_CEIL, ceil)
JS_MATH_CALL(trunc, JS_MATH_TRUNC, trunc)
#undef JS_MATH_CALL
JS_WARN_UNUSED JSValue js_construct(JSContext *ctx, JSValue f, uint32_t argc, const JSValue *argv, JSValue new_target, const char *callee_text);
/* The same with the arguments in an array (a call with spreads). */
JS_WARN_UNUSED JSValue js_call_spread(JSContext *ctx, JSValue f, JSValue this_val, JSValue args, const char *callee_text);
JS_WARN_UNUSED JSValue js_construct_spread(JSContext *ctx, JSValue f, JSValue args, const char *callee_text);

/* GetPrototypeFromConstructor: new_target.prototype, or the intrinsic `fallback`
 * of new_target's realm if that isn't an object. */
/* GetFunctionRealm: f's realm (a proxy's target's), ctx for non-functions; NULL with a TypeError for a revoked proxy. */
JSContext *js_function_realm(JSContext *ctx, JSValue f);
JS_WARN_UNUSED JSValue js_get_prototype_from_constructor(JSContext *ctx, JSValue new_target, JSIntrinsic fallback);
/* `new F(…)` where F is a constructor the program compiled (optimizer step 10): `this`, an
 * ordinary object with F's `prototype` (read by the site's cache `ic`: an own data property that
 * can't become an accessor, so no user code runs) and `slots` inline slots. The instances' root
 * shape is cached on F, and used while F's `prototype` is the same object. */
JS_WARN_UNUSED JSValue js_new_instance(JSContext *ctx, JSValue f, uint16_t slots, JSPropCache *ic);
/* OrdinaryCreateFromConstructor: an ordinary object with that prototype. */
JS_WARN_UNUSED JSValue js_create_from_constructor(JSContext *ctx, JSValue new_target, JSIntrinsic fallback);

/* An arguments object (§10.4.4) from the array of actual arguments. `slots` (static,
 * from the compiler) maps index i < nmapped to its parameter's slot in `env`, UINT32_MAX
 * for none: a mapped (sloppy) object. NULL: unmapped, with a throwing `callee`. */
extern const JSClass js_class_arguments;
JSValue js_new_arguments(JSContext *ctx, JSValue args, JSValue callee, JSValue env, const uint32_t *slots, uint32_t nmapped);
bool js_is_arguments(JSValue v);

/* ---- Classes (§15.7) and super ----------------------------------------------------- */

/* ClassDefinitionEvaluation steps 5–16: checks the heritage (EMPTY: none), makes the
 * prototype (inheriting from heritage.prototype), links ctor to the parent class, sets
 * ctor.prototype and prototype.constructor. Returns the prototype. */
JS_WARN_UNUSED JSValue js_class_setup(JSContext *ctx, JSValue ctor, JSValue heritage);
/* A method's [[HomeObject]]: where `super` looks. */
void js_set_home_object(JSContext *ctx, JSValue fn, JSValue home);
/* A class method (0), getter (1) or setter (2): not enumerable. */
void js_define_class_member(JSContext *ctx, JSObject *target, JSValue key, int kind, JSValue fn);
/* super[key] and super[key] = v, from the function whose home object's prototype holds them. */
JS_WARN_UNUSED JSValue js_super_get(JSContext *ctx, JSValue callee, JSValue key, JSValue this_val);
JS_WARN_UNUSED int js_super_set(JSContext *ctx, JSValue callee, JSValue key, JSValue v, JSValue this_val);
/* super(...args): constructs the constructor's own [[Prototype]] (the parent class). */
JS_WARN_UNUSED JSValue js_super_construct(JSContext *ctx, JSValue callee, JSValue new_target, uint32_t argc, const JSValue *argv);
JS_WARN_UNUSED JSValue js_super_construct_spread(JSContext *ctx, JSValue callee, JSValue new_target, JSValue args);
/* Binding `this` after super(): a ReferenceError if it already was. */
JS_WARN_UNUSED JSValue js_bind_this(JSContext *ctx, JSValue current, JSValue v);
/* A derived constructor's `this`: a ReferenceError before super(). */
JS_WARN_UNUSED JSValue js_check_this(JSContext *ctx, JSValue this_val);
/* What `return v` in a derived constructor produces: v if an object, else this (if bound). */
JS_WARN_UNUSED JSValue js_derived_return(JSContext *ctx, JSValue v, JSValue this_val);

/* Function.prototype.bind's result (§10.4.1). */
JS_WARN_UNUSED JSValue js_bind_function(JSContext *ctx, JSValue target, JSValue bound_this, uint32_t argc, const JSValue *argv);

/* instanceof (InstanceofOperator: @@hasInstance, else OrdinaryHasInstance) and `in`. */
JS_WARN_UNUSED JSValue js_instanceof(JSContext *ctx, JSValue v, JSValue target);
JS_WARN_UNUSED JSValue js_ordinary_has_instance(JSContext *ctx, JSValue target, JSValue v);
JS_WARN_UNUSED JSValue js_in(JSContext *ctx, JSValue key, JSValue obj);

#endif /* JS_FUNCTION_H */
