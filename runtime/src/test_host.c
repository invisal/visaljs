/* The test262 host's $262. Only test262 units call js_test_host_init, so a
 * program's binary never links this file. */
#include "internal.h"
#include "js_builtins.h"
#include "js_atoms.h"
#include "js_buffer.h"
#include "js_function.h"
#include "js_jobs.h"

/* $262.createRealm(): a new realm in the same runtime (its own global object and
 * intrinsics), with its own $262, which is returned. */
static JSValue host_create_realm(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                                 const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    return js_test_host_init(js_context_new(ctx->rt));
}

/* $262.gc(): a full collection. */
static JSValue host_gc(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                       const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    js_gc(ctx);
    return JS_UNDEFINED;
}

/* $262.clearKeptObjects(): ClearKeptObjects, so WeakRef targets can be collected now. */
static JSValue host_clear_kept_objects(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                                       const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    js_clear_kept_objects(ctx->rt);
    return JS_UNDEFINED;
}

/* $262.detachArrayBuffer(buffer): DetachArrayBuffer. */
static JSValue host_detach_array_buffer(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                                        const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue b = argc ? argv[0] : JS_UNDEFINED;
    if (!js_is_array_buffer(b)) return js_throw_type_error(ctx, "detachArrayBuffer: not an ArrayBuffer");
    return js_array_buffer_detach(ctx, b) < 0 ? JS_EXCEPTION : JS_NULL;
}

/* Not provided: evalScript (needs eval), agent
 * (threads), IsHTMLDDA (browser annex). Tests using them fail or are skipped. */
JSValue js_test_host_init(JSContext *ctx) {
    js_set_rejection_mode(ctx->rt, JS_REJECTIONS_NONE);  /* tests leave rejected promises unhandled */
    if (!ctx->rt->components) js_install_components(ctx, js_all_components, js_all_components_count);  /* all of them */
    JSValue global = ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT];
    JSValue host = js_new_object(ctx);
    JSObject *h = js_as_object(host);
    const uint8_t attrs = JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE;
    js_define_data(ctx, h, js_atom_from_cstr(ctx, "global"), global, attrs);
    (void)js_define_method(ctx, h, "createRealm", host_create_realm, 0);
    (void)js_define_method(ctx, h, "gc", host_gc, 0);
    (void)js_define_method(ctx, h, "clearKeptObjects", host_clear_kept_objects, 0);
    (void)js_define_method(ctx, h, "detachArrayBuffer", host_detach_array_buffer, 1);
    js_define_data(ctx, js_as_object(global), js_atom_from_cstr(ctx, "$262"), host, attrs);
    return host;
}
