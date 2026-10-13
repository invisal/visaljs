/* Keys: the key material, a C record both Web Crypto's CryptoKey and node:crypto's
 * KeyObject hold (so converting between them shares it), and CryptoKey itself: Node's class,
 * its attributes (type, extractable, algorithm, usages: the same objects on every read) and
 * its inspection. */
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "crypto_internal.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_exception.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

/* ---- Key material ------------------------------------------------------------------------------ */

static void wipe(uint8_t *p, size_t n) {
    if (!p) return;
    memset(p, 0, n);
    free(p);
}

static void key_data_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    JSKeyData *k = (JSKeyData *)c;
    wipe(k->bytes, k->len);
    for (int i = 0; i < JS_KEY_PARTS; i++) wipe(k->part[i].p, k->part[i].n);
}

static const JSClass key_data_class = { "KeyData", sizeof(JSKeyData), NULL, NULL, NULL, NULL, NULL, key_data_finalize, NULL };

JSKeyData *js_key_data(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &key_data_class ? (JSKeyData *)js_as_object(v) : NULL;
}

JSKeyData *js_new_asym_key(JSContext *ctx, uint8_t type, uint8_t kind) {
    JSKeyData *k = (JSKeyData *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &key_data_class, JS_NULL, 0));
    k->type = type;
    k->kind = kind;
    return k;
}

void js_key_part_set(JSKeyPart *part, const uint8_t *p, size_t n) {
    wipe(part->p, part->n);
    part->p = malloc(n ? n : 1);
    if (!part->p) js_fatal("out of memory in crypto");
    if (n) memcpy(part->p, p, n);
    part->n = n;
}

JSValue js_new_secret_key(JSContext *ctx, const uint8_t *p, size_t n) {
    uint8_t *copy = malloc(n ? n : 1);
    if (!copy) js_fatal("out of memory in crypto");
    if (n) memcpy(copy, p, n);
    JSKeyData *k = (JSKeyData *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &key_data_class, JS_NULL, 0));
    k->type = JS_KEY_SECRET;
    k->bytes = copy;
    k->len = n;
    return js_object_value(&k->obj);
}

/* ---- CryptoKey --------------------------------------------------------------------------------- */

static void crypto_key_visit(JSCell *c, JSTracer *trc) {
    JSCryptoKey *k = (JSCryptoKey *)c;
    js_trace_value(trc, k->data);
    js_trace_value(trc, k->algorithm);
    js_trace_value(trc, k->usages);
}

static const JSClass crypto_key_class = { "CryptoKey", sizeof(JSCryptoKey), NULL, NULL, NULL, NULL, crypto_key_visit, NULL, NULL };

JSCryptoKey *js_as_crypto_key(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &crypto_key_class ? (JSCryptoKey *)js_as_object(v) : NULL;
}

JSValue js_new_crypto_key(JSContext *ctx, JSValue data, uint8_t alg, const JSHashAlg *hash, uint32_t length, JSValue algorithm,
                          JSValue usages, uint16_t mask, bool extractable) {
    JSCryptoKey *k = (JSCryptoKey *)js_alloc_object(ctx, JS_CELL_OBJECT,
                                                    js_shape_root(ctx, &crypto_key_class, ctx->intrinsics[JS_INTRINSIC_CRYPTO_KEY_PROTOTYPE], 0));
    js_init_slot(&k->data, data);
    js_init_slot(&k->algorithm, algorithm);
    js_init_slot(&k->usages, usages);
    k->usage_mask = mask;
    k->alg = alg;
    k->hash = hash;
    k->length = length;
    k->extractable = extractable;
    return js_object_value(&k->obj);
}

static const char *const KEY_TYPES[] = { "secret", "public", "private" };

BUILTIN(crypto_key_ctor) {
    UNUSED_ARGS;
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
}

#define THIS_KEY()                                       \
    JSCryptoKey *k = js_as_crypto_key(this_val);         \
    if (!k) return js_throw_invalid_this(ctx, "CryptoKey")

BUILTIN(crypto_key_type) {
    UNUSED_ARGS;
    THIS_KEY();
    return js_new_string_cstr(ctx, KEY_TYPES[js_key_data(k->data)->type]);
}

BUILTIN(crypto_key_extractable) {
    UNUSED_ARGS;
    THIS_KEY();
    return js_bool(k->extractable);
}

BUILTIN(crypto_key_algorithm) {
    UNUSED_ARGS;
    THIS_KEY();
    return k->algorithm;
}

BUILTIN(crypto_key_usages) {
    UNUSED_ARGS;
    THIS_KEY();
    return k->usages;
}

/* [nodejs.util.inspect.custom](depth, options): CryptoKey { type, extractable, algorithm, usages } */
BUILTIN(crypto_key_inspect) {
    (void)callee, (void)new_target;
    JSCryptoKey *k = js_as_crypto_key(this_val);
    if (!k) return this_val;
    JSValue o = js_new_object(ctx);
    static const char *const names[] = { "type", "extractable", "algorithm", "usages" };
    JSValue values[4] = { js_new_string_cstr(ctx, KEY_TYPES[js_key_data(k->data)->type]), js_bool(k->extractable), k->algorithm, k->usages };
    for (int i = 0; i < 4; i++) js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, names[i]), values[i], JS_PROP_DEFAULT);
    return js_inspect_named(ctx, "CryptoKey", o, ARG(0), ARG(1));
}

static const JSBuiltin crypto_key_proto[] = {
    WEBIDL_ATTRIBUTE("type", crypto_key_type, NULL),
    WEBIDL_ATTRIBUTE("extractable", crypto_key_extractable, NULL),
    WEBIDL_ATTRIBUTE("algorithm", crypto_key_algorithm, NULL),
    WEBIDL_ATTRIBUTE("usages", crypto_key_usages, NULL),
};

void js_crypto_install_key(JSContext *ctx, JSObject *global) {
    js_define_web_class(ctx, global, "CryptoKey", crypto_key_ctor, 0, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE],
                        JS_INTRINSIC_CRYPTO_KEY_PROTOTYPE);
    JSValue kp = ctx->intrinsics[JS_INTRINSIC_CRYPTO_KEY_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(kp), crypto_key_proto, JS_COUNTOF(crypto_key_proto));
    js_define_inspect(ctx, kp, crypto_key_inspect, "CryptoKey");
}

/* ---- KeyObject and CryptoKey (node:crypto's primitives) ----------------------------------------- */

/* cryptoKeyHandleOf(value): a CryptoKey's key handle, or undefined for anything else. */
JSValue js_crypto_key_handle_of(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    JSCryptoKey *k = js_as_crypto_key(ARG(0));
    return k ? k->data : JS_UNDEFINED;
}

/* cryptoToCryptoKey(format, keyData, algorithm, extractable, usages): importKey's steps, at once
 * (keyObject.toCryptoKey is synchronous): a CryptoKey, or the error thrown. */
JSValue js_crypto_to_crypto_key(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue args[5] = { ARG(0), ARG(1), ARG(2), ARG(3), ARG(4) };
    return js_crypto_import_key_steps(ctx, 5, args);
}
