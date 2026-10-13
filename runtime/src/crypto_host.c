/* node:crypto's host primitives: the prelude (node/prelude/crypto.js) builds Node's
 * API on these, and Web Crypto shares the C beneath them (crypto_internal.h). Bad arguments are
 * the prelude's to check; here they are only kept from crashing. Handles are objects of the
 * classes below (no prototype): the prelude keeps them in its objects. */
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "crypto_internal.h"
#include "internal.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_crypto.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)

/* The bytes of a string (as UTF-8) or a buffer source, for the duration of a call. */
typedef struct Bytes {
    const uint8_t *p;
    size_t         n;
    uint8_t       *owned;  /* malloc'd for a large string */
    uint8_t        small[256];
} Bytes;

static bool bytes_of(JSContext *ctx, JSValue v, Bytes *b) {
    b->owned = NULL;
    uint8_t *p;
    if (js_buffer_source_bytes(v, &p, &b->n)) {
        b->p = p;
        return true;
    }
    if (!js_is_string(v)) return false;
    JSStrView view = js_string_view(ctx, v);
    b->n = js_view_to_utf8(view, (char *)b->small, sizeof b->small);
    if (b->n <= sizeof b->small) {
        b->p = b->small;
        return true;
    }
    b->owned = malloc(b->n);
    if (!b->owned) js_fatal("out of memory in crypto");
    js_view_to_utf8(view, (char *)b->owned, b->n);
    b->p = b->owned;
    return true;
}

static void bytes_free(Bytes *b) { free(b->owned); }

static char *name_arg(JSContext *ctx, JSValue v, char *buf, size_t cap) {
    if (!js_is_string(v)) return NULL;
    JSStrView view = js_string_view(ctx, v);
    size_t n = js_view_to_utf8(view, buf, cap - 1);
    if (n >= cap - 1) return NULL;
    buf[n] = 0;
    return buf;
}

/* ---- Hash and Hmac ----------------------------------------------------------------------------- */

typedef struct DigestObject {
    JSObject obj;
    bool     hmac;
    size_t   out_len;  /* SHAKE: the output length asked for */
    union {
        JSHashCtx hash;
        JSHmacCtx hmac;
    } u;
} DigestObject;

static const JSClass digest_class = { "Hash", sizeof(DigestObject), NULL, NULL, NULL, NULL, NULL, NULL, NULL };

static DigestObject *as_digest(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &digest_class ? (DigestObject *)js_as_object(v) : NULL;
}

static DigestObject *new_digest(JSContext *ctx) {
    return (DigestObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &digest_class, JS_NULL, 0));
}

/* cryptoHashNew(algorithm, outputLength): a hash handle, or null for an unknown algorithm.
 * outputLength (a number, or undefined for the default) is the XOFs' only. */
PRIMITIVE(js_crypto_hash_new) {
    (void)callee, (void)this_val, (void)new_target;
    char name[64];
    const JSHashAlg *alg = name_arg(ctx, ARG(0), name, sizeof name) ? js_hash_by_name(name) : NULL;
    if (!alg) return JS_NULL;
    DigestObject *d = new_digest(ctx);
    d->hmac = false;
    d->out_len = alg->xof && js_is_number(ARG(1)) ? (size_t)js_as_number(ARG(1)) : alg->out_len;
    js_hash_init(&d->u.hash, alg);
    return js_object_value(&d->obj);
}

/* cryptoHashOutputLength(algorithm): the digest's default length in bytes, -1 for an unknown
 * algorithm; negated (less one) for the XOFs, whose length can be chosen. */
PRIMITIVE(js_crypto_hash_info) {
    (void)callee, (void)this_val, (void)new_target;
    char name[64];
    const JSHashAlg *alg = name_arg(ctx, ARG(0), name, sizeof name) ? js_hash_by_name(name) : NULL;
    if (!alg) return js_int32(-1);
    return js_int32(alg->xof ? -(int32_t)alg->out_len - 1 : (int32_t)alg->out_len);
}

/* cryptoHashCopy(hash, outputLength): a copy of the hash's state. */
PRIMITIVE(js_crypto_hash_copy) {
    (void)callee, (void)this_val, (void)new_target;
    DigestObject *src = as_digest(ARG(0));
    if (!src) return js_throw_type_error(ctx, "cryptoHashCopy: a hash expected");
    DigestObject *d = new_digest(ctx);
    src = as_digest(ARG(0));
    d->hmac = src->hmac;
    d->u = src->u;
    d->out_len = src->u.hash.alg->xof && js_is_number(ARG(1)) ? (size_t)js_as_number(ARG(1)) : src->out_len;
    return js_object_value(&d->obj);
}

/* cryptoHmacNew(algorithm, key): an HMAC handle, or null for an unknown algorithm (or an XOF). */
PRIMITIVE(js_crypto_hmac_new) {
    (void)callee, (void)this_val, (void)new_target;
    char name[64];
    const JSHashAlg *alg = name_arg(ctx, ARG(0), name, sizeof name) ? js_hash_by_name(name) : NULL;
    if (!alg || alg->xof) return JS_NULL;
    DigestObject *d = new_digest(ctx);
    Bytes key;
    if (!bytes_of(ctx, ARG(1), &key)) return js_throw_type_error(ctx, "cryptoHmacNew: a key expected");
    d->hmac = true;
    d->out_len = alg->out_len;
    js_hmac_init(&d->u.hmac, alg, key.p, key.n);
    bytes_free(&key);
    return js_object_value(&d->obj);
}

/* cryptoDigestUpdate(handle, data): data a string (as UTF-8) or a buffer source. */
PRIMITIVE(js_crypto_digest_update) {
    (void)callee, (void)this_val, (void)new_target;
    DigestObject *d = as_digest(ARG(0));
    Bytes data;
    if (!d || !bytes_of(ctx, ARG(1), &data)) return js_throw_type_error(ctx, "cryptoDigestUpdate: a handle and data expected");
    if (d->hmac) js_hmac_update(&d->u.hmac, data.p, data.n);
    else js_hash_update(&d->u.hash, data.p, data.n);
    bytes_free(&data);
    return JS_UNDEFINED;
}

/* cryptoDigestFinal(handle): the digest, a Buffer. The handle is spent. */
PRIMITIVE(js_crypto_digest_final) {
    (void)callee, (void)this_val, (void)new_target;
    DigestObject *d = as_digest(ARG(0));
    if (!d) return js_throw_type_error(ctx, "cryptoDigestFinal: a handle expected");
    uint8_t small[64];
    uint8_t *out = d->out_len <= sizeof small ? small : malloc(d->out_len);
    if (!out) js_fatal("out of memory in crypto");
    if (d->hmac) js_hmac_final(&d->u.hmac, out);
    else js_hash_final(&d->u.hash, out, d->out_len);
    JSValue r = js_new_buffer_from_bytes(ctx, out, d->out_len);
    if (out != small) free(out);
    return r;
}

/* ---- Random ------------------------------------------------------------------------------------ */

/* cryptoRandomFill(bufferSource, offset, size): fills those bytes. */
PRIMITIVE(js_crypto_random_fill) {
    (void)callee, (void)this_val, (void)new_target;
    uint8_t *p;
    size_t n;
    if (!js_buffer_source_bytes(ARG(0), &p, &n) || !js_is_number(ARG(1)) || !js_is_number(ARG(2)))
        return js_throw_type_error(ctx, "cryptoRandomFill: bytes, offset and size expected");
    double off = js_as_number(ARG(1)), size = js_as_number(ARG(2));
    if (off < 0 || size < 0 || off + size > (double)n) return js_throw_range_error(ctx, "cryptoRandomFill: out of range");
    js_crypto_random(p + (size_t)off, (size_t)size);
    return JS_UNDEFINED;
}

/* cryptoRandomUUID(): a version 4 UUID. */
PRIMITIVE(js_crypto_host_random_uuid) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    return js_crypto_random_uuid(ctx);
}

/* cryptoTimingSafeEqual(a, b): two buffer sources of the same length, compared in constant time. */
PRIMITIVE(js_crypto_timing_safe_equal) {
    (void)callee, (void)this_val, (void)new_target;
    uint8_t *a, *b;
    size_t na, nb;
    if (!js_buffer_source_bytes(ARG(0), &a, &na) || !js_buffer_source_bytes(ARG(1), &b, &nb) || na != nb)
        return js_throw_type_error(ctx, "cryptoTimingSafeEqual: two buffers of one length expected");
    return js_bool(js_crypto_equal(a, b, na));
}

/* cryptoHashes(): crypto.getHashes(), a new array. */
PRIMITIVE(js_crypto_hashes) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue a = js_new_array(ctx, (uint32_t)js_hash_names_count);
    for (size_t i = 0; i < js_hash_names_count; i++) {
        JSValue s = js_new_string_cstr(ctx, js_hash_names[i]);
        if (js_is_exception(s) || js_array_append(ctx, a, s) < 0) return JS_EXCEPTION;
    }
    return a;
}

/* ---- Key derivation ---------------------------------------------------------------------------- */

static bool bytes_arg(JSValue v, Bytes *b) {
    uint8_t *p;
    b->owned = NULL;
    if (!js_buffer_source_bytes(v, &p, &b->n)) return false;
    b->p = p;
    return true;
}

/* cryptoPbkdf2(digest, password, salt, iterations, keylen): a Buffer; null for an unknown digest,
 * false when deriving fails (an XOF, no length), as OpenSSL fails. */
PRIMITIVE(js_crypto_pbkdf2) {
    (void)callee, (void)this_val, (void)new_target;
    char name[64];
    Bytes pw, salt;
    if (!name_arg(ctx, ARG(0), name, sizeof name) || !bytes_arg(ARG(1), &pw) || !bytes_arg(ARG(2), &salt) || !js_is_number(ARG(3)) ||
        !js_is_number(ARG(4)))
        return js_throw_type_error(ctx, "cryptoPbkdf2: bad arguments");
    const JSHashAlg *alg = js_hash_by_name(name);
    if (!alg) return JS_NULL;
    size_t n = (size_t)js_as_number(ARG(4));
    uint8_t *out = malloc(n ? n : 1);
    if (!out) js_fatal("out of memory in crypto");
    bool ok = n > 0 && js_pbkdf2(alg, pw.p, pw.n, salt.p, salt.n, (uint32_t)js_as_number(ARG(3)), out, n);
    JSValue r = ok ? js_new_buffer_from_bytes(ctx, out, n) : JS_FALSE;
    free(out);
    return r;
}

/* cryptoHkdf(digest, ikm, salt, info, keylen): an ArrayBuffer; null for an unknown digest, false
 * when deriving fails (an XOF, no length, more than 255 blocks). */
PRIMITIVE(js_crypto_hkdf) {
    (void)callee, (void)this_val, (void)new_target;
    char name[64];
    Bytes ikm, salt, info;
    if (!name_arg(ctx, ARG(0), name, sizeof name) || !bytes_arg(ARG(1), &ikm) || !bytes_arg(ARG(2), &salt) || !bytes_arg(ARG(3), &info) ||
        !js_is_number(ARG(4)))
        return js_throw_type_error(ctx, "cryptoHkdf: bad arguments");
    const JSHashAlg *alg = js_hash_by_name(name);
    if (!alg) return JS_NULL;
    double len = js_as_number(ARG(4));
    if (len <= 0 || len > 255.0 * alg->out_len) return JS_FALSE;
    size_t n = (size_t)len;
    uint8_t *out = malloc(n);
    if (!out) js_fatal("out of memory in crypto");
    JSValue r = JS_FALSE;
    if (js_hkdf(alg, ikm.p, ikm.n, salt.p, salt.n, info.p, info.n, out, n)) {
        r = js_new_array_buffer(ctx, n);
        if (!js_is_exception(r)) memcpy(js_as_array_buffer(r)->data, out, n);
    }
    free(out);
    return r;
}

/* cryptoScryptCheck(N, r, p, maxmem): 0, 1 (invalid parameters) or 2 (over maxmem). */
PRIMITIVE(js_crypto_scrypt_check) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    for (uint32_t i = 0; i < 4; i++)
        if (!js_is_number(ARG(i)) || js_as_number(ARG(i)) < 0) return js_int32(JS_SCRYPT_INVALID);
    return js_int32(js_scrypt_check((uint64_t)js_as_number(ARG(0)), (uint64_t)js_as_number(ARG(1)), (uint64_t)js_as_number(ARG(2)),
                                    (uint64_t)js_as_number(ARG(3))));
}

/* cryptoScrypt(password, salt, N, r, p, keylen), with checked parameters: a Buffer, or false. */
PRIMITIVE(js_crypto_scrypt) {
    (void)callee, (void)this_val, (void)new_target;
    Bytes pw, salt;
    if (!bytes_arg(ARG(0), &pw) || !bytes_arg(ARG(1), &salt)) return js_throw_type_error(ctx, "cryptoScrypt: bad arguments");
    for (uint32_t i = 2; i < 6; i++)
        if (!js_is_number(ARG(i))) return js_throw_type_error(ctx, "cryptoScrypt: bad arguments");
    size_t n = (size_t)js_as_number(ARG(5));
    uint8_t *out = malloc(n ? n : 1);
    if (!out) js_fatal("out of memory in crypto");
    bool ok = js_scrypt(pw.p, pw.n, salt.p, salt.n, (uint64_t)js_as_number(ARG(2)), (uint32_t)js_as_number(ARG(3)),
                        (uint32_t)js_as_number(ARG(4)), out, n);
    JSValue r = ok ? js_new_buffer_from_bytes(ctx, out, n) : JS_FALSE;
    free(out);
    return r;
}

/* ---- Ciphers ----------------------------------------------------------------------------------- */

typedef struct CipherObject {
    JSObject    obj;
    JSCipherCtx c;
} CipherObject;

static void cipher_finalize(JSRuntime *rt, JSCell *cell) {
    (void)rt;
    js_cipher_free(&((CipherObject *)cell)->c);
}

static const JSClass cipher_class = { "CipherBase", sizeof(CipherObject), NULL, NULL, NULL, NULL, NULL, cipher_finalize, NULL };

static CipherObject *as_cipher(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &cipher_class ? (CipherObject *)js_as_object(v) : NULL;
}

/* A Buffer of the output (freed), or the error code. */
static JSValue bytes_result(JSContext *ctx, int err, JSBytesOut *out) {
    JSValue r = err ? js_int32(err) : js_new_buffer_from_bytes(ctx, out->p, out->n);
    free(out->p);
    return r;
}

/* cryptoCipherNew(name, encrypt, key, iv | null, authTagLength (-1: none)): a handle, or an
 * error code (JS_CIPHER_ERR_*; -1: an unknown cipher). */
PRIMITIVE(js_crypto_cipher_new) {
    (void)callee, (void)this_val, (void)new_target;
    char name[64];
    Bytes key, iv;
    bool has_iv = !js_is_null(ARG(3));
    if (!name_arg(ctx, ARG(0), name, sizeof name)) return js_int32(-1);
    if (!bytes_arg(ARG(2), &key) || (has_iv && !bytes_arg(ARG(3), &iv)) || !js_is_number(ARG(4)))
        return js_throw_type_error(ctx, "cryptoCipherNew: bad arguments");
    const JSCipherAlg *alg = js_cipher_by_name(name);
    if (!alg) return js_int32(-1);
    CipherObject *o = (CipherObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &cipher_class, JS_NULL, 0));
    int err = js_cipher_init(&o->c, alg, js_truthy(ARG(1)), key.p, key.n, has_iv ? iv.p : NULL, has_iv ? iv.n : 0, has_iv,
                             (long)js_as_number(ARG(4)));
    return err ? js_int32(err) : js_object_value(&o->obj);
}

/* cryptoCipherUpdate(handle, data): a Buffer, or an error code. */
PRIMITIVE(js_crypto_cipher_update) {
    (void)callee, (void)this_val, (void)new_target;
    CipherObject *o = as_cipher(ARG(0));
    Bytes data;
    if (!o || !bytes_of(ctx, ARG(1), &data)) return js_throw_type_error(ctx, "cryptoCipherUpdate: a handle and data expected");
    JSBytesOut out = { 0 };
    int err = js_cipher_update(&o->c, data.p, data.n, &out);
    bytes_free(&data);
    return bytes_result(ctx, err, &out);
}

/* cryptoCipherFinal(handle): a Buffer, or an error code. */
PRIMITIVE(js_crypto_cipher_final) {
    (void)callee, (void)this_val, (void)new_target;
    CipherObject *o = as_cipher(ARG(0));
    if (!o) return js_throw_type_error(ctx, "cryptoCipherFinal: a handle expected");
    JSBytesOut out = { 0 };
    return bytes_result(ctx, js_cipher_final(&o->c, &out), &out);
}

/* cryptoCipherSetAAD(handle, bytes, plaintextLength (-1: none)): 0, or an error code. */
PRIMITIVE(js_crypto_cipher_set_aad) {
    (void)callee, (void)this_val, (void)new_target;
    CipherObject *o = as_cipher(ARG(0));
    Bytes aad;
    if (!o || !bytes_arg(ARG(1), &aad) || !js_is_number(ARG(2))) return js_throw_type_error(ctx, "cryptoCipherSetAAD: bad arguments");
    return js_int32(js_cipher_set_aad(&o->c, aad.p, aad.n, (long)js_as_number(ARG(2))));
}

/* cryptoCipherSetAuthTag(handle, bytes): 0, or an error code. */
PRIMITIVE(js_crypto_cipher_set_auth_tag) {
    (void)callee, (void)this_val, (void)new_target;
    CipherObject *o = as_cipher(ARG(0));
    Bytes tag;
    if (!o || !bytes_arg(ARG(1), &tag)) return js_throw_type_error(ctx, "cryptoCipherSetAuthTag: bad arguments");
    return js_int32(js_cipher_set_auth_tag(&o->c, tag.p, tag.n));
}

/* cryptoCipherGetAuthTag(handle): a Buffer, or undefined when there is none (yet). */
PRIMITIVE(js_crypto_cipher_get_auth_tag) {
    (void)callee, (void)this_val, (void)new_target;
    CipherObject *o = as_cipher(ARG(0));
    if (!o) return js_throw_type_error(ctx, "cryptoCipherGetAuthTag: a handle expected");
    const uint8_t *p;
    size_t n;
    return js_cipher_get_auth_tag(&o->c, &p, &n) ? js_new_buffer_from_bytes(ctx, p, n) : JS_UNDEFINED;
}

/* cryptoCipherSetPadding(handle, padding): whether it could. */
PRIMITIVE(js_crypto_cipher_set_padding) {
    (void)callee, (void)this_val, (void)new_target;
    CipherObject *o = as_cipher(ARG(0));
    if (!o) return js_throw_type_error(ctx, "cryptoCipherSetPadding: a handle expected");
    return js_bool(js_cipher_set_padding(&o->c, js_truthy(ARG(1))));
}

/* cryptoCipherInfo(name | nid): [name, nid, mode, blockSize, ivLength, keyLength], or null.
 * blockSize and ivLength are 0 when getCipherInfo omits them. */
PRIMITIVE(js_crypto_cipher_info) {
    (void)callee, (void)this_val, (void)new_target;
    const JSCipherAlg *alg = NULL;
    char name[64];
    if (js_is_number(ARG(0))) alg = js_cipher_by_nid((int)js_as_number(ARG(0)));
    else if (name_arg(ctx, ARG(0), name, sizeof name)) alg = js_cipher_by_name(name);
    if (!alg) return JS_NULL;
    JSValue a = js_new_array(ctx, 6);
    JSValue items[6] = { js_new_string_cstr(ctx, alg->info_name), js_int32(alg->nid), js_new_string_cstr(ctx, alg->mode_name),
                         js_int32(alg->block_size), js_int32(alg->iv_len), js_int32(alg->key_len) };
    for (int i = 0; i < 6; i++)
        if (js_array_append(ctx, a, items[i]) < 0) return JS_EXCEPTION;
    return a;
}

/* cryptoCiphers(): crypto.getCiphers(), a new array. */
PRIMITIVE(js_crypto_ciphers) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue a = js_new_array(ctx, (uint32_t)js_cipher_count);
    for (size_t i = 0; i < js_cipher_count; i++) {
        JSValue s = js_new_string_cstr(ctx, js_cipher_at(i)->name);
        if (js_is_exception(s) || js_array_append(ctx, a, s) < 0) return JS_EXCEPTION;
    }
    return a;
}
