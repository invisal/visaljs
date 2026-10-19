/*
 * js_builtins.h — built-ins as tables, grouped in components.
 *
 * A built-in object is a constant table of entries; js_define_builtins defines them with the
 * attributes the spec gives built-ins. Optional built-ins come in components that a program
 * installs only when it can reach them (the compiler decides, from the names in the program).
 */
#ifndef JS_BUILTINS_H
#define JS_BUILTINS_H

#include "js_function.h"
#include "js_symbol.h"

typedef enum JSBuiltinKind {
    JS_BUILTIN_KIND_FN,        /* a native function */
    JS_BUILTIN_KIND_ACCESSOR,  /* getter (and setter, if any) */
    JS_BUILTIN_KIND_NUMBER,    /* a number value */
    JS_BUILTIN_KIND_STRING,    /* a string value */
    JS_BUILTIN_KIND_ALIAS,     /* the same value as an earlier entry (`alias` names it) */
} JSBuiltinKind;

typedef struct JSBuiltin {
    const char     *name;      /* the key, or NULL when `symbol` is */
    const JSSymbol *symbol;    /* a well-known symbol key */
    uint8_t         kind;      /* JSBuiltinKind */
    uint8_t         attrs;     /* JS_PROP_* (data properties; accessors use only CONFIGURABLE/ENUMERABLE) */
    uint16_t        length;    /* a function's `length` */
    JSNativeFn      fn;        /* the function, or the getter */
    JSNativeFn      setter;
    double          number;
    const char     *string;    /* a string value; for ALIAS, the earlier entry's name */
} JSBuiltin;

#define JS_BUILTIN_METHOD_ATTRS (JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE)

/* Methods and accessors: writable/configurable, not enumerable (§18). */
#define JS_BUILTIN_FN(name, fn, length) \
    { (name), NULL, JS_BUILTIN_KIND_FN, JS_BUILTIN_METHOD_ATTRS, (length), (fn), NULL, 0, NULL }
#define JS_BUILTIN_GETTER(name, get) \
    { (name), NULL, JS_BUILTIN_KIND_ACCESSOR, JS_PROP_CONFIGURABLE, 0, (get), NULL, 0, NULL }
#define JS_BUILTIN_ACCESSOR(name, get, set) \
    { (name), NULL, JS_BUILTIN_KIND_ACCESSOR, JS_PROP_CONFIGURABLE, 0, (get), (set), 0, NULL }
/* Values: attributes given (constants like Math.PI are 0: read-only, fixed). */
#define JS_BUILTIN_NUMBER(name, value, attrs) \
    { (name), NULL, JS_BUILTIN_KIND_NUMBER, (attrs), 0, NULL, NULL, (value), NULL }
#define JS_BUILTIN_STRING(name, value, attrs) \
    { (name), NULL, JS_BUILTIN_KIND_STRING, (attrs), 0, NULL, NULL, 0, (value) }
/* Well-known symbol keys: a function named "[Symbol.id]", a string, or an earlier entry's value. */
#define JS_BUILTIN_SYMBOL_FN(id, fn, length) \
    { NULL, &js_symbol_##id, JS_BUILTIN_KIND_FN, JS_BUILTIN_METHOD_ATTRS, (length), (fn), NULL, 0, NULL }
#define JS_BUILTIN_SYMBOL_STRING(id, value, attrs) \
    { NULL, &js_symbol_##id, JS_BUILTIN_KIND_STRING, (attrs), 0, NULL, NULL, 0, (value) }
#define JS_BUILTIN_SYMBOL_ALIAS(id, earlier) \
    { NULL, &js_symbol_##id, JS_BUILTIN_KIND_ALIAS, JS_BUILTIN_METHOD_ATTRS, 0, NULL, NULL, 0, (earlier) }
#define JS_BUILTIN_SYMBOL_GETTER(id, get) \
    { NULL, &js_symbol_##id, JS_BUILTIN_KIND_ACCESSOR, JS_PROP_CONFIGURABLE, 0, (get), NULL, 0, NULL }
/* A string key holding an earlier entry's value (Set.prototype.keys is `values`). */
#define JS_BUILTIN_ALIAS(name, earlier) \
    { (name), NULL, JS_BUILTIN_KIND_ALIAS, JS_BUILTIN_METHOD_ATTRS, 0, NULL, NULL, 0, (earlier) }

#define JS_COUNTOF(a) (sizeof(a) / sizeof((a)[0]))

/* Defines every entry on `o`, in order. Realm setup: no user code runs. */
void js_define_builtins(JSContext *ctx, JSObject *o, const JSBuiltin *entries, size_t n);
/* A new object with Object.prototype and the entries (Math, JSON, Reflect). */
JSValue js_new_builtin_object(JSContext *ctx, const JSBuiltin *entries, size_t n);

/* An optional component: its install function creates its built-ins in a realm. */
typedef struct JSComponent {
    const char *name;
    void      (*install)(JSContext *ctx, JSObject *global);
} JSComponent;

/* Installs the components in `ctx`, and records them so that every realm created later
 * (`$262.createRealm`) gets them too. Called once, by the generated main. */
void js_install_components(JSContext *ctx, const JSComponent *const *list, size_t n);
/* A new realm's share: the recorded components (js_context_new calls it). */
void js_install_recorded_components(JSContext *ctx);

/* ---- Core methods (js_core.def) ---------------------------------------------------------------
 * The core constructors always exist; the methods of the large core objects (and the global
 * functions on numbers) are installed only
 * when the program names them. The generated main passes the entries it names to js_use_core
 * before creating the first realm; every realm then installs those, in the catalog's order. */
typedef enum JSCoreTarget {
    JS_CORE_OBJECT, JS_CORE_OBJECT_PROTO, JS_CORE_ARRAY, JS_CORE_ARRAY_PROTO, JS_CORE_STRING, JS_CORE_STRING_PROTO,
    JS_CORE_NUMBER, JS_CORE_NUMBER_PROTO, JS_CORE_GLOBAL,
    JS_CORE_CONSOLE,  /* the host's console: installed by js_new_console, not by realm setup */
    JS_CORE_TARGET_COUNT
} JSCoreTarget;

typedef struct JSCoreEntry {
    uint8_t   target;      /* JSCoreTarget */
    uint8_t   from;        /* an alias: the object its earlier entry is on */
    JSBuiltin entry;
} JSCoreEntry;

#define JS_CORE_ENTRY_FN(target, name, fn, length) \
    { JS_CORE_##target, JS_CORE_##target, JS_BUILTIN_FN(name, js_core_##fn, length) }
/* A host method: enumerable too, as WebIDL namespace operations are (console.log). */
#define JS_CORE_ENTRY_HOST_FN(target, name, fn, length) \
    { JS_CORE_##target, JS_CORE_##target, { (name), NULL, JS_BUILTIN_KIND_FN, JS_PROP_DEFAULT, (length), js_core_##fn, NULL, 0, NULL } }
#define JS_CORE_ENTRY_ACCESSOR(target, name, get, set) \
    { JS_CORE_##target, JS_CORE_##target, JS_BUILTIN_ACCESSOR(name, js_core_##get, js_core_##set) }
#define JS_CORE_ENTRY_NUMBER(target, name, value) \
    { JS_CORE_##target, JS_CORE_##target, JS_BUILTIN_NUMBER(name, value, 0) }
#define JS_CORE_ENTRY_ALIAS(target, name, earlier) JS_CORE_ENTRY_ALIAS_OF(target, name, target, earlier)
#define JS_CORE_ENTRY_ALIAS_OF(target, name, from, earlier) \
    { JS_CORE_##target, JS_CORE_##from, { (name), NULL, JS_BUILTIN_KIND_ALIAS, JS_BUILTIN_METHOD_ATTRS, 0, NULL, NULL, 0, (earlier) } }
#define JS_CORE_ENTRY_SYMBOL_GETTER(target, id, get) \
    { JS_CORE_##target, JS_CORE_##target, { NULL, &js_symbol_##id, JS_BUILTIN_KIND_ACCESSOR, JS_PROP_CONFIGURABLE, 0, js_core_##get, NULL, 0, NULL } }
#define JS_CORE_ENTRY_SYMBOL_ALIAS(target, id, earlier) \
    { JS_CORE_##target, JS_CORE_##target, JS_BUILTIN_SYMBOL_ALIAS(id, earlier) }

/* The natives the catalog names. */
#define JS_CORE_DECLARE(fn) \
    JSValue js_core_##fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);
#define JS_CORE_FN(target, name, fn, length) JS_CORE_DECLARE(fn)
#define JS_CORE_HOST_FN(target, name, fn, length) JS_CORE_DECLARE(fn)
#define JS_CORE_ACCESSOR(target, name, get, set) JS_CORE_DECLARE(get) JS_CORE_DECLARE(set)
#define JS_CORE_NUMBER(target, name, value)
#define JS_CORE_ALIAS(target, name, earlier)
#define JS_CORE_ALIAS_OF(target, name, from, earlier)
#define JS_CORE_SYMBOL_GETTER(target, id, get) JS_CORE_DECLARE(get)
#define JS_CORE_SYMBOL_ALIAS(target, id, earlier)
#include "js_core.def"
#undef JS_CORE_FN
#undef JS_CORE_HOST_FN
#undef JS_CORE_ACCESSOR
#undef JS_CORE_NUMBER
#undef JS_CORE_ALIAS
#undef JS_CORE_ALIAS_OF
#undef JS_CORE_SYMBOL_GETTER
#undef JS_CORE_SYMBOL_ALIAS

/* The core entries every realm of this runtime installs (call before js_context_new). */
void js_use_core(JSRuntime *rt, const JSCoreEntry *entries, size_t n);
/* All of them (runtime/src/core_all.c): the test hosts, and programs built with --all-builtins. */
void js_use_all_core(JSRuntime *rt);
/* Realm setup: defines the recorded entries on their objects. */
void js_install_core(JSContext *ctx, const JSValue targets[JS_CORE_TARGET_COUNT]);
/* The recorded entries of one host object, which the host creates after realm setup (console). */
void js_install_core_on(JSContext *ctx, JSCoreTarget target, JSObject *o);

/* The components (runtime/src/components.c lists them for the test host, which installs all). */
/* the language's own, which a program reaches by syntax too: async functions and await reach
 * promise, function* generator, async function* and for await asynciterator */
extern const JSComponent js_component_promise;
extern const JSComponent js_component_generator;
extern const JSComponent js_component_asynciterator;
extern const JSComponent js_component_weak;
extern const JSComponent js_component_math;
extern const JSComponent js_component_json;
extern const JSComponent js_component_collections;
extern const JSComponent js_component_reflect;
extern const JSComponent js_component_proxy;
extern const JSComponent js_component_arraybuffer;
extern const JSComponent js_component_typedarray;
extern const JSComponent js_component_date;
extern const JSComponent js_component_regexp;
extern const JSComponent js_component_bigint;
/* the web-standard host layer */
extern const JSComponent js_component_domexception;
extern const JSComponent js_component_encoding;
extern const JSComponent js_component_base64;
extern const JSComponent js_component_url;
extern const JSComponent js_component_events;
extern const JSComponent js_component_buffer;
extern const JSComponent js_component_crypto;
extern const JSComponent js_component_headers;
extern const JSComponent js_component_streams;
extern const JSComponent js_component_blob;
extern const JSComponent js_component_fetch;

/* JSON.stringify(value, replacer, space), for util.format's %j too (json.c, in every program):
 * a string, undefined, or JS_EXCEPTION. With `circular`, it says whether the exception is
 * the cycle TypeError (tryStringify prints "[Circular]"). */
JSValue js_json_stringify(JSContext *ctx, JSValue value, JSValue replacer, JSValue space, bool *circular);
extern const JSComponent *const js_all_components[];
extern const size_t js_all_components_count;
/* Records them all for the realms js_context_new creates next (the runtime's unit tests). */
void js_use_all_components(JSRuntime *rt);

/* ---- Generated code's inline built-in calls --------------------------------------------- */

/* A string's units without allocating: flat, a flattened rope, or a slice; else false. */
static inline bool js_string_units(JSValue s, JSStrView *out) {
    JSCell *c = js_as_cell(s);
    if (c->kind == JS_CELL_STR_ROPE) {
        JSRope *r = (JSRope *)c;
        if (!js_is_empty(r->right)) return false;  /* not flattened yet */
        c = js_as_cell(r->left);
    }
    const JSSlice *slice = c->kind == JS_CELL_STR_SLICE ? (const JSSlice *)c : NULL;
    if (slice) c = js_as_cell(slice->parent);
    if (c->kind != JS_CELL_STR_FLAT) return false;
    JSString *f = (JSString *)c;
    uint32_t offset = slice ? slice->offset : 0, length = slice ? slice->length : f->length;
    bool latin1 = (f->cell.flags & JS_STR_LATIN1) != 0;
    *out = (JSStrView){ latin1 ? (const void *)(f->chars.latin1 + offset) : (const void *)(f->chars.utf16 + offset), length, latin1 };
    return true;
}

/* s.charCodeAt(i): the unit inline when the callee is the built-in, s a string whose units are
 * at hand and i an index in it; anything else is the call. */
static inline JSValue js_call_char_code_at(JSContext *ctx, JSValue f, JSValue s, JSValue i, const char *site) {
    JSStrView v;
    if (JS_LIKELY(js_is_function(f) && js_as_function(f)->entry == js_core_string_proto_char_code_at && js_is_string(s)
                  && js_is_int32(i) && js_string_units(s, &v) && (uint32_t)js_as_int32(i) < v.length))
        return js_int32((int32_t)js_view_at(v, (uint32_t)js_as_int32(i)));
    return js_call_site(ctx, f, s, 1, &i, site);
}

/* s.charCodeAt(i) in typed code ("use static"), which trusts the built-ins to be the standard
 * ones (char_code_at): s is a string; its unit read inline, else (a rope, an index out of
 * range) the built-in's answer. */
static inline double js_string_char_code_at(JSContext *ctx, JSValue s, double i) {
    JSStrView v;
    if (JS_LIKELY(i >= 0 && i < 4294967295.0 && js_string_units(s, &v) && (uint32_t)i < v.length && (double)(uint32_t)i == i))
        return (double)js_view_at(v, (uint32_t)i);
    JSValue index = js_number(i);
    return js_as_number(js_core_string_proto_char_code_at(ctx, JS_UNDEFINED, s, 1, &index, JS_UNDEFINED));
}

/* s.charCodeAt(i) in typed code for an index the optimizer proved in s: the unit, an int32 (a
 * rope not yet flattened takes the built-in). */
static inline int32_t js_string_unit_at(JSContext *ctx, JSValue s, uint32_t i) {
    JSStrView v;
    if (JS_LIKELY(js_string_units(s, &v))) return (int32_t)js_view_at(v, i);
    return (int32_t)js_string_char_code_at(ctx, s, (double)i);
}

/* Function.prototype.apply and call: generated code tells them by their entry. */
JSValue js_function_proto_apply(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);
JSValue js_function_proto_call(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);

/* f.apply(t, args), `m` the value of f.apply: when m is the built-in and f callable, f is called
 * without the built-in in between, with a short dense array's elements copied to the stack (its
 * elements are its own data properties: reading them runs no code; copied, as f may change the
 * array). Anything else is the call of m. */
static inline JSValue js_call_apply(JSContext *ctx, JSValue m, JSValue f, JSValue t, JSValue args, const char *site) {
    if (JS_LIKELY(js_is_function(m) && js_as_function(m)->entry == js_function_proto_apply && js_is_callable(f))) {
        if (js_is_nullish(args)) return js_call(ctx, f, t, 0, NULL);
        if (js_is_array(args)) {
            JSObject *a = js_as_object(args);
            JSElements *e = a->elements;
            uint32_t n = js_array_length(a);
            JSValue copy[8];
            if (e->kind == JS_ELEMENTS_DENSE && e->length == n && n <= 8) {
                uint32_t i = 0;
                while (i < n && !js_is_empty(e->data[i])) copy[i] = e->data[i], i++;
                if (i == n) return js_call(ctx, f, t, n, copy);
            }
        }
    }
    return js_call_site(ctx, m, f, 2, (const JSValue[]){ t, args }, site);
}

/* f.call(t, …), `m` the value of f.call: f called directly when m is the built-in and f callable.
 * argv: t, then the arguments. */
static inline JSValue js_call_call(JSContext *ctx, JSValue m, JSValue f, uint32_t argc, const JSValue *argv, const char *site) {
    if (JS_LIKELY(js_is_function(m) && js_as_function(m)->entry == js_function_proto_call && js_is_callable(f)))
        return js_call(ctx, f, argc ? argv[0] : JS_UNDEFINED, argc ? argc - 1 : 0, argc ? argv + 1 : NULL);
    return js_call_site(ctx, m, f, argc, argv, site);
}

/* String.fromCharCode(c): a unit up to 0xFF is a static one-unit string. */
/* Static code's String.fromCharCode(c), trusted to be the built-in: c's unit (ToUint16). */
static inline JSValue js_from_char_code_unit(JSContext *ctx, uint16_t unit) {
    return unit <= 0xFF ? js_char_string((uint8_t)unit) : js_new_string_utf16(ctx, &unit, 1);
}

static inline JSValue js_call_from_char_code(JSContext *ctx, JSValue f, JSValue this_val, JSValue c, const char *site) {
    if (JS_LIKELY(js_is_function(f) && js_as_function(f)->entry == js_core_string_from_char_code && js_is_int32(c)
                  && (uint32_t)js_as_int32(c) <= 0xFF))
        return js_char_string((uint8_t)js_as_int32(c));
    return js_call_site(ctx, f, this_val, 1, &c, site);
}

#endif /* JS_BUILTINS_H */
