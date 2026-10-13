/* Built-ins from tables, and installing components. */
#include "js_builtins.h"

#include <stdio.h>
#include <string.h>

#include "internal.h"
#include "js_atoms.h"
#include "jsstring.h"

static JSValue key_of(JSContext *ctx, const JSBuiltin *e) {
    return e->symbol ? js_cell((JSCell *)e->symbol) : js_atom_from_cstr(ctx, e->name);
}

/* A symbol-keyed function's name: "[Symbol.iterator]" (§10.2.8 SetFunctionName). */
static JSValue symbol_function_name(JSContext *ctx, const JSSymbol *sym) {
    JSValue desc = js_symbol_description(js_cell((JSCell *)sym));
    JSValue open = js_new_string_cstr(ctx, "[");
    JSValue close = js_new_string_cstr(ctx, "]");
    JSValue name = js_is_string(desc) ? js_concat(ctx, open, desc) : open;
    return js_concat(ctx, name, close);
}

void js_define_builtins(JSContext *ctx, JSObject *o, const JSBuiltin *entries, size_t n) {
    for (size_t i = 0; i < n; i++) {
        const JSBuiltin *e = &entries[i];
        JSValue key = key_of(ctx, e);
        switch (e->kind) {
        case JS_BUILTIN_KIND_FN: {
            JSValue name = e->symbol ? symbol_function_name(ctx, e->symbol) : key;
            JSValue f = js_new_native(ctx, e->fn, name, e->length, JS_FN_STRICT);
            js_define_data(ctx, o, key, f, e->attrs);
            break;
        }
        case JS_BUILTIN_KIND_ACCESSOR: {
            JSValue name = e->symbol ? symbol_function_name(ctx, e->symbol) : key;
            JSValue get_name = js_concat(ctx, js_new_string_cstr(ctx, "get "), name);
            JSValue get = js_new_native(ctx, e->fn, get_name, 0, JS_FN_STRICT);
            JSValue set = JS_UNDEFINED;
            if (e->setter) {
                JSValue set_name = js_concat(ctx, js_new_string_cstr(ctx, "set "), name);
                set = js_new_native(ctx, e->setter, set_name, 1, JS_FN_STRICT);
            }
            JSPropertyDescriptor d = { JS_DESC_GET | JS_DESC_SET | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE,
                                       (uint8_t)(e->attrs & (JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE)), JS_UNDEFINED, get, set };
            if (js_define_own_property(ctx, o, key, &d, false) < 0) js_fatal("defining built-in %s", e->name ? e->name : "symbol");
            break;
        }
        case JS_BUILTIN_KIND_NUMBER:
            js_define_data(ctx, o, key, js_number(e->number), e->attrs);
            break;
        case JS_BUILTIN_KIND_STRING:
            js_define_data(ctx, o, key, js_new_string_cstr(ctx, e->string), e->attrs);
            break;
        case JS_BUILTIN_KIND_ALIAS: {
            JSPropertyDescriptor d;
            if (js_get_own_property(ctx, o, js_atom_from_cstr(ctx, e->string), &d) != 1 || !(d.has & JS_DESC_VALUE))
                js_fatal("built-in alias of a missing %s", e->string);
            js_define_data(ctx, o, key, d.value, e->attrs);
            break;
        }
        }
    }
}

JSValue js_new_builtin_object(JSContext *ctx, const JSBuiltin *entries, size_t n) {
    JSValue obj = js_new_object(ctx);
    js_define_builtins(ctx, js_as_object(obj), entries, n);
    return obj;
}

void js_install_components(JSContext *ctx, const JSComponent *const *list, size_t n) {
    ctx->rt->components = list;
    ctx->rt->ncomponents = n;
    js_install_recorded_components(ctx);
}

void js_install_recorded_components(JSContext *ctx) {
    JSObject *global = js_as_object(ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT]);
    for (size_t i = 0; i < ctx->rt->ncomponents; i++) ctx->rt->components[i]->install(ctx, global);
}

void js_use_core(JSRuntime *rt, const JSCoreEntry *entries, size_t n) {
    rt->core = entries;
    rt->ncore = n;
}

void js_install_core(JSContext *ctx, const JSValue targets[JS_CORE_TARGET_COUNT]) {
    for (size_t i = 0; i < ctx->rt->ncore; i++) {
        const JSCoreEntry *e = &ctx->rt->core[i];
        if (e->target == JS_CORE_CONSOLE) continue;  /* js_install_core_on, when the host makes it */
        if (e->from != e->target) {  /* an alias of another object's entry: global parseInt is Number.parseInt */
            JSPropertyDescriptor d;
            if (js_get_own_property(ctx, js_as_object(targets[e->from]), js_atom_from_cstr(ctx, e->entry.string), &d) != 1)
                js_fatal("built-in alias of a missing %s", e->entry.string);
            js_define_data(ctx, js_as_object(targets[e->target]), js_atom_from_cstr(ctx, e->entry.name), d.value, e->entry.attrs);
            continue;
        }
        js_define_builtins(ctx, js_as_object(targets[e->target]), &e->entry, 1);
    }
}

void js_install_core_on(JSContext *ctx, JSCoreTarget target, JSObject *o) {
    for (size_t i = 0; i < ctx->rt->ncore; i++) {
        const JSCoreEntry *e = &ctx->rt->core[i];
        if (e->target == target) js_define_builtins(ctx, o, &e->entry, 1);
    }
}
