/* Symbols (ECMAScript §6.1.5, §20.4). */
#include "js_symbol.h"

#include "internal.h"
#include "js_convert.h"
#include "js_function.h"
#include "jscontext.h"

/* ---- Cells ------------------------------------------------------------------------ */

#define JS_SYMBOL_DEF(id) \
    const JSSymbol js_symbol_##id = { JS_CELL_HEADER(JS_CELL_SYMBOL, JS_CELL_STATIC), (const JSCell *)&js_atom_Symbol_##id };
JS_WELL_KNOWN_SYMBOLS(JS_SYMBOL_DEF)
#undef JS_SYMBOL_DEF

const JSCellClass js_symbol_cell_class = { "Symbol", NULL, NULL, NULL };  /* gc_visit.h visits it */

JSValue js_new_symbol(JSContext *ctx, JSValue description) {
    JSSymbol *s = (JSSymbol *)js_alloc_cell(ctx, JS_CELL_SYMBOL, sizeof(JSSymbol));
    s->description = js_is_string(description) ? js_as_cell(description) : NULL;
    return js_cell(&s->cell);
}

JSValue js_symbol_descriptive_string(JSContext *ctx, JSValue sym) {
    JSValue d = js_symbol_description(sym);
    JSValue s = js_new_string_cstr(ctx, "Symbol(");
    if (js_is_string(d)) s = js_concat(ctx, s, d);
    if (js_is_exception(s)) return JS_EXCEPTION;
    return js_concat(ctx, s, js_new_string_cstr(ctx, ")"));
}

/* ---- Built-ins (§20.4) ------------------------------------------------------------- */

#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)
#define NATIVE(fn) \
    static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED_ARGS (void)ctx, (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target

/* Symbol([description]): not a constructor, so `new Symbol()` throws before reaching here. */
NATIVE(symbol_ctor) {
    UNUSED_ARGS;
    if (!js_is_undefined(new_target)) return js_throw_type_error(ctx, "Symbol is not a constructor");
    JSValue d = ARG(0);
    if (!js_is_undefined(d)) {
        d = js_to_string(ctx, d);
        if (js_is_exception(d)) return JS_EXCEPTION;
    }
    return js_new_symbol(ctx, d);
}

/* The GlobalSymbolRegistry (§20.4.2.2): agent-wide, so shared by every realm. */
NATIVE(symbol_for) {
    UNUSED_ARGS;
    JSValue key = js_to_string(ctx, ARG(0));
    if (js_is_exception(key)) return JS_EXCEPTION;
    return js_symbol_for(ctx, key);
}

JSValue js_symbol_for(JSContext *ctx, JSValue key) {
    if (js_is_exception(key)) return key;
    JSRuntime *rt = ctx->rt;
    if (!js_is_object(rt->symbol_registry)) rt->symbol_registry = js_new_object_proto(ctx, JS_NULL, JS_DEFAULT_INLINE_SLOTS);
    JSObject *registry = js_as_object(rt->symbol_registry);
    JSValue pkey = js_to_property_key(ctx, key);
    if (js_is_exception(pkey)) return JS_EXCEPTION;
    JSValue found = js_get(ctx, registry, pkey, rt->symbol_registry);
    if (js_is_symbol(found)) return found;
    JSValue sym = js_new_symbol(ctx, key);
    js_as_cell(sym)->flags |= JS_SYM_REGISTERED;
    js_define_data(ctx, registry, pkey, sym, JS_PROP_DEFAULT);
    return sym;
}

static JSValue not_a_symbol(JSContext *ctx, const char *what) {
    return js_throw_type_error(ctx, "%s is not a symbol", what);
}

NATIVE(symbol_key_for) {
    UNUSED_ARGS;
    JSValue sym = ARG(0);
    if (!js_is_symbol(sym)) return not_a_symbol(ctx, "Symbol.keyFor argument");
    return (js_as_cell(sym)->flags & JS_SYM_REGISTERED) ? js_symbol_description(sym) : JS_UNDEFINED;
}

/* thisSymbolValue (§20.4.3): a symbol, or a Symbol wrapper's. */
static JSValue this_symbol(JSContext *ctx, JSValue v, const char *method) {
    JSValue sym = js_this_primitive(v, js_is_symbol);
    if (!js_is_empty(sym)) return sym;
    return js_throw_type_error(ctx, "Symbol.prototype.%s requires that 'this' be a Symbol", method);
}

NATIVE(symbol_proto_to_string) {
    UNUSED_ARGS;
    JSValue sym = this_symbol(ctx, this_val, "toString");
    return js_is_exception(sym) ? sym : js_symbol_descriptive_string(ctx, sym);
}

NATIVE(symbol_proto_value_of) {
    UNUSED_ARGS;
    return this_symbol(ctx, this_val, "valueOf");
}

NATIVE(symbol_proto_to_primitive) {
    UNUSED_ARGS;
    return this_symbol(ctx, this_val, "[Symbol.toPrimitive]");
}

NATIVE(symbol_proto_description) {
    UNUSED_ARGS;
    JSValue sym = this_symbol(ctx, this_val, "description");
    return js_is_exception(sym) ? sym : js_symbol_description(sym);
}

void js_symbol_realm_init(JSContext *ctx, JSObject *global) {
    JSValue proto = ctx->intrinsics[JS_INTRINSIC_SYMBOL_PROTOTYPE];
    JSObject *p = js_as_object(proto);
    JSValue ctor = js_new_native(ctx, symbol_ctor, js_atom_from_cstr(ctx, "Symbol"), 0, JS_FN_STRICT | JS_FN_CONSTRUCTOR);  /* `new` throws */
    JSObject *c = js_as_object(ctor);
    js_define_data(ctx, c, JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, p, JS_ATOM(constructor), ctor, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, global, js_atom_from_cstr(ctx, "Symbol"), ctor, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);

    (void)js_define_method(ctx, c, "for", symbol_for, 1);
    (void)js_define_method(ctx, c, "keyFor", symbol_key_for, 1);
#define WELL_KNOWN(id) js_define_data(ctx, c, js_atom_from_cstr(ctx, #id), JS_SYMBOL(id), 0);
    JS_WELL_KNOWN_SYMBOLS(WELL_KNOWN)
#undef WELL_KNOWN

    (void)js_define_method(ctx, p, "toString", symbol_proto_to_string, 0);
    (void)js_define_method(ctx, p, "valueOf", symbol_proto_value_of, 0);
    JSValue getter = js_new_native(ctx, symbol_proto_description, js_atom_from_cstr(ctx, "get description"), 0, JS_FN_STRICT);
    JSPropertyDescriptor d = { JS_DESC_GET | JS_DESC_SET | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE,
                               JS_PROP_CONFIGURABLE, JS_UNDEFINED, getter, JS_UNDEFINED };
    if (js_define_own_property(ctx, p, JS_ATOM(description), &d, false) != 1) js_fatal("symbol realm init");
    JSValue to_prim = js_new_native(ctx, symbol_proto_to_primitive, js_atom_from_cstr(ctx, "[Symbol.toPrimitive]"), 1, JS_FN_STRICT);
    js_define_data(ctx, p, JS_SYMBOL(toPrimitive), to_prim, JS_PROP_CONFIGURABLE);
    js_define_data(ctx, p, JS_SYMBOL(toStringTag), js_atom_from_cstr(ctx, "Symbol"), JS_PROP_CONFIGURABLE);
}
