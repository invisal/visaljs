/* builtins_util.h — what the built-in files share (runtime-private). */
#ifndef JS_BUILTINS_UTIL_H
#define JS_BUILTINS_UTIL_H

#include "js_builtins.h"
#include "js_object.h"

#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)
#define BUILTIN(fn)                                                                            \
    static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,          \
                      const JSValue *argv, JSValue new_target)
/* A core method from js_core.def: js_builtins.h declares it, the compiler's tables name it. */
#define CORE(fn)                                                                               \
    JSValue js_core_##fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,      \
                         const JSValue *argv, JSValue new_target)
#define UNUSED_ARGS (void)ctx, (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target

#define JS_MAX_SAFE_INTEGER 9007199254740991.0
#define JS_MAX_ARRAY_LENGTH 4294967295.0

/* ToIntegerOrInfinity (§7.1.5). 0, or -1 with an exception. */
int js_to_integer_or_infinity(JSContext *ctx, double *out, JSValue v);
/* The property key for an index below 2^53. */
JSValue js_index_key_of(JSContext *ctx, double d);
/* HasProperty on any value that isn't nullish (a string's characters are its own). */
int js_has_value(JSContext *ctx, JSValue v, JSValue key);
/* RequireObjectCoercible for a method's `this`: false with a TypeError pending. */
bool js_require_this(JSContext *ctx, JSValue v, const char *method);
/* A relative index argument (slice's start): clamped to 0..len; `dflt` when undefined. */
int js_relative_index(JSContext *ctx, JSValue v, double len, double dflt, double *out);
/* CreateDataPropertyOrThrow (§7.3.7). 0, or -1. */
int js_create_data_property(JSContext *ctx, JSValue o, JSValue key, JSValue v);
/* EnumerableOwnProperties(v, key) (§7.3.24) of any value but null/undefined: an array of strings. */
JSValue js_get_own_enumerable_string_keys(JSContext *ctx, JSValue v);
/* How V8 names a value in messages: 1, abc, Symbol(x), #<Object>, [object Array]. */
void js_describe_value(JSContext *ctx, JSValue v, char *buf, size_t cap);
/* ToPropertyDescriptor (§6.2.6.5): 0, or -1. FromPropertyDescriptor (§6.2.6.4). */
int js_to_property_descriptor(JSContext *ctx, JSValue v, JSPropertyDescriptor *d);
JSValue js_from_property_descriptor(JSContext *ctx, const JSPropertyDescriptor *d);
/* CreateListFromArrayLike (§7.3.20), in a GC-visible array; NULL with an exception. */
JSValueArray *js_list_from_array_like(JSContext *ctx, JSValue v);
/* Object.prototype.toString, for Array.prototype.toString's fallback. */
JSValue js_object_to_string_tag(JSContext *ctx, JSValue v);

/* array.c, string_builtins.c: the constructors (after Object and Function), returned for the
 * core methods; then what needs the methods in place (Array.prototype.values, @@unscopables). */
typedef JSValue (*JSDefineConstructor)(JSContext *, JSObject *, const char *, JSNativeFn, uint32_t, JSValue);
JSValue js_array_realm_init(JSContext *ctx, JSObject *global, JSDefineConstructor define_constructor);
void js_array_realm_finish(JSContext *ctx);
JSValue js_string_realm_init(JSContext *ctx, JSObject *global, JSDefineConstructor define_constructor);
JSValue js_number_realm_init(JSContext *ctx, JSObject *global, JSDefineConstructor define_constructor);

#endif /* JS_BUILTINS_UTIL_H */
