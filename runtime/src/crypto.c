/* Web Crypto (W3C Web Cryptography API), the crypto component, as Node has it: the
 * `crypto` global (a Crypto: getRandomValues, randomUUID, subtle), SubtleCrypto
 * (crypto_subtle.c) and CryptoKey (crypto_key.c). Node's errors (ERR_INVALID_THIS,
 * ERR_MISSING_ARGS, the DOMExceptions) and its WebIDL attributes. */
#include <stdio.h>
#include <string.h>

#include "builtins_util.h"
#include "crypto_internal.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_crypto.h"
#include "js_exception.h"
#include "js_promise.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

static const JSClass crypto_class = { "Crypto", sizeof(JSObject), NULL, NULL, NULL, NULL, NULL, NULL, NULL };

static bool is_crypto(JSValue v) { return js_is_object(v) && js_as_object(v)->shape->cls == &crypto_class; }

BUILTIN(illegal_ctor) {
    UNUSED_ARGS;
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
}

/* WebIDL's argument count check: `Failed to execute 'digest' on 'SubtleCrypto': 2 arguments
 * required, but only 1 present.` */
static JSValue throw_missing_args(JSContext *ctx, const char *op, const char *iface, uint32_t need, uint32_t argc) {
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS",
                               "Failed to execute '%s' on '%s': %u argument%s required, but only %u present.", op, iface,
                               need, need == 1 ? "" : "s", argc);
}

/* ---- Crypto ------------------------------------------------------------------------------------ */

/* crypto.getRandomValues(typedArray): an integer typed array of at most 65,536 bytes, filled. */
BUILTIN(get_random_values) {
    (void)callee, (void)new_target;
    if (!is_crypto(this_val)) return js_throw_invalid_this(ctx, "Crypto");
    if (argc < 1) return throw_missing_args(ctx, "getRandomValues", "Crypto", 1, argc);
    int type = js_typed_array_type(argv[0]);
    if (type < 0 || type == JS_TA_FLOAT16 || type == JS_TA_FLOAT32 || type == JS_TA_FLOAT64)
        return js_throw_dom_exception(ctx, "TypeMismatchError", "The data argument must be an integer-type TypedArray");
    uint8_t *p;
    size_t n;
    js_buffer_source_bytes(argv[0], &p, &n);
    if (n > 65536) return js_throw_dom_exception(ctx, "QuotaExceededError", "The requested length exceeds 65,536 bytes");
    js_crypto_random(p, n);
    return argv[0];
}

/* A version 4 UUID (RFC 9562 §5.4), lowercase. */
JSValue js_crypto_random_uuid(JSContext *ctx) {
    uint8_t b[16];
    js_crypto_random(b, sizeof b);
    b[6] = (uint8_t)((b[6] & 0x0F) | 0x40);
    b[8] = (uint8_t)((b[8] & 0x3F) | 0x80);
    static const char HEX[] = "0123456789abcdef";
    uint8_t s[36];
    size_t k = 0;
    for (int i = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) s[k++] = '-';
        s[k++] = (uint8_t)HEX[b[i] >> 4];
        s[k++] = (uint8_t)HEX[b[i] & 15];
    }
    return js_new_string_latin1(ctx, s, 36);
}

BUILTIN(random_uuid) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    if (!is_crypto(this_val)) return js_throw_invalid_this(ctx, "Crypto");
    return js_crypto_random_uuid(ctx);
}

BUILTIN(crypto_subtle) {
    UNUSED_ARGS;
    if (!is_crypto(this_val)) return js_throw_invalid_this(ctx, "Crypto");
    return ctx->intrinsics[JS_INTRINSIC_SUBTLE_CRYPTO];
}

BUILTIN(global_crypto) {
    UNUSED_ARGS;
    return ctx->intrinsics[JS_INTRINSIC_CRYPTO];
}

/* ---- Realm ------------------------------------------------------------------------------------- */

static const JSBuiltin crypto_globals[] = {
    WEBIDL_ATTRIBUTE("crypto", global_crypto, NULL),
};

static const JSBuiltin crypto_proto[] = {
    WEBIDL_ATTRIBUTE("subtle", crypto_subtle, NULL),
    WEBIDL_OPERATION("getRandomValues", get_random_values, 1),
    WEBIDL_OPERATION("randomUUID", random_uuid, 0),
};

static void install_crypto(JSContext *ctx, JSObject *global) {
    JSValue object_proto = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];
    js_define_web_class(ctx, global, "Crypto", illegal_ctor, 0, object_proto, JS_INTRINSIC_CRYPTO_PROTOTYPE);
    JSValue cp = ctx->intrinsics[JS_INTRINSIC_CRYPTO_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(cp), crypto_proto, JS_COUNTOF(crypto_proto));
    js_define_data(ctx, js_as_object(cp), JS_SYMBOL(toStringTag), js_new_string_cstr(ctx, "Crypto"), JS_PROP_CONFIGURABLE);

    ctx->intrinsics[JS_INTRINSIC_CRYPTO] = js_object_value(js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &crypto_class, cp, 0)));

    js_crypto_install_subtle(ctx, global);
    js_crypto_install_key(ctx, global);
    js_define_builtins(ctx, global, crypto_globals, JS_COUNTOF(crypto_globals));
}

const JSComponent js_component_crypto = { "crypto", install_crypto };
