/* SubtleCrypto (W3C Web Cryptography API §14), part of the crypto component, as Node
 * has it: its WebIDL conversions and their messages, algorithm normalization (a registry of the
 * algorithms each operation supports, and their parameter dictionaries), and the operations.
 * A method's errors reject its promise; its result is computed at the call, so the promise is
 * already settled when it returns (Node settles from its thread pool). */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "crypto_internal.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_host.h"
#include "js_ops.h"
#include "js_promise.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

static const JSClass subtle_class = { "SubtleCrypto", sizeof(JSObject), NULL, NULL, NULL, NULL, NULL, NULL, NULL };

static bool is_subtle(JSValue v) { return js_is_object(v) && js_as_object(v)->shape->cls == &subtle_class; }

/* A failure's -1, after the call that threw (the throwers' results must be used). */
static int fail(JSValue thrown) {
    (void)thrown;
    return -1;
}

static JSValue rejected(JSContext *ctx, JSValue thrown) {
    (void)thrown;
    JSValue p = js_new_promise(ctx);
    js_promise_reject_internal(ctx, p, js_take_exception(ctx));
    return p;
}

static JSValue settled(JSContext *ctx, JSValue v) {
    if (js_is_exception(v)) return rejected(ctx, v);
    JSValue p = js_new_promise(ctx);
    js_promise_resolve_internal(ctx, p, v);
    return p;
}

static JSValue dom_error(JSContext *ctx, const char *name, const char *message) {
    return js_throw_dom_exception(ctx, name, message);
}

static JSValue op_failed(JSContext *ctx) {
    return dom_error(ctx, "OperationError", "The operation failed for an operation-specific reason");
}

/* A key usage the algorithm doesn't allow: "Unsupported key usage for AES-GCM key" (Node 24's
 * wording, the algorithm's name) */
static JSValue usage_error(JSContext *ctx, const char *algorithm) {
    char m[96];
    snprintf(m, sizeof m, "Unsupported key usage for %s key", algorithm);
    return dom_error(ctx, "SyntaxError", m);
}

static JSValue array_buffer_of(JSContext *ctx, const uint8_t *p, size_t n) {
    JSValue b = js_new_array_buffer(ctx, n);
    if (js_is_exception(b)) return b;
    if (n) memcpy(js_as_array_buffer(b)->data, p, n);
    return b;
}

static JSValue str(JSContext *ctx, const char *s) { return js_new_string_cstr(ctx, s); }

static void put(JSContext *ctx, JSValue o, const char *key, JSValue v) {
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, key), v, JS_PROP_DEFAULT);
}

/* A string's characters, when they are all ASCII and fit (else ""). */
static void ascii_of(JSContext *ctx, JSValue s, char *buf, size_t cap) {
    JSStrView v = js_string_view(ctx, s);
    buf[0] = 0;
    if (v.length >= cap) return;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c >= 0x80) {
            buf[0] = 0;
            return;
        }
        buf[i] = (char)c;
    }
    buf[v.length] = 0;
}

static bool same_ci(const char *a, const char *b) {
    for (; *a && *b; a++, b++) {
        char x = *a >= 'A' && *a <= 'Z' ? (char)(*a + 32) : *a, y = *b >= 'A' && *b <= 'Z' ? (char)(*b + 32) : *b;
        if (x != y) return false;
    }
    return *a == *b;
}

/* ---- Bytes ------------------------------------------------------------------------------------- */

/* A copy of a buffer source's bytes (the operations work on copies, as the standard says). */
typedef struct Bytes {
    uint8_t *p;
    size_t   n;
} Bytes;

static void bytes_copy(Bytes *b, JSValue v) {
    uint8_t *p;
    size_t n;
    js_buffer_source_bytes(v, &p, &n);
    b->p = malloc(n ? n : 1);
    if (!b->p) js_fatal("out of memory in crypto");
    if (n) memcpy(b->p, p, n);
    b->n = n;
}

static void bytes_free(Bytes *b) {
    free(b->p);
    b->p = NULL;
    b->n = 0;
}

/* ---- base64url (JWK) --------------------------------------------------------------------------- */

static const char B64URL[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

static JSValue base64url_encode(JSContext *ctx, const uint8_t *p, size_t n) {
    size_t cap = (n + 2) / 3 * 4;
    uint8_t *out = malloc(cap ? cap : 1);
    if (!out) js_fatal("out of memory in crypto");
    size_t k = 0;
    for (size_t i = 0; i < n; i += 3) {
        size_t rest = n - i;
        uint32_t b = (uint32_t)p[i] << 16 | (rest > 1 ? (uint32_t)p[i + 1] << 8 : 0) | (rest > 2 ? p[i + 2] : 0);
        out[k++] = (uint8_t)B64URL[b >> 18];
        out[k++] = (uint8_t)B64URL[(b >> 12) & 63];
        if (rest > 1) out[k++] = (uint8_t)B64URL[(b >> 6) & 63];
        if (rest > 2) out[k++] = (uint8_t)B64URL[b & 63];
    }
    JSValue s = js_new_string_latin1(ctx, out, (uint32_t)k);
    free(out);
    return s;
}

/* Decoded as Node decodes base64url: either alphabet, other characters skipped, '=' ends it. */
static void base64url_decode(JSContext *ctx, JSValue s, Bytes *out) {
    JSStrView v = js_string_view(ctx, s);
    out->p = malloc(v.length ? v.length : 1);
    if (!out->p) js_fatal("out of memory in crypto");
    size_t k = 0, bits = 0;
    uint32_t acc = 0;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        int x;
        if (c >= 'A' && c <= 'Z') x = (int)(c - 'A');
        else if (c >= 'a' && c <= 'z') x = (int)(c - 'a' + 26);
        else if (c >= '0' && c <= '9') x = (int)(c - '0' + 52);
        else if (c == '-' || c == '+') x = 62;
        else if (c == '_' || c == '/') x = 63;
        else if (c == '=') break;
        else continue;
        acc = acc << 6 | (uint32_t)x;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out->p[k++] = (uint8_t)(acc >> bits);
        }
    }
    out->n = k;
}

/* ---- WebIDL conversions ------------------------------------------------------------------------ */

static const char *const ORDINALS[] = { "1st", "2nd", "3rd", "4th", "5th", "6th", "7th" };

typedef struct Call {
    JSContext  *ctx;
    const char *op;  /* "importKey" */
} Call;

static JSValue throw_missing_args(Call *c, uint32_t need, uint32_t argc) {
    return js_throw_node_error(c->ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS",
                               "Failed to execute '%s' on 'SubtleCrypto': %u argument%s required, but only %u present.", c->op,
                               need, need == 1 ? "" : "s", argc);
}

static int arg_buffer_source(Call *c, JSValue v, int i) {
    uint8_t *p;
    size_t n;
    if (js_buffer_source_bytes(v, &p, &n)) return 0;
    return fail(js_throw_node_error(c->ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
                                    "Failed to execute '%s' on 'SubtleCrypto': %s argument is not instance of ArrayBuffer, "
                                    "Buffer, TypedArray, or DataView.", c->op, ORDINALS[i]));
}

static int arg_algorithm(Call *c, JSValue v, int i) {
    if (!js_is_symbol(v)) return 0;
    return fail(js_throw_type_error(c->ctx, "Failed to execute '%s' on 'SubtleCrypto': %s argument is not of type object or string.",
                                    c->op, ORDINALS[i]));
}

static JSCryptoKey *arg_key(Call *c, JSValue v, int i) {
    JSCryptoKey *k = js_as_crypto_key(v);
    if (!k) (void)fail(js_throw_node_error(c->ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
                                           "Failed to execute '%s' on 'SubtleCrypto': %s argument is not of type CryptoKey.", c->op,
                                           ORDINALS[i]));
    return k;
}

/* An enum value (KeyFormat, KeyUsage): its index in `values`, or -1 with a TypeError. */
static int arg_enum(Call *c, JSValue v, const char *const *values, int count, const char *type, const char *where) {
    JSValue s = js_to_string(c->ctx, v);
    if (js_is_exception(s)) return -1;
    char buf[32];
    ascii_of(c->ctx, s, buf, sizeof buf);
    for (int i = 0; i < count; i++)
        if (strcmp(buf, values[i]) == 0) return i;
    char shown[64];
    size_t n = js_view_to_utf8(js_string_view(c->ctx, s), shown, sizeof shown - 1);
    shown[n < sizeof shown - 1 ? n : sizeof shown - 1] = 0;
    return fail(js_throw_node_error(c->ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_VALUE",
                                    "Failed to execute '%s' on 'SubtleCrypto': %s '%s' is not a valid enum value of type %s.",
                                    c->op, where, shown, type));
}

/* the raw-* formats (Node 24's, from WebCrypto's Modern Algorithms draft) say which key raw is */
enum { FORMAT_RAW, FORMAT_SPKI, FORMAT_PKCS8, FORMAT_JWK, FORMAT_RAW_PUBLIC, FORMAT_RAW_PRIVATE, FORMAT_RAW_SEED, FORMAT_RAW_SECRET };
static const char *const FORMATS[] = { "raw", "spki", "pkcs8", "jwk", "raw-public", "raw-private", "raw-seed", "raw-secret" };
static const char *const USAGES[] = { "encrypt", "decrypt", "sign", "verify", "deriveKey", "deriveBits", "wrapKey", "unwrapKey" };

static int arg_format(Call *c, JSValue v, int i) {
    char where[32];
    snprintf(where, sizeof where, "%s argument", ORDINALS[i]);
    return arg_enum(c, v, FORMATS, 8, "KeyFormat", where);
}

/* sequence<KeyUsage>: a new array of the strings, in order (duplicates kept, as Node keeps them),
 * and their bits. */
static JSValue arg_usages(Call *c, JSValue v, int i, uint16_t *mask) {
    JSContext *ctx = c->ctx;
    JSValue method = js_is_object(v) ? js_get_value(ctx, v, JS_SYMBOL(iterator)) : JS_UNDEFINED;
    if (js_is_exception(method)) return method;
    if (!js_is_callable(method))
        return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
                                   "Failed to execute '%s' on 'SubtleCrypto': %s argument cannot be converted to sequence.", c->op,
                                   ORDINALS[i]);
    JSValue out = js_new_array(ctx, 4);
    JSValue rec = js_iter_start(ctx, v);
    if (js_is_exception(rec)) return rec;
    *mask = 0;
    for (uint32_t n = 0;; n++) {
        JSValue u = js_iter_next(ctx, rec);
        if (js_is_exception(u)) return u;
        if (js_is_empty(u)) break;
        char where[64];
        snprintf(where, sizeof where, "%s argument[%u]", ORDINALS[i], n);
        int k = arg_enum(c, u, USAGES, 8, "KeyUsage", where);
        if (k < 0) {
            js_iter_close_throw(ctx, rec);
            return JS_EXCEPTION;
        }
        *mask |= (uint16_t)(1u << k);
        if (js_array_append(ctx, out, str(ctx, USAGES[k])) < 0) return JS_EXCEPTION;
    }
    return out;
}

/* The usages of a mask, in KeyUsage's order (generateKey's: Node makes them a set). */
static JSValue usages_array(JSContext *ctx, JSValue given) {
    JSValue out = js_new_array(ctx, 4);
    uint32_t n = js_array_length(js_as_object(given));
    for (uint32_t i = 0; i < n; i++) {
        JSValue u = js_get_elem(ctx, given, js_int32((int32_t)i));
        if (js_is_exception(u)) return u;
        bool seen = false;
        for (uint32_t j = 0; j < js_array_length(js_as_object(out)) && !seen; j++)
            seen = js_string_equals(ctx, js_get_elem(ctx, out, js_int32((int32_t)j)), u);
        if (!seen && js_array_append(ctx, out, u) < 0) return JS_EXCEPTION;
    }
    return out;
}

/* ---- JsonWebKey -------------------------------------------------------------------------------- */

/* A JWK's members, by name (WebIDL's order, alphabetical): undefined when absent; ext a
 * boolean, key_ops an array of strings, the rest strings. */
enum { JWK_ALG, JWK_CRV, JWK_D, JWK_DP, JWK_DQ, JWK_E, JWK_EXT, JWK_K, JWK_KEY_OPS, JWK_KTY, JWK_N, JWK_P, JWK_Q, JWK_QI, JWK_USE, JWK_X, JWK_Y, JWK_COUNT };
static const char *const JWK_NAMES[] = { "alg", "crv", "d", "dp", "dq", "e", "ext", "k", "key_ops", "kty", "n", "p", "q", "qi", "use", "x", "y" };

typedef struct JWK {
    JSValue m[JWK_COUNT];
} JWK;

/* The dictionary conversion. 0, or -1. */
static int arg_jwk(Call *c, JSValue v, JWK *j) {
    JSContext *ctx = c->ctx;
    for (int i = 0; i < JWK_COUNT; i++) j->m[i] = JS_UNDEFINED;
    if (js_is_nullish(v)) return 0;
    if (!js_is_object(v))
        return fail(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
                                        "Failed to execute '%s' on 'SubtleCrypto': 2nd argument cannot be converted to a dictionary",
                                        c->op));
    for (int i = 0; i < JWK_COUNT; i++) {
        JSValue m = js_get_value(ctx, v, js_atom_from_cstr(ctx, JWK_NAMES[i]));
        if (js_is_exception(m)) return -1;
        if (js_is_undefined(m)) continue;
        if (i == JWK_EXT) {
            j->m[i] = js_to_boolean(m);
        } else if (i == JWK_KEY_OPS) {
            JSValue method = js_is_object(m) ? js_get_value(ctx, m, JS_SYMBOL(iterator)) : JS_UNDEFINED;
            if (js_is_exception(method)) return -1;
            if (!js_is_callable(method))
                return fail(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
                                                "Failed to execute '%s' on 'SubtleCrypto': key_ops in 2nd argument "
                                                "cannot be converted to sequence.", c->op));
            JSValue ops = js_new_array(ctx, 4), rec = js_iter_start(ctx, m);
            if (js_is_exception(rec)) return -1;
            for (;;) {
                JSValue op = js_iter_next(ctx, rec);
                if (js_is_exception(op)) return -1;
                if (js_is_empty(op)) break;
                JSValue s = js_to_string(ctx, op);
                if (js_is_exception(s) || js_array_append(ctx, ops, s) < 0) return -1;
            }
            j->m[i] = ops;
        } else {
            JSValue s = js_to_string(ctx, m);
            if (js_is_exception(s)) return -1;
            j->m[i] = s;
        }
    }
    return 0;
}

static bool string_is(JSContext *ctx, JSValue s, const char *cstr) {
    if (!js_is_string(s)) return false;
    char buf[64];
    ascii_of(ctx, s, buf, sizeof buf);
    return strcmp(buf, cstr) == 0 && js_string_view(ctx, s).length == strlen(cstr);
}

/* validateKeyOps: no known operation twice, and every usage among them. 0, or -1. */
static int jwk_check_key_ops(JSContext *ctx, JSValue key_ops, JSValue usages) {
    if (js_is_undefined(key_ops)) return 0;
    uint32_t n = js_array_length(js_as_object(key_ops));
    uint32_t seen = 0;
    for (uint32_t i = 0; i < n; i++) {
        JSValue op = js_get_elem(ctx, key_ops, js_int32((int32_t)i));
        for (int k = 0; k < 8; k++) {
            if (!string_is(ctx, op, USAGES[k])) continue;
            if (seen & (1u << k)) return fail(dom_error(ctx, "DataError", "Duplicate key operation"));
            seen |= 1u << k;
        }
    }
    uint32_t m = js_array_length(js_as_object(usages));
    for (uint32_t i = 0; i < m; i++) {
        JSValue u = js_get_elem(ctx, usages, js_int32((int32_t)i));
        bool found = false;
        for (uint32_t k = 0; k < n && !found; k++) found = js_string_equals(ctx, js_get_elem(ctx, key_ops, js_int32((int32_t)k)), u);
        if (!found) return fail(dom_error(ctx, "DataError", "Key operations and usage mismatch"));
    }
    return 0;
}

/* ---- Algorithms -------------------------------------------------------------------------------- */

typedef enum Op {
    OP_DIGEST, OP_IMPORT_KEY, OP_GENERATE_KEY, OP_SIGN, OP_VERIFY, OP_DERIVE_BITS, OP_GET_KEY_LENGTH, OP_ENCRYPT, OP_DECRYPT,
    OP_WRAP_KEY, OP_UNWRAP_KEY,
} Op;

/* Parameter dictionaries, and their members (alphabetical, as WebIDL converts them) */
typedef enum Dict {
    DICT_NONE, DICT_HMAC_IMPORT, DICT_HMAC_KEYGEN, DICT_PBKDF2, DICT_HKDF, DICT_AES_CBC, DICT_AES_CTR, DICT_AES_GCM, DICT_AEAD, DICT_AES_KEYGEN,
    DICT_AES_DERIVED, DICT_RSA_HASHED_IMPORT, DICT_RSA_HASHED_KEYGEN, DICT_RSA_PSS, DICT_RSA_OAEP, DICT_EC_IMPORT, DICT_EC_KEYGEN,
    DICT_ECDSA, DICT_ECDH_DERIVE,
} Dict;

typedef enum Member {
    M_ADDITIONAL_DATA, M_COUNTER, M_HASH, M_INFO, M_ITERATIONS, M_IV, M_LABEL, M_LENGTH, M_MODULUS_LENGTH, M_NAMED_CURVE, M_PUBLIC,
    M_PUBLIC_EXPONENT, M_SALT, M_SALT_LENGTH, M_TAG_LENGTH, M_END,
} Member;

static const char *const MEMBER_NAMES[] = {
    "additionalData", "counter", "hash", "info", "iterations", "iv", "label", "length", "modulusLength", "namedCurve", "public",
    "publicExponent", "salt", "saltLength", "tagLength",
};

static const struct {
    const char *name;
    Member      members[4];
    uint8_t     required;    /* bits of the members' positions */
    uint32_t    length_max;  /* the length member's type: unsigned long, unsigned short or octet */
} DICTS[] = {
    [DICT_NONE] = { "Algorithm", { M_END }, 0, 0 },
    [DICT_HMAC_IMPORT] = { "HmacImportParams", { M_HASH, M_LENGTH, M_END }, 1, 4294967295u },
    [DICT_HMAC_KEYGEN] = { "HmacKeyGenParams", { M_HASH, M_LENGTH, M_END }, 1, 4294967295u },
    [DICT_PBKDF2] = { "Pbkdf2Params", { M_HASH, M_ITERATIONS, M_SALT, M_END }, 7, 0 },
    [DICT_HKDF] = { "HkdfParams", { M_HASH, M_INFO, M_SALT, M_END }, 7, 0 },
    [DICT_AES_CBC] = { "AesCbcParams", { M_IV, M_END }, 1, 0 },
    [DICT_AES_CTR] = { "AesCtrParams", { M_COUNTER, M_LENGTH, M_END }, 3, 255 },
    [DICT_AES_GCM] = { "AesGcmParams", { M_ADDITIONAL_DATA, M_IV, M_TAG_LENGTH, M_END }, 2, 0 },
    [DICT_AEAD] = { "AeadParams", { M_ADDITIONAL_DATA, M_IV, M_TAG_LENGTH, M_END }, 2, 0 },
    [DICT_AES_KEYGEN] = { "AesKeyGenParams", { M_LENGTH, M_END }, 1, 65535 },
    [DICT_AES_DERIVED] = { "AesDerivedKeyParams", { M_LENGTH, M_END }, 1, 65535 },
    [DICT_RSA_HASHED_IMPORT] = { "RsaHashedImportParams", { M_HASH, M_END }, 1, 0 },
    [DICT_RSA_HASHED_KEYGEN] = { "RsaHashedKeyGenParams", { M_HASH, M_MODULUS_LENGTH, M_PUBLIC_EXPONENT, M_END }, 7, 0 },
    [DICT_RSA_PSS] = { "RsaPssParams", { M_SALT_LENGTH, M_END }, 1, 0 },
    [DICT_RSA_OAEP] = { "RsaOaepParams", { M_LABEL, M_END }, 0, 0 },
    [DICT_EC_IMPORT] = { "EcKeyImportParams", { M_NAMED_CURVE, M_END }, 1, 0 },
    [DICT_EC_KEYGEN] = { "EcKeyGenParams", { M_NAMED_CURVE, M_END }, 1, 0 },
    [DICT_ECDSA] = { "EcdsaParams", { M_HASH, M_END }, 1, 0 },
    [DICT_ECDH_DERIVE] = { "EcdhKeyDeriveParams", { M_PUBLIC, M_END }, 1, 0 },
};

#define BIT(op) (1u << (op))
#define AES_OPS BIT(OP_IMPORT_KEY) | BIT(OP_GENERATE_KEY) | BIT(OP_ENCRYPT) | BIT(OP_DECRYPT) | BIT(OP_GET_KEY_LENGTH)
#define AES_DICTS(params) { [OP_ENCRYPT] = params, [OP_DECRYPT] = params, [OP_GENERATE_KEY] = DICT_AES_KEYGEN, [OP_GET_KEY_LENGTH] = DICT_AES_DERIVED }
#define KEY_OPS BIT(OP_IMPORT_KEY) | BIT(OP_GENERATE_KEY)

static const struct {
    const char *name;
    uint8_t     alg;   /* JSWebAlg */
    uint32_t    ops;   /* BIT(op) of the operations it supports */
    uint8_t     dict[OP_UNWRAP_KEY + 1];
} REGISTRY[] = {
    { "HMAC", JS_WEB_HMAC, BIT(OP_IMPORT_KEY) | BIT(OP_GENERATE_KEY) | BIT(OP_SIGN) | BIT(OP_VERIFY) | BIT(OP_GET_KEY_LENGTH),
      { [OP_IMPORT_KEY] = DICT_HMAC_IMPORT, [OP_GENERATE_KEY] = DICT_HMAC_KEYGEN, [OP_GET_KEY_LENGTH] = DICT_HMAC_IMPORT } },
    { "PBKDF2", JS_WEB_PBKDF2, BIT(OP_IMPORT_KEY) | BIT(OP_DERIVE_BITS) | BIT(OP_GET_KEY_LENGTH), { [OP_DERIVE_BITS] = DICT_PBKDF2 } },
    { "HKDF", JS_WEB_HKDF, BIT(OP_IMPORT_KEY) | BIT(OP_DERIVE_BITS) | BIT(OP_GET_KEY_LENGTH), { [OP_DERIVE_BITS] = DICT_HKDF } },
    { "AES-CTR", JS_WEB_AES_CTR, AES_OPS, AES_DICTS(DICT_AES_CTR) },
    { "AES-CBC", JS_WEB_AES_CBC, AES_OPS, AES_DICTS(DICT_AES_CBC) },
    { "AES-GCM", JS_WEB_AES_GCM, AES_OPS, AES_DICTS(DICT_AES_GCM) },
    { "AES-KW", JS_WEB_AES_KW, BIT(OP_IMPORT_KEY) | BIT(OP_GENERATE_KEY) | BIT(OP_WRAP_KEY) | BIT(OP_UNWRAP_KEY) | BIT(OP_GET_KEY_LENGTH),
      { [OP_GENERATE_KEY] = DICT_AES_KEYGEN, [OP_GET_KEY_LENGTH] = DICT_AES_DERIVED } },
    { "RSASSA-PKCS1-v1_5", JS_WEB_RSASSA, KEY_OPS | BIT(OP_SIGN) | BIT(OP_VERIFY),
      { [OP_IMPORT_KEY] = DICT_RSA_HASHED_IMPORT, [OP_GENERATE_KEY] = DICT_RSA_HASHED_KEYGEN } },
    { "RSA-PSS", JS_WEB_RSA_PSS, KEY_OPS | BIT(OP_SIGN) | BIT(OP_VERIFY),
      { [OP_IMPORT_KEY] = DICT_RSA_HASHED_IMPORT, [OP_GENERATE_KEY] = DICT_RSA_HASHED_KEYGEN, [OP_SIGN] = DICT_RSA_PSS, [OP_VERIFY] = DICT_RSA_PSS } },
    { "RSA-OAEP", JS_WEB_RSA_OAEP, KEY_OPS | BIT(OP_ENCRYPT) | BIT(OP_DECRYPT),
      { [OP_IMPORT_KEY] = DICT_RSA_HASHED_IMPORT, [OP_GENERATE_KEY] = DICT_RSA_HASHED_KEYGEN, [OP_ENCRYPT] = DICT_RSA_OAEP, [OP_DECRYPT] = DICT_RSA_OAEP } },
    { "ECDSA", JS_WEB_ECDSA, KEY_OPS | BIT(OP_SIGN) | BIT(OP_VERIFY),
      { [OP_IMPORT_KEY] = DICT_EC_IMPORT, [OP_GENERATE_KEY] = DICT_EC_KEYGEN, [OP_SIGN] = DICT_ECDSA, [OP_VERIFY] = DICT_ECDSA } },
    { "ECDH", JS_WEB_ECDH, KEY_OPS | BIT(OP_DERIVE_BITS),
      { [OP_IMPORT_KEY] = DICT_EC_IMPORT, [OP_GENERATE_KEY] = DICT_EC_KEYGEN, [OP_DERIVE_BITS] = DICT_ECDH_DERIVE } },
    { "X25519", JS_WEB_X25519, KEY_OPS | BIT(OP_DERIVE_BITS), { [OP_DERIVE_BITS] = DICT_ECDH_DERIVE } },
    { "Ed25519", JS_WEB_ED25519, KEY_OPS | BIT(OP_SIGN) | BIT(OP_VERIFY), { 0 } },
    { "ChaCha20-Poly1305", JS_WEB_CHACHA20_POLY1305, BIT(OP_IMPORT_KEY) | BIT(OP_GENERATE_KEY) | BIT(OP_ENCRYPT) | BIT(OP_DECRYPT),
      { [OP_ENCRYPT] = DICT_AEAD, [OP_DECRYPT] = DICT_AEAD } },
};

/* A normalized algorithm: its registry entry and the members its dictionary has. */
typedef struct Params {
    int              entry;  /* REGISTRY index; -1 for a digest */
    const char      *name;   /* the registered name */
    const JSHashAlg *hash;   /* a digest's own algorithm, or the hash member */
    bool             has_length, has_tag_length, has_additional_data, has_label;
    uint32_t         length;
    uint32_t         iterations;
    uint32_t         tag_length;
    uint32_t         modulus_length, salt_length;
    char             named_curve[16];  /* "" when it's too long to be one */
    JSCryptoKey     *public_key;       /* ECDH's and X25519's public */
    Bytes            salt, info, iv, counter, additional_data, label, public_exponent;
} Params;

static void params_free(Params *p) {
    bytes_free(&p->salt);
    bytes_free(&p->info);
    bytes_free(&p->iv);
    bytes_free(&p->counter);
    bytes_free(&p->additional_data);
    bytes_free(&p->label);
    bytes_free(&p->public_exponent);
}

static uint8_t params_alg(const Params *p) { return REGISTRY[p->entry].alg; }

static JSValue throw_member(JSContext *ctx, const char *code, Dict d, Member m, const char *what) {
    (void)d;  /* Node 24 names only the member */
    return js_throw_node_error(ctx, JS_TYPE_ERROR, code, "Failed to normalize algorithm: %s in passed algorithm %s",
                               MEMBER_NAMES[m], what);
}

/* An [EnforceRange] integer member of at most `max`. 0, or -1. */
static int member_uint(JSContext *ctx, JSValue v, Dict d, Member m, uint32_t max, uint32_t *out) {
    double x;
    if (js_to_number(ctx, &x, v) < 0) return -1;
    if (!isfinite(x)) return fail(throw_member(ctx, "ERR_INVALID_ARG_TYPE", d, m, "is not a finite number."));
    x = trunc(x);
    if (x < 0 || x > (double)max) {
        char what[64];
        snprintf(what, sizeof what, "is outside the expected range of 0 to %u.", max);
        return fail(throw_member(ctx, "ERR_OUT_OF_RANGE", d, m, what));
    }
    *out = (uint32_t)x;
    return 0;
}

/* The name of an AlgorithmIdentifier (an object's `name`, or the string), ASCII. 0, or -1. */
static int algorithm_name(JSContext *ctx, JSValue alg, char *name, size_t cap) {
    JSValue n = alg;
    if (js_is_object(alg)) {
        n = js_get_value(ctx, alg, JS_ATOM(name));
        if (js_is_exception(n)) return -1;
        if (js_is_undefined(n))
            return fail(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_OPTION",
                                            "Failed to normalize algorithm: passed algorithm cannot be converted to 'Algorithm' "
                                            "because 'name' is required in 'Algorithm'."));
    }
    JSValue s = js_to_string(ctx, n);
    if (js_is_exception(s)) return -1;
    ascii_of(ctx, s, name, cap);
    return 0;
}

static int normalize_digest(JSContext *ctx, JSValue alg, const JSHashAlg **out) {
    char name[32];
    if (algorithm_name(ctx, alg, name, sizeof name) < 0) return -1;
    *out = js_hash_by_web_name(name);
    return *out ? 0 : fail(dom_error(ctx, "NotSupportedError", "Unrecognized algorithm name"));
}

/* normalizeAlgorithm(alg, op): 0, or -1 (the Params own copies of their bytes either way). */
static int normalize(JSContext *ctx, JSValue alg, Op op, Params *p) {
    memset(p, 0, sizeof *p);
    p->entry = -1;
    if (op == OP_DIGEST) return normalize_digest(ctx, alg, &p->hash);
    char name[32];
    if (algorithm_name(ctx, alg, name, sizeof name) < 0) return -1;
    for (size_t i = 0; i < JS_COUNTOF(REGISTRY); i++)
        if ((REGISTRY[i].ops & BIT(op)) && same_ci(name, REGISTRY[i].name)) p->entry = (int)i;
    if (p->entry < 0) return fail(dom_error(ctx, "NotSupportedError", "Unrecognized algorithm name"));
    p->name = REGISTRY[p->entry].name;
    Dict d = (Dict)REGISTRY[p->entry].dict[op];
    JSValue hash = JS_UNDEFINED;
    for (int i = 0; DICTS[d].members[i] != M_END; i++) {
        Member m = DICTS[d].members[i];
        JSValue v = js_is_object(alg) ? js_get_value(ctx, alg, js_atom_from_cstr(ctx, MEMBER_NAMES[m])) : JS_UNDEFINED;
        if (js_is_exception(v)) return -1;
        if (js_is_undefined(v)) {
            if (DICTS[d].required & (1u << i))
                return fail(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_OPTION",
                                                "Failed to normalize algorithm: passed algorithm cannot be converted to '%s' "
                                                "because '%s' is required in '%s'.", DICTS[d].name, MEMBER_NAMES[m], DICTS[d].name));
            continue;
        }
        switch (m) {
        case M_HASH:
            if (js_is_symbol(v)) return fail(throw_member(ctx, "ERR_INVALID_ARG_TYPE", d, m, "is not of type object or string."));
            if (!js_is_object(v)) {
                v = js_to_string(ctx, v);
                if (js_is_exception(v)) return -1;
            }
            hash = v;
            break;
        case M_LENGTH:
            if (member_uint(ctx, v, d, m, DICTS[d].length_max, &p->length) < 0) return -1;
            p->has_length = true;
            break;
        case M_ITERATIONS:
            if (member_uint(ctx, v, d, m, 4294967295u, &p->iterations) < 0) return -1;
            break;
        case M_MODULUS_LENGTH:
            if (member_uint(ctx, v, d, m, 4294967295u, &p->modulus_length) < 0) return -1;
            break;
        case M_SALT_LENGTH:
            if (member_uint(ctx, v, d, m, 4294967295u, &p->salt_length) < 0) return -1;
            break;
        case M_TAG_LENGTH:
            if (member_uint(ctx, v, d, m, 255, &p->tag_length) < 0) return -1;
            p->has_tag_length = true;
            break;
        case M_NAMED_CURVE: {
            JSValue s = js_to_string(ctx, v);
            if (js_is_exception(s)) return -1;
            ascii_of(ctx, s, p->named_curve, sizeof p->named_curve);
            break;
        }
        case M_PUBLIC:
            p->public_key = js_as_crypto_key(v);
            if (!p->public_key) return fail(throw_member(ctx, "ERR_INVALID_ARG_TYPE", d, m, "is not of type CryptoKey."));
            break;
        case M_PUBLIC_EXPONENT:
            if (js_typed_array_type(v) != JS_TA_UINT8) return fail(throw_member(ctx, "ERR_INVALID_ARG_TYPE", d, m, "is not an Uint8Array object."));
            bytes_copy(&p->public_exponent, v);
            break;
        case M_SALT:
        case M_INFO:
        case M_IV:
        case M_COUNTER:
        case M_LABEL:
        case M_ADDITIONAL_DATA: {
            uint8_t *bp;
            size_t bn;
            if (!js_buffer_source_bytes(v, &bp, &bn))
                return fail(throw_member(ctx, "ERR_INVALID_ARG_TYPE", d, m, "is not instance of ArrayBuffer, Buffer, TypedArray, or DataView."));
            Bytes *slot = m == M_SALT ? &p->salt : m == M_INFO ? &p->info : m == M_IV ? &p->iv : m == M_COUNTER ? &p->counter
                        : m == M_LABEL ? &p->label : &p->additional_data;
            bytes_copy(slot, v);
            if (m == M_ADDITIONAL_DATA) p->has_additional_data = true;
            if (m == M_LABEL) p->has_label = true;
            break;
        }
        case M_END:
            break;
        }
    }
    if (!js_is_undefined(hash) && normalize_digest(ctx, hash, &p->hash) < 0) return -1;
    return 0;
}

/* The `algorithm` of a key: { name: 'SHA-256' } for a hash */
static JSValue hash_object(JSContext *ctx, const JSHashAlg *hash) {
    JSValue o = js_new_object(ctx);
    put(ctx, o, "name", str(ctx, hash->web));
    return o;
}

/* ---- Keys -------------------------------------------------------------------------------------- */

static bool has_any_not_in(uint16_t mask, uint16_t allowed) { return (mask & ~allowed) != 0; }

/* HMAC: the key's object, as Node 24 orders it: { name, length, hash } */
static JSValue hmac_algorithm(JSContext *ctx, const JSHashAlg *hash, uint32_t length) {
    JSValue o = js_new_object(ctx);
    put(ctx, o, "name", str(ctx, "HMAC"));
    put(ctx, o, "length", js_number(length));
    put(ctx, o, "hash", hash_object(ctx, hash));
    return o;
}

static JSValue import_hmac(JSContext *ctx, int format, JSValue key_data, const JWK *jwk, Params *p, bool extractable, JSValue usages,
                           uint16_t mask) {
    /* HmacImportParams' normalization comes first */
    if (p->has_length && p->length == 0) return dom_error(ctx, "DataError", "HmacImportParams.length cannot be 0");
    if (has_any_not_in(mask, JS_USAGE_SIGN | JS_USAGE_VERIFY)) return dom_error(ctx, "SyntaxError", "Unsupported key usage for HMAC key");
    Bytes raw = { 0 };
    if (format == FORMAT_RAW) {
        bytes_copy(&raw, key_data);
    } else if (format == FORMAT_JWK) {
        if (js_is_undefined(jwk->m[JWK_KTY]) || string_is(ctx, jwk->m[JWK_KTY], "")) return dom_error(ctx, "DataError", "Invalid keyData");
        if (!string_is(ctx, jwk->m[JWK_KTY], "oct")) return dom_error(ctx, "DataError", "Invalid JWK \"kty\" Parameter");
        if (mask && !js_is_undefined(jwk->m[JWK_USE]) && !string_is(ctx, jwk->m[JWK_USE], "sig")) return dom_error(ctx, "DataError", "Invalid JWK \"use\" Parameter");
        if (jwk_check_key_ops(ctx, jwk->m[JWK_KEY_OPS], usages) < 0) return JS_EXCEPTION;
        if (js_is_bool(jwk->m[JWK_EXT]) && !js_as_bool(jwk->m[JWK_EXT]) && extractable)
            return dom_error(ctx, "DataError", "JWK \"ext\" Parameter and extractable mismatch");
        if (js_is_undefined(jwk->m[JWK_K])) return dom_error(ctx, "DataError", "Invalid keyData");
        base64url_decode(ctx, jwk->m[JWK_K], &raw);
        if (!js_is_undefined(jwk->m[JWK_ALG])) {
            char expected[8];
            snprintf(expected, sizeof expected, "HS%s", p->hash->web + 4);
            if (!string_is(ctx, jwk->m[JWK_ALG], expected)) {
                bytes_free(&raw);
                return dom_error(ctx, "DataError", "JWK \"alg\" does not match the requested algorithm");
            }
        }
    } else {
        char m[64];
        snprintf(m, sizeof m, "Unable to import HMAC using %s format", FORMATS[format]);
        return dom_error(ctx, "NotSupportedError", m);
    }
    uint32_t length = (uint32_t)raw.n * 8;
    if (length == 0) {
        bytes_free(&raw);
        return dom_error(ctx, "DataError", "Zero-length key is not supported");
    }
    if (p->has_length) {  /* in whole bytes the key's; past a byte boundary, the key cut to that many bits */
        if ((p->length + 7) / 8 != raw.n) {
            bytes_free(&raw);
            return dom_error(ctx, "DataError", "Invalid key length");
        }
        if (p->length % 8) raw.p[raw.n - 1] &= (uint8_t)(0xFF << (8 - p->length % 8));
        length = p->length;
    }
    JSValue data = js_new_secret_key(ctx, raw.p, raw.n);
    bytes_free(&raw);
    return js_new_crypto_key(ctx, data, JS_WEB_HMAC, p->hash, length, hmac_algorithm(ctx, p->hash, length), usages, mask,
                             extractable);
}

/* PBKDF2 and HKDF keys: raw secrets, never extractable */
static JSValue import_generic_secret(JSContext *ctx, int format, JSValue key_data, Params *p, bool extractable, JSValue usages,
                                     uint16_t mask) {
    char m[64];
    if (extractable) {
        snprintf(m, sizeof m, "%s keys are not extractable", p->name);
        return dom_error(ctx, "SyntaxError", m);
    }
    if (has_any_not_in(mask, JS_USAGE_DERIVE_KEY | JS_USAGE_DERIVE_BITS)) {
        snprintf(m, sizeof m, "Unsupported key usage for a %s key", p->name);
        return dom_error(ctx, "SyntaxError", m);
    }
    if (format != FORMAT_RAW) {
        snprintf(m, sizeof m, "Unable to import %s using %s format", p->name, FORMATS[format]);
        return dom_error(ctx, "NotSupportedError", m);
    }
    Bytes raw;
    bytes_copy(&raw, key_data);
    JSValue data = js_new_secret_key(ctx, raw.p, raw.n);
    bytes_free(&raw);
    JSValue alg = js_new_object(ctx);
    put(ctx, alg, "name", str(ctx, p->name));
    return js_new_crypto_key(ctx, data, REGISTRY[p->entry].alg, NULL, 0, alg, usages, mask, false);
}

static const char *web_alg_name(uint8_t alg) {
    for (size_t i = 0; i < JS_COUNTOF(REGISTRY); i++)
        if (REGISTRY[i].alg == alg) return REGISTRY[i].name;
    return "";
}

static bool is_aes(uint8_t alg) { return alg >= JS_WEB_AES_CTR && alg <= JS_WEB_AES_KW; }

/* A JWK's `alg` for a secret key: HS256, A128GCM, … */
static void jwk_alg(uint8_t alg, const JSHashAlg *hash, uint32_t length, char *out, size_t cap) {
    if (alg == JS_WEB_HMAC) snprintf(out, cap, "HS%s", hash->web + 4);
    else if (alg == JS_WEB_CHACHA20_POLY1305) snprintf(out, cap, "C20P");
    else snprintf(out, cap, "A%u%s", length, web_alg_name(alg) + 4);
}

static uint16_t aes_usages(uint8_t alg) {
    return (uint16_t)(JS_USAGE_WRAP_KEY | JS_USAGE_UNWRAP_KEY | (alg == JS_WEB_AES_KW ? 0 : JS_USAGE_ENCRYPT | JS_USAGE_DECRYPT));
}

static JSValue aes_algorithm(JSContext *ctx, const char *name, uint32_t length) {
    JSValue o = js_new_object(ctx);
    put(ctx, o, "name", str(ctx, name));
    put(ctx, o, "length", js_number(length));
    return o;
}

/* a secret key's algorithm object: { name, length } for AES; ChaCha20-Poly1305's, { name } */
static JSValue secret_algorithm(JSContext *ctx, uint8_t alg, const char *name, uint32_t length) {
    if (alg != JS_WEB_CHACHA20_POLY1305) return aes_algorithm(ctx, name, length);
    JSValue a = js_new_object(ctx);
    put(ctx, a, "name", str(ctx, name));
    return a;
}

static JSValue import_aes(JSContext *ctx, int format, JSValue key_data, const JWK *jwk, Params *p, bool extractable, JSValue usages,
                          uint16_t mask) {
    uint8_t alg = params_alg(p);
    if (has_any_not_in(mask, aes_usages(alg))) return usage_error(ctx, p->name);
    Bytes raw = { 0 };
    if (format == FORMAT_RAW) {
        bytes_copy(&raw, key_data);
    } else if (format == FORMAT_JWK) {
        if (js_is_undefined(jwk->m[JWK_KTY]) || string_is(ctx, jwk->m[JWK_KTY], "")) return dom_error(ctx, "DataError", "Invalid keyData");
        if (!string_is(ctx, jwk->m[JWK_KTY], "oct")) return dom_error(ctx, "DataError", "Invalid JWK \"kty\" Parameter");
        if (mask && !js_is_undefined(jwk->m[JWK_USE]) && !string_is(ctx, jwk->m[JWK_USE], "enc")) return dom_error(ctx, "DataError", "Invalid JWK \"use\" Parameter");
        if (jwk_check_key_ops(ctx, jwk->m[JWK_KEY_OPS], usages) < 0) return JS_EXCEPTION;
        if (js_is_bool(jwk->m[JWK_EXT]) && !js_as_bool(jwk->m[JWK_EXT]) && extractable)
            return dom_error(ctx, "DataError", "JWK \"ext\" Parameter and extractable mismatch");
        if (js_is_undefined(jwk->m[JWK_K])) return dom_error(ctx, "DataError", "Invalid keyData");
        base64url_decode(ctx, jwk->m[JWK_K], &raw);
    } else {
        char m[64];
        snprintf(m, sizeof m, "Unable to import AES key with format %s", FORMATS[format]);
        return dom_error(ctx, "NotSupportedError", m);
    }
    uint32_t length = (uint32_t)raw.n * 8;
    if (alg == JS_WEB_CHACHA20_POLY1305 ? length != 256 : length != 128 && length != 192 && length != 256) {
        bytes_free(&raw);
        return dom_error(ctx, "DataError", "Invalid key length");
    }
    if (format == FORMAT_JWK && !js_is_undefined(jwk->m[JWK_ALG])) {
        char expected[16];
        jwk_alg(alg, NULL, length, expected, sizeof expected);
        if (!string_is(ctx, jwk->m[JWK_ALG], expected)) {
            bytes_free(&raw);
            return dom_error(ctx, "DataError", "JWK \"alg\" does not match the requested algorithm");
        }
    }
    JSValue data = js_new_secret_key(ctx, raw.p, raw.n);
    bytes_free(&raw);
    return js_new_crypto_key(ctx, data, alg, NULL, length, secret_algorithm(ctx, alg, p->name, length), usages, mask, extractable);
}

/* ---- Asymmetric keys: RSA, EC, X25519 and Ed25519 ------------------------------------------------- */

static bool is_rsa_alg(uint8_t a) { return a == JS_WEB_RSASSA || a == JS_WEB_RSA_PSS || a == JS_WEB_RSA_OAEP; }
static bool is_asym_alg(uint8_t a) { return a >= JS_WEB_RSASSA && a <= JS_WEB_ED25519; }
/* the OKP algorithms (RFC 8037): a curve of their own, 32-byte keys */
static bool is_okp_alg(uint8_t a) { return a == JS_WEB_X25519 || a == JS_WEB_ED25519; }
static int okp_kind(uint8_t a) { return a == JS_WEB_X25519 ? JS_ASYM_X25519 : JS_ASYM_ED25519; }
static int okp_curve(uint8_t a) { return a == JS_WEB_X25519 ? JS_EC_X25519 : JS_EC_ED25519; }

static size_t bits_of(const JSKeyPart *n) {
    size_t i = 0;
    while (i < n->n && n->p[i] == 0) i++;
    if (i == n->n) return 0;
    size_t bits = (n->n - i - 1) * 8;
    for (uint8_t top = n->p[i]; top; top >>= 1) bits++;
    return bits;
}

/* { name, modulusLength, publicExponent, hash } */
static JSValue rsa_algorithm(JSContext *ctx, const char *name, const JSKeyData *d, const JSHashAlg *hash) {
    JSValue o = js_new_object(ctx);
    put(ctx, o, "name", str(ctx, name));
    put(ctx, o, "modulusLength", js_number((double)bits_of(&d->part[JS_RSA_N])));
    JSValue e = js_new_uint8_array(ctx, d->part[JS_RSA_E].n);
    uint8_t *p;
    size_t n;
    js_buffer_source_bytes(e, &p, &n);
    memcpy(p, d->part[JS_RSA_E].p, n);
    put(ctx, o, "publicExponent", e);
    put(ctx, o, "hash", hash_object(ctx, hash));
    return o;
}

static JSValue ec_algorithm(JSContext *ctx, const char *name, int curve) {
    JSValue o = js_new_object(ctx);
    put(ctx, o, "name", str(ctx, name));
    if (curve != JS_EC_X25519 && curve != JS_EC_ED25519) put(ctx, o, "namedCurve", str(ctx, js_ec_curve_jwk(curve)));
    return o;
}

/* The CryptoKey of a key handle, its algorithm object made from the key. */
static JSValue asym_crypto_key(JSContext *ctx, JSValue data, uint8_t alg, const char *name, const JSHashAlg *hash, JSValue usages,
                               uint16_t mask, bool extractable) {
    JSKeyData *d = js_key_data(data);
    if (is_rsa_alg(alg))
        return js_new_crypto_key(ctx, data, alg, hash, (uint32_t)bits_of(&d->part[JS_RSA_N]), rsa_algorithm(ctx, name, d, hash), usages, mask,
                                 extractable);
    return js_new_crypto_key(ctx, data, alg, NULL, 0, ec_algorithm(ctx, name, d->curve), usages, mask, extractable);
}

/* The usages a public or private key of an algorithm may have */
static uint16_t asym_usages(uint8_t alg, bool is_public) {
    switch (alg) {
    case JS_WEB_RSA_OAEP: return is_public ? JS_USAGE_ENCRYPT | JS_USAGE_WRAP_KEY : JS_USAGE_DECRYPT | JS_USAGE_UNWRAP_KEY;
    case JS_WEB_ECDH:
    case JS_WEB_X25519: return is_public ? 0 : JS_USAGE_DERIVE_KEY | JS_USAGE_DERIVE_BITS;
    default: return is_public ? JS_USAGE_VERIFY : JS_USAGE_SIGN;
    }
}

/* A JWK's alg for an RSA key: RS256, PS384, RSA-OAEP-256 (RSA-OAEP for SHA-1) */
static void rsa_jwk_alg(uint8_t alg, const JSHashAlg *hash, char *out, size_t cap) {
    const char *bits = hash->web + 4;  /* "1", "256", … */
    if (alg == JS_WEB_RSA_OAEP) {
        if (strcmp(bits, "1") == 0) snprintf(out, cap, "RSA-OAEP");
        else snprintf(out, cap, "RSA-OAEP-%s", bits);
    } else {
        snprintf(out, cap, "%s%s", alg == JS_WEB_RSASSA ? "RS" : "PS", bits);
    }
}

/* A JWK's parts, base64url-decoded into the key record's order. False when one is missing. */
static bool jwk_parts(JSContext *ctx, const JWK *jwk, const int *names, int count, JSKeyPart *parts, Bytes *owned) {
    for (int i = 0; i < count; i++) {
        if (names[i] < 0) continue;
        JSValue v = jwk->m[names[i]];
        if (!js_is_string(v)) return false;
        base64url_decode(ctx, v, &owned[i]);
        parts[i].p = owned[i].p;
        parts[i].n = owned[i].n;
    }
    return true;
}

static JSValue import_asym(JSContext *ctx, int format, JSValue key_data, const JWK *jwk, Params *p, bool extractable, JSValue usages,
                           uint16_t mask) {
    uint8_t alg = params_alg(p);
    const char *name = p->name;
    char m[96];
    int curve = -1;
    if (alg == JS_WEB_ECDSA || alg == JS_WEB_ECDH) {
        curve = js_ec_curve_by_jwk(p->named_curve);
        if (curve < 0) return dom_error(ctx, "NotSupportedError", "Unrecognized namedCurve");
    }
    if (is_rsa_alg(alg) && format == FORMAT_RAW) {
        snprintf(m, sizeof m, "Unable to import %s using raw format", name);
        return dom_error(ctx, "NotSupportedError", m);
    }
    bool is_public = format == FORMAT_SPKI || format == FORMAT_RAW || (format == FORMAT_JWK && js_is_undefined(jwk->m[JWK_D]));
    if (has_any_not_in(mask, asym_usages(alg, is_public))) {
        return usage_error(ctx, name);
    }
    JSValue data = JS_UNDEFINED;
    if (format == FORMAT_SPKI || format == FORMAT_PKCS8) {
        uint8_t *bp;
        size_t bn;
        js_buffer_source_bytes(key_data, &bp, &bn);
        if (js_key_parse_der(ctx, bp, bn, format == FORMAT_SPKI ? JS_KEY_ENC_SPKI : JS_KEY_ENC_PKCS8, format == FORMAT_PKCS8, &data))
            return dom_error(ctx, "DataError", "Invalid keyData");
    } else if (format == FORMAT_RAW) {
        uint8_t *bp, point[133];
        size_t bn;
        js_buffer_source_bytes(key_data, &bp, &bn);
        JSKeyPart parts[JS_KEY_PARTS] = { { 0 } };
        if (is_okp_alg(alg)) {
            if (bn != 32) return dom_error(ctx, "DataError", "Invalid keyData");
            parts[JS_EC_PUB].p = bp, parts[JS_EC_PUB].n = 32;
        } else {
            if (!js_ec_point_uncompressed(curve, bp, bn, point)) return dom_error(ctx, "DataError", "Invalid keyData");
            parts[JS_EC_PUB].p = point, parts[JS_EC_PUB].n = 1 + 2 * js_ec_field_size(curve);
        }
        if (js_key_from_parts(ctx, is_okp_alg(alg) ? okp_kind(alg) : JS_ASYM_EC, false, curve, parts, &data))
            return dom_error(ctx, "DataError", "Invalid keyData");
    } else { /* jwk */
        const char *want_kty = is_rsa_alg(alg) ? "RSA" : is_okp_alg(alg) ? "OKP" : "EC";
        if (js_is_undefined(jwk->m[JWK_KTY]) || string_is(ctx, jwk->m[JWK_KTY], "")) return dom_error(ctx, "DataError", "Invalid keyData");
        if (!string_is(ctx, jwk->m[JWK_KTY], want_kty)) return dom_error(ctx, "DataError", "Invalid JWK \"kty\" Parameter");
        if (is_okp_alg(alg) && !string_is(ctx, jwk->m[JWK_CRV], name))
            return dom_error(ctx, "DataError", "JWK \"crv\" Parameter and algorithm name mismatch");
        if ((alg == JS_WEB_ECDSA || alg == JS_WEB_ECDH) && !string_is(ctx, jwk->m[JWK_CRV], p->named_curve))
            return dom_error(ctx, "DataError", "JWK \"crv\" does not match the requested algorithm");
        const char *want_use = alg == JS_WEB_RSA_OAEP || alg == JS_WEB_ECDH || alg == JS_WEB_X25519 ? "enc" : "sig";
        if (mask && !js_is_undefined(jwk->m[JWK_USE]) && !string_is(ctx, jwk->m[JWK_USE], want_use))
            return dom_error(ctx, "DataError", "Invalid JWK \"use\" Parameter");
        if (jwk_check_key_ops(ctx, jwk->m[JWK_KEY_OPS], usages) < 0) return JS_EXCEPTION;
        if (js_is_bool(jwk->m[JWK_EXT]) && !js_as_bool(jwk->m[JWK_EXT]) && extractable)
            return dom_error(ctx, "DataError", "JWK \"ext\" Parameter and extractable mismatch");
        if (!js_is_undefined(jwk->m[JWK_ALG]) && (is_rsa_alg(alg) || alg == JS_WEB_ECDSA)) {
            char expected[24];
            if (is_rsa_alg(alg)) rsa_jwk_alg(alg, p->hash, expected, sizeof expected);
            else snprintf(expected, sizeof expected, "ES%s", curve == JS_EC_P256 ? "256" : curve == JS_EC_P384 ? "384" : "512");
            if (!string_is(ctx, jwk->m[JWK_ALG], expected)) return dom_error(ctx, "DataError", "JWK \"alg\" does not match the requested algorithm");
        }
        JSKeyPart parts[JS_KEY_PARTS] = { { 0 } };
        Bytes owned[JS_KEY_PARTS] = { { 0 } };
        bool ok;
        int kind;
        if (is_rsa_alg(alg)) {
            static const int rsa_names[] = { JWK_N, JWK_E, JWK_D, JWK_P, JWK_Q, JWK_DP, JWK_DQ, JWK_QI };
            ok = jwk_parts(ctx, jwk, rsa_names, is_public ? 2 : 8, parts, owned);
            kind = JS_ASYM_RSA;
        } else if (is_okp_alg(alg)) {
            int names[] = { JWK_X, is_public ? -1 : JWK_D };
            ok = jwk_parts(ctx, jwk, names, 2, parts, owned) && parts[0].n == 32 && (is_public || parts[1].n == 32);
            kind = okp_kind(alg);
        } else {
            int names[] = { JWK_X, is_public ? -1 : JWK_D, JWK_Y };
            ok = jwk_parts(ctx, jwk, names, 3, parts, owned);
            size_t fs = js_ec_field_size(curve);
            uint8_t point[133];
            if (ok && parts[0].n == fs && parts[2].n == fs) {
                point[0] = 4;
                memcpy(point + 1, parts[0].p, fs);
                memcpy(point + 1 + fs, parts[2].p, fs);
                bytes_free(&owned[0]);
                owned[0].p = malloc(1 + 2 * fs);
                if (!owned[0].p) js_fatal("out of memory in crypto");
                memcpy(owned[0].p, point, 1 + 2 * fs);
                parts[0].p = owned[0].p, parts[0].n = 1 + 2 * fs;
                parts[2].p = NULL, parts[2].n = 0;
            } else {
                ok = false;
            }
            kind = JS_ASYM_EC;
        }
        int e = ok ? js_key_from_parts(ctx, kind, !is_public, curve, parts, &data) : 1;
        for (int i = 0; i < JS_KEY_PARTS; i++) bytes_free(&owned[i]);
        if (e) return dom_error(ctx, "DataError", "Invalid JWK");
    }
    JSKeyData *d = js_key_data(data);
    uint8_t want_kind = is_rsa_alg(alg) ? JS_ASYM_RSA : is_okp_alg(alg) ? okp_kind(alg) : JS_ASYM_EC;
    if (d->kind != want_kind) return dom_error(ctx, "DataError", "Invalid key type");
    if (want_kind == JS_ASYM_EC && d->curve != curve) return dom_error(ctx, "DataError", "Named curve mismatch");
    return asym_crypto_key(ctx, data, alg, name, p->hash, usages, mask, extractable);
}

static JSValue export_asym(JSContext *ctx, int format, JSCryptoKey *k) {
    JSKeyData *d = js_key_data(k->data);
    const char *name = web_alg_name(k->alg), *type = d->type == JS_KEY_PUBLIC ? "public" : "private";
    if ((format == FORMAT_SPKI && d->type == JS_KEY_PUBLIC) || (format == FORMAT_PKCS8 && d->type == JS_KEY_PRIVATE)) {
        JSBytesOut o = { 0 };
        js_key_export_der(d, format == FORMAT_SPKI ? JS_KEY_ENC_SPKI : JS_KEY_ENC_PKCS8, &o);
        JSValue r = array_buffer_of(ctx, o.p, o.n);
        free(o.p);
        return r;
    }
    if (format == FORMAT_RAW && d->type == JS_KEY_PUBLIC && !is_rsa_alg(k->alg))
        return array_buffer_of(ctx, d->part[JS_EC_PUB].p, d->part[JS_EC_PUB].n);
    if (format == FORMAT_JWK) {
        JSValue o = js_new_object(ctx);
        put(ctx, o, "key_ops", k->usages);
        put(ctx, o, "ext", js_bool(k->extractable));
        bool priv = d->type == JS_KEY_PRIVATE;
        if (is_rsa_alg(k->alg)) {
            char alg[24];
            rsa_jwk_alg(k->alg, k->hash, alg, sizeof alg);
            put(ctx, o, "alg", str(ctx, alg));
            put(ctx, o, "kty", str(ctx, "RSA"));
            static const char *const names[] = { "n", "e", "d", "p", "q", "dp", "dq", "qi" };
            for (int i = 0; i < (priv ? 8 : 2); i++) put(ctx, o, names[i], base64url_encode(ctx, d->part[i].p, d->part[i].n));
        } else if (is_okp_alg(k->alg)) {
            if (k->alg == JS_WEB_ED25519) put(ctx, o, "alg", str(ctx, "Ed25519"));
            put(ctx, o, "crv", str(ctx, name));
            if (priv) put(ctx, o, "d", base64url_encode(ctx, d->part[JS_EC_PRIV].p, d->part[JS_EC_PRIV].n));
            put(ctx, o, "x", base64url_encode(ctx, d->part[JS_EC_PUB].p, d->part[JS_EC_PUB].n));
            put(ctx, o, "kty", str(ctx, "OKP"));
        } else {
            size_t fs = js_ec_field_size(d->curve);
            put(ctx, o, "kty", str(ctx, "EC"));
            put(ctx, o, "x", base64url_encode(ctx, d->part[JS_EC_PUB].p + 1, fs));
            put(ctx, o, "y", base64url_encode(ctx, d->part[JS_EC_PUB].p + 1 + fs, fs));
            put(ctx, o, "crv", str(ctx, js_ec_curve_jwk(d->curve)));
            if (priv) put(ctx, o, "d", base64url_encode(ctx, d->part[JS_EC_PRIV].p, d->part[JS_EC_PRIV].n));
        }
        return o;
    }
    char m[96];
    snprintf(m, sizeof m, "Unable to export %s %s key using %s format", name, type, FORMATS[format]);
    return dom_error(ctx, "NotSupportedError", m);
}

/* The usages of a mask among `wanted`, in that order (getUsagesUnion). */
static JSValue usages_union(JSContext *ctx, uint16_t mask, uint16_t wanted, uint16_t *out_mask) {
    JSValue a = js_new_array(ctx, 2);
    *out_mask = 0;
    static const uint16_t ORDER[] = { JS_USAGE_ENCRYPT, JS_USAGE_DECRYPT, JS_USAGE_SIGN, JS_USAGE_VERIFY, JS_USAGE_DERIVE_KEY,
                                      JS_USAGE_DERIVE_BITS, JS_USAGE_WRAP_KEY, JS_USAGE_UNWRAP_KEY };
    for (int i = 0; i < 8; i++)
        if (mask & wanted & ORDER[i]) {
            if (js_array_append(ctx, a, str(ctx, USAGES[i])) < 0) return JS_EXCEPTION;
            *out_mask |= ORDER[i];
        }
    return a;
}

static JSValue generate_asym(JSContext *ctx, Params *p, bool extractable, uint16_t mask) {
    uint8_t alg = params_alg(p);
    const char *name = p->name;
    JSValue priv;
    if (is_rsa_alg(alg)) {
        const uint8_t *e = p->public_exponent.p;
        size_t en = p->public_exponent.n;
        while (en > 0 && e[0] == 0) e++, en--;
        if (en > 4) return dom_error(ctx, "OperationError", "The publicExponent must be equivalent to an unsigned 32-bit value");
        uint32_t exponent = 0;
        for (size_t i = 0; i < en; i++) exponent = exponent << 8 | e[i];
        uint16_t allowed = alg == JS_WEB_RSA_OAEP ? JS_USAGE_ENCRYPT | JS_USAGE_DECRYPT | JS_USAGE_WRAP_KEY | JS_USAGE_UNWRAP_KEY
                                                  : JS_USAGE_SIGN | JS_USAGE_VERIFY;
        if (has_any_not_in(mask, allowed)) return usage_error(ctx, name);
        if (js_key_generate_rsa(ctx, false, p->modulus_length, exponent, &priv)) return op_failed(ctx);
    } else {
        int curve = is_okp_alg(alg) ? okp_curve(alg) : JS_EC_X25519;
        if (!is_okp_alg(alg)) {
            curve = js_ec_curve_by_jwk(p->named_curve);
            if (curve < 0) return dom_error(ctx, "NotSupportedError", "Unrecognized namedCurve");
        }
        if (has_any_not_in(mask, asym_usages(alg, true) | asym_usages(alg, false))) return usage_error(ctx, name);
        if (js_key_generate_ec(ctx, curve, &priv)) return op_failed(ctx);
    }
    uint16_t pub_mask, priv_mask;
    JSValue pub_usages = usages_union(ctx, mask, asym_usages(alg, true), &pub_mask);
    JSValue priv_usages = usages_union(ctx, mask, asym_usages(alg, false), &priv_mask);
    if (js_is_exception(pub_usages) || js_is_exception(priv_usages)) return JS_EXCEPTION;
    if (js_array_length(js_as_object(priv_usages)) == 0) return dom_error(ctx, "SyntaxError", "Usages cannot be empty when creating a key.");
    JSValue pub = js_key_public(ctx, priv);
    JSValue pair = js_new_object(ctx);
    put(ctx, pair, "publicKey", asym_crypto_key(ctx, pub, alg, name, p->hash, pub_usages, pub_mask, true));
    put(ctx, pair, "privateKey", asym_crypto_key(ctx, priv, alg, name, p->hash, priv_usages, priv_mask, extractable));
    return pair;
}

/* A raw-* format as raw for the algorithm it fits (raw-secret: a secret key's; raw-public: an EC,
 * X25519 or Ed25519 public key's), other formats as they are; -1 where it doesn't fit (raw-private
 * and raw-seed are ML-DSA's and ML-KEM's). */
static int raw_alias(int alg, int format) {
    if (format == FORMAT_RAW && alg == JS_WEB_CHACHA20_POLY1305) return -1;  /* Node: raw-secret only */
    if (format < FORMAT_RAW_PUBLIC) return format;
    bool secret = !is_asym_alg(alg);
    if (format == FORMAT_RAW_SECRET && secret) return FORMAT_RAW;
    if (format == FORMAT_RAW_PUBLIC && !secret && alg != JS_WEB_RSASSA && alg != JS_WEB_RSA_PSS && alg != JS_WEB_RSA_OAEP) return FORMAT_RAW;
    return -1;
}

/* importKey's steps after the `this` check, for subtle.importKey and deriveKey. */
static JSValue import_key(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    Call c = { ctx, "importKey" };
    if (argc < 5) return throw_missing_args(&c, 5, argc);
    int format = arg_format(&c, argv[0], 0);
    if (format < 0) return JS_EXCEPTION;
    JWK jwk;
    if (format == FORMAT_JWK ? arg_jwk(&c, argv[1], &jwk) < 0 : arg_buffer_source(&c, argv[1], 1) < 0) return JS_EXCEPTION;
    if (arg_algorithm(&c, argv[2], 2) < 0) return JS_EXCEPTION;
    bool extractable = js_truthy(argv[3]);
    uint16_t mask;
    JSValue usages = arg_usages(&c, ARG(4), 4, &mask);
    if (js_is_exception(usages)) return usages;
    Params p;
    if (normalize(ctx, argv[2], OP_IMPORT_KEY, &p) < 0) {
        params_free(&p);
        return JS_EXCEPTION;
    }
    int raw = raw_alias(REGISTRY[p.entry].alg, format);
    if (raw < 0) {
        char m[96];
        snprintf(m, sizeof m, "Unable to import %s using %s format", p.name, FORMATS[format]);
        params_free(&p);
        return dom_error(ctx, "NotSupportedError", m);
    }
    format = raw;
    JSValue key;
    switch (REGISTRY[p.entry].alg) {
    case JS_WEB_HMAC:
        key = import_hmac(ctx, format, argv[1], &jwk, &p, extractable, usages, mask);
        break;
    case JS_WEB_AES_CTR:
    case JS_WEB_AES_CBC:
    case JS_WEB_AES_GCM:
    case JS_WEB_AES_KW:
    case JS_WEB_CHACHA20_POLY1305:
        key = import_aes(ctx, format, argv[1], &jwk, &p, extractable, usages, mask);
        break;
    case JS_WEB_RSASSA:
    case JS_WEB_RSA_PSS:
    case JS_WEB_RSA_OAEP:
    case JS_WEB_ECDSA:
    case JS_WEB_ECDH:
    case JS_WEB_X25519:
    case JS_WEB_ED25519:
        key = import_asym(ctx, format, argv[1], &jwk, &p, extractable, usages, mask);
        break;
    default:
        key = import_generic_secret(ctx, format, argv[1], &p, extractable, usages, mask);
        break;
    }
    params_free(&p);
    if (js_is_exception(key)) return key;
    JSCryptoKey *k = js_as_crypto_key(key);
    uint8_t type = js_key_data(k->data)->type;
    if (type != JS_KEY_PUBLIC && js_array_length(js_as_object(k->usages)) == 0)
        return dom_error(ctx, "SyntaxError", type == JS_KEY_SECRET ? "Usages cannot be empty when importing a secret key."
                                                                   : "Usages cannot be empty when importing a private key.");
    return key;
}

JSValue js_crypto_import_key_steps(JSContext *ctx, uint32_t argc, const JSValue *argv) { return import_key(ctx, argc, argv); }

BUILTIN(subtle_import_key) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, import_key(ctx, argc, argv));
}

static JSValue export_key(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    Call c = { ctx, "exportKey" };
    if (argc < 2) return throw_missing_args(&c, 2, argc);
    int format = arg_format(&c, argv[0], 0);
    if (format < 0) return JS_EXCEPTION;
    JSCryptoKey *k = arg_key(&c, argv[1], 1);
    if (!k) return JS_EXCEPTION;
    char m[96];
    if (k->alg == JS_WEB_PBKDF2 || k->alg == JS_WEB_HKDF) {
        snprintf(m, sizeof m, "%s key export is not supported", k->alg == JS_WEB_PBKDF2 ? "PBKDF2" : "HKDF");
        return dom_error(ctx, "NotSupportedError", m);
    }
    if (!k->extractable) return dom_error(ctx, "InvalidAccessError", "key is not extractable");
    int raw = raw_alias(k->alg, format);
    if (raw < 0 || (format == FORMAT_RAW_PUBLIC && js_key_data(k->data)->type != JS_KEY_PUBLIC)) {
        uint8_t type = js_key_data(k->data)->type;
        snprintf(m, sizeof m, "Unable to export %s %s key using %s format", web_alg_name(k->alg),
                 type == JS_KEY_SECRET ? "secret" : type == JS_KEY_PUBLIC ? "public" : "private", FORMATS[format]);
        return dom_error(ctx, "NotSupportedError", m);
    }
    format = raw;
    if (is_asym_alg(k->alg)) return export_asym(ctx, format, k);
    JSKeyData *d = js_key_data(k->data);
    if (format == FORMAT_RAW) return array_buffer_of(ctx, d->bytes, d->len);
    if (format == FORMAT_JWK) {
        JSValue o = js_new_object(ctx);
        put(ctx, o, "key_ops", k->usages);
        put(ctx, o, "ext", js_bool(k->extractable));
        char alg[16];
        jwk_alg(k->alg, k->hash, k->length, alg, sizeof alg);
        put(ctx, o, "alg", str(ctx, alg));
        put(ctx, o, "kty", str(ctx, "oct"));
        put(ctx, o, "k", base64url_encode(ctx, d->bytes, d->len));
        return o;
    }
    snprintf(m, sizeof m, "Unable to export %s secret key using %s format", web_alg_name(k->alg), FORMATS[format]);
    return dom_error(ctx, "NotSupportedError", m);
}

BUILTIN(subtle_export_key) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, export_key(ctx, argc, argv));
}

/* ---- Node 24's experimental methods: getPublicKey, and ML-KEM's encapsulation ---------------- */

/* Node's emitExperimentalWarning: once per feature */
static void experimental(JSContext *ctx, bool *warned, const char *feature) {
    if (*warned) return;
    *warned = true;
    char m[96];
    snprintf(m, sizeof m, "%s is an experimental feature and might change at any time", feature);
    js_emit_warning(ctx, str(ctx, m), "ExperimentalWarning", NULL);
}

/* getPublicKey(key, keyUsages): the public key of a private one, extractable */
static JSValue get_public_key(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    static bool warned;
    experimental(ctx, &warned, "The getPublicKey Web Crypto API method");
    Call c = { ctx, "getPublicKey" };
    if (argc < 2) return throw_missing_args(&c, 2, argc);
    JSCryptoKey *k = arg_key(&c, argv[0], 0);
    if (!k) return JS_EXCEPTION;
    uint16_t mask;
    JSValue usages = arg_usages(&c, argv[1], 1, &mask);
    if (js_is_exception(usages)) return usages;
    int type = js_key_data(k->data)->type;
    if (type != JS_KEY_PRIVATE)
        return dom_error(ctx, type == JS_KEY_SECRET ? "NotSupportedError" : "InvalidAccessError", "key must be a private key");
    JSValue data = js_key_public(ctx, k->data);
    return js_new_crypto_key(ctx, data, k->alg, k->hash, k->length, k->algorithm, usages, mask, true);
}

/* encapsulateBits/Key and decapsulateBits/Key: only ML-KEM has them, which visaljs doesn't provide,
 * so every algorithm is one Node doesn't recognize for them. `need` arguments, the key at `key_at`. */
static JSValue kem_method(JSContext *ctx, const char *op, bool *warned, uint32_t need, int key_at, uint32_t argc, const JSValue *argv) {
    char feature[64];
    snprintf(feature, sizeof feature, "The %s Web Crypto API method", op);
    experimental(ctx, warned, feature);
    Call c = { ctx, op };
    if (argc < need) return throw_missing_args(&c, need, argc);
    if (arg_algorithm(&c, argv[0], 0) < 0) return JS_EXCEPTION;
    if (!arg_key(&c, argv[key_at], key_at)) return JS_EXCEPTION;
    return dom_error(ctx, "NotSupportedError", "Unrecognized algorithm name");
}

#define KEM_METHOD(fn, op, need, key_at)                                       \
    BUILTIN(fn) {                                                              \
        (void)callee, (void)new_target;                                        \
        static bool warned;                                                    \
        if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto")); \
        return settled(ctx, kem_method(ctx, op, &warned, need, key_at, argc, argv)); \
    }
KEM_METHOD(subtle_encapsulate_bits, "encapsulateBits", 2, 1)
KEM_METHOD(subtle_encapsulate_key, "encapsulateKey", 5, 1)
KEM_METHOD(subtle_decapsulate_bits, "decapsulateBits", 3, 1)
KEM_METHOD(subtle_decapsulate_key, "decapsulateKey", 6, 1)

BUILTIN(subtle_get_public_key) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, get_public_key(ctx, argc, argv));
}

static JSValue generate_key(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    Call c = { ctx, "generateKey" };
    if (argc < 3) return throw_missing_args(&c, 3, argc);
    if (arg_algorithm(&c, argv[0], 0) < 0) return JS_EXCEPTION;
    bool extractable = js_truthy(argv[1]);
    uint16_t mask;
    JSValue given = arg_usages(&c, argv[2], 2, &mask);
    if (js_is_exception(given)) return given;
    Params p;
    int r = normalize(ctx, argv[0], OP_GENERATE_KEY, &p);
    if (r == 0 && is_asym_alg(params_alg(&p))) {
        JSValue pair = generate_asym(ctx, &p, extractable, mask);
        params_free(&p);
        return pair;
    }
    params_free(&p);
    if (r < 0) return JS_EXCEPTION;
    uint8_t alg = params_alg(&p);
    uint32_t length;
    if (alg == JS_WEB_HMAC) {
        /* HmacKeyGenParams' normalization first; any other length, in bits, is the key's */
        if (p.has_length && p.length == 0) return dom_error(ctx, "OperationError", "HmacKeyGenParams.length cannot be 0");
        length = p.has_length ? p.length : (uint32_t)p.hash->block_len * 8;
        if (has_any_not_in(mask, JS_USAGE_SIGN | JS_USAGE_VERIFY)) return dom_error(ctx, "SyntaxError", "Unsupported key usage for HMAC key");
    } else if (alg == JS_WEB_CHACHA20_POLY1305) {
        length = 256;
        if (has_any_not_in(mask, aes_usages(alg))) return usage_error(ctx, p.name);
    } else {
        length = p.length;
        if (length != 128 && length != 192 && length != 256)
            return dom_error(ctx, "OperationError", "AES key length must be 128, 192, or 256 bits");
        if (has_any_not_in(mask, aes_usages(alg))) return usage_error(ctx, p.name);
    }
    JSValue usages = usages_array(ctx, given);
    if (js_is_exception(usages)) return usages;
    size_t n = (length + 7) / 8;
    uint8_t *bytes = malloc(n);
    if (!bytes) js_fatal("out of memory in crypto");
    js_crypto_random(bytes, n);
    if (length % 8) bytes[n - 1] &= (uint8_t)(0xFF << (8 - length % 8));
    JSValue data = js_new_secret_key(ctx, bytes, n);
    free(bytes);
    if (js_array_length(js_as_object(usages)) == 0) return dom_error(ctx, "SyntaxError", "Usages cannot be empty when creating a key.");
    JSValue algorithm = alg == JS_WEB_HMAC ? hmac_algorithm(ctx, p.hash, length) : secret_algorithm(ctx, alg, p.name, length);
    return js_new_crypto_key(ctx, data, alg, p.hash, length, algorithm, usages, mask, extractable);
}

BUILTIN(subtle_generate_key) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, generate_key(ctx, argc, argv));
}

/* ---- sign and verify --------------------------------------------------------------------------- */

static JSValue sign_verify(JSContext *ctx, uint32_t argc, const JSValue *argv, bool verify) {
    Call c = { ctx, verify ? "verify" : "sign" };
    uint32_t need = verify ? 4 : 3;
    if (argc < need) return throw_missing_args(&c, need, argc);
    if (arg_algorithm(&c, argv[0], 0) < 0) return JS_EXCEPTION;
    JSCryptoKey *k = arg_key(&c, argv[1], 1);
    if (!k) return JS_EXCEPTION;
    if (arg_buffer_source(&c, argv[2], 2) < 0 || (verify && arg_buffer_source(&c, argv[3], 3) < 0)) return JS_EXCEPTION;
    Params p;
    int r = normalize(ctx, argv[0], verify ? OP_VERIFY : OP_SIGN, &p);
    params_free(&p);
    if (r < 0) return JS_EXCEPTION;
    if (!(k->usage_mask & (verify ? JS_USAGE_VERIFY : JS_USAGE_SIGN)) || REGISTRY[p.entry].alg != k->alg)
        return dom_error(ctx, "InvalidAccessError", verify ? "Unable to use this key to verify" : "Unable to use this key to sign");
    JSKeyData *d = js_key_data(k->data);
    if (k->alg == JS_WEB_ED25519) {  /* the message itself */
        Bytes data;
        bytes_copy(&data, argv[verify ? 3 : 2]);
        uint8_t sig[64];
        bool valid = false;
        int err;
        if (!verify) {
            err = js_ed25519_sign(d, data.p, data.n, sig);
        } else {
            uint8_t *sp;
            size_t sn;
            js_buffer_source_bytes(argv[2], &sp, &sn);
            err = js_ed25519_verify(d, data.p, data.n, sp, sn, &valid);
        }
        bytes_free(&data);
        if (err) return op_failed(ctx);
        return verify ? js_bool(valid) : array_buffer_of(ctx, sig, 64);
    }
    if (is_asym_alg(k->alg)) {  /* RSASSA-PKCS1-v1_5, RSA-PSS (the key's hash), ECDSA (the params', P1363 signatures) */
        const JSHashAlg *h = k->alg == JS_WEB_ECDSA ? p.hash : k->hash;
        int padding = k->alg == JS_WEB_RSA_PSS ? JS_PADDING_PSS : JS_PADDING_PKCS1;
        Bytes data;
        bytes_copy(&data, argv[verify ? 3 : 2]);
        uint8_t digest[64];
        js_hash_once(h, data.p, data.n, digest);
        bytes_free(&data);
        if (!verify) {
            JSBytesOut out = { 0 };
            if (js_asym_sign(d, h, digest, padding, (long)p.salt_length, true, &out)) return op_failed(ctx);
            JSValue sig = array_buffer_of(ctx, out.p, out.n);
            free(out.p);
            return sig;
        }
        uint8_t *sig;
        size_t sn;
        js_buffer_source_bytes(argv[2], &sig, &sn);
        bool valid;
        if (js_asym_verify(d, h, digest, padding, (long)p.salt_length, true, sig, sn, &valid)) return op_failed(ctx);
        return js_bool(valid);
    }
    /* HMAC */
    Bytes data;
    bytes_copy(&data, argv[verify ? 3 : 2]);
    uint8_t mac[64];
    JSHmacCtx m;
    js_hmac_init(&m, k->hash, d->bytes, d->len);
    js_hmac_update(&m, data.p, data.n);
    js_hmac_final(&m, mac);
    bytes_free(&data);
    if (!verify) return array_buffer_of(ctx, mac, k->hash->out_len);
    uint8_t *sig;
    size_t n;
    js_buffer_source_bytes(argv[2], &sig, &n);
    return js_bool(n == k->hash->out_len && js_crypto_equal(sig, mac, n));
}

BUILTIN(subtle_sign) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, sign_verify(ctx, argc, argv, false));
}

BUILTIN(subtle_verify) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, sign_verify(ctx, argc, argv, true));
}

/* ---- deriveBits and deriveKey ------------------------------------------------------------------ */

/* WebIDL's unsigned long (no [EnforceRange]): modulo 2^32. */
/* An [EnforceRange] unsigned long argument: finite, and in range once truncated. 0, or -1. */
static int arg_ulong_enforced(Call *c, JSValue v, int i, uint32_t *out) {
    double x;
    if (js_to_number(c->ctx, &x, v) < 0) return -1;
    if (!isfinite(x))
        return fail(js_throw_node_error(c->ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
                                        "Failed to execute '%s' on 'SubtleCrypto': %s argument is not a finite number.", c->op,
                                        ORDINALS[i]));
    x = trunc(x);
    if (x < 0 || x > 4294967295.0)
        return fail(js_throw_node_error(c->ctx, JS_TYPE_ERROR, "ERR_OUT_OF_RANGE",
                                        "Failed to execute '%s' on 'SubtleCrypto': %s argument is outside the expected range of 0 to "
                                        "4294967295.", c->op, ORDINALS[i]));
    *out = (uint32_t)x;
    return 0;
}

/* ECDH's and X25519's bits: the shared secret, or its first `length` bits (in whole bytes, the rest zero). */
static JSValue ecdh_bits(JSContext *ctx, Params *p, JSCryptoKey *k, bool has_length, uint32_t length) {
    JSCryptoKey *pub = p->public_key;
    JSKeyData *pd = js_key_data(pub->data), *d = js_key_data(k->data);
    if (pd->type != JS_KEY_PUBLIC) return dom_error(ctx, "InvalidAccessError", "algorithm.public must be a public key");
    if (pub->alg != params_alg(p)) return dom_error(ctx, "InvalidAccessError", "key algorithm mismatch");
    if (pub->alg != k->alg) return dom_error(ctx, "InvalidAccessError", "The public and private keys must be of the same type");
    if (pd->curve != d->curve) return dom_error(ctx, "InvalidAccessError", "Named curve mismatch");
    uint8_t secret[66];
    size_t n;
    if (js_ecdh(d, pd->part[JS_EC_PUB].p, pd->part[JS_EC_PUB].n, secret, &n)) return op_failed(ctx);
    if (has_length) {
        size_t want = (length + 7) / 8;
        if (want > n) return dom_error(ctx, "OperationError", "derived bit length is too small");
        n = want;
        if (length % 8) secret[n - 1] &= (uint8_t)(0xFF << (8 - length % 8));  /* the bits past the length, zeroed */
    }
    return array_buffer_of(ctx, secret, n);
}

/* The bits of a derivation (`has_length` false: null). */
static JSValue derive_bits(JSContext *ctx, Params *p, JSCryptoKey *k, bool has_length, uint32_t length) {
    if (k->alg == JS_WEB_ECDH || k->alg == JS_WEB_X25519) return ecdh_bits(ctx, p, k, has_length, length);
    JSKeyData *d = js_key_data(k->data);
    if (k->alg == JS_WEB_PBKDF2 && p->iterations == 0) return dom_error(ctx, "OperationError", "iterations cannot be zero");
    if (has_length && length == 0) return js_new_array_buffer(ctx, 0);
    if (!has_length) return dom_error(ctx, "OperationError", "length cannot be null");
    if (length % 8) return dom_error(ctx, "OperationError", "length must be a multiple of 8");
    size_t n = length / 8;
    uint8_t *out = malloc(n);
    if (!out) return dom_error(ctx, "OperationError", "The operation failed for an operation-specific reason");
    bool ok = k->alg == JS_WEB_PBKDF2 ? js_pbkdf2(p->hash, d->bytes, d->len, p->salt.p, p->salt.n, p->iterations, out, n)
                                      : js_hkdf(p->hash, d->bytes, d->len, p->salt.p, p->salt.n, p->info.p, p->info.n, out, n);
    JSValue r = ok ? array_buffer_of(ctx, out, n) : dom_error(ctx, "OperationError", "The operation failed for an operation-specific reason");
    free(out);
    return r;
}

static JSValue subtle_derive_bits_steps(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    Call c = { ctx, "deriveBits" };
    if (argc < 2) return throw_missing_args(&c, 2, argc);
    if (arg_algorithm(&c, argv[0], 0) < 0) return JS_EXCEPTION;
    JSCryptoKey *k = arg_key(&c, argv[1], 1);
    if (!k) return JS_EXCEPTION;
    bool has_length = argc > 2 && !js_is_nullish(argv[2]);
    uint32_t length = 0;
    if (has_length && arg_ulong_enforced(&c, argv[2], 2, &length) < 0) return JS_EXCEPTION;
    Params p;
    if (normalize(ctx, argv[0], OP_DERIVE_BITS, &p) < 0) {
        params_free(&p);
        return JS_EXCEPTION;
    }
    JSValue r;
    if (!(k->usage_mask & JS_USAGE_DERIVE_BITS)) r = dom_error(ctx, "InvalidAccessError", "baseKey does not have deriveBits usage");
    else if (REGISTRY[p.entry].alg != k->alg) r = dom_error(ctx, "InvalidAccessError", "Key algorithm mismatch");
    else r = derive_bits(ctx, &p, k, has_length, length);
    params_free(&p);
    return r;
}

BUILTIN(subtle_derive_bits) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, subtle_derive_bits_steps(ctx, argc, argv));
}

static JSValue derive_key(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    Call c = { ctx, "deriveKey" };
    if (argc < 5) return throw_missing_args(&c, 5, argc);
    if (arg_algorithm(&c, argv[0], 0) < 0) return JS_EXCEPTION;
    JSCryptoKey *k = arg_key(&c, argv[1], 1);
    if (!k) return JS_EXCEPTION;
    if (arg_algorithm(&c, argv[2], 2) < 0) return JS_EXCEPTION;
    uint16_t mask;
    JSValue usages = arg_usages(&c, argv[4], 4, &mask);
    if (js_is_exception(usages)) return usages;
    Params p, derived, len;
    memset(&derived, 0, sizeof derived);
    memset(&len, 0, sizeof len);
    JSValue r = JS_EXCEPTION;
    if (normalize(ctx, argv[0], OP_DERIVE_BITS, &p) < 0 || normalize(ctx, argv[2], OP_IMPORT_KEY, &derived) < 0) goto done;
    if (!(k->usage_mask & JS_USAGE_DERIVE_KEY)) {
        r = dom_error(ctx, "InvalidAccessError", "baseKey does not have deriveKey usage");
        goto done;
    }
    if (REGISTRY[p.entry].alg != k->alg) {
        r = dom_error(ctx, "InvalidAccessError", "Key algorithm mismatch");
        goto done;
    }
    if (normalize(ctx, argv[2], OP_GET_KEY_LENGTH, &len) < 0) goto done;
    /* getKeyLength: HMAC's (its block size by default; 0 makes an empty key, which import rejects); null for PBKDF2 and HKDF */
    bool has_length = false;
    uint32_t length = 0;
    if (params_alg(&len) == JS_WEB_HMAC) {
        length = len.has_length ? len.length : (uint32_t)len.hash->block_len * 8;
        has_length = true;
    } else if (is_aes(params_alg(&len))) {
        if (len.length != 128 && len.length != 192 && len.length != 256) {
            r = dom_error(ctx, "OperationError", "AES key length must be 128, 192, or 256 bits");
            goto done;
        }
        length = len.length;
        has_length = true;
    }
    JSValue bits = derive_bits(ctx, &p, k, has_length, length);
    if (js_is_exception(bits)) goto done;
    JSValue args[5] = { str(ctx, "raw"), bits, argv[2], argv[3], argv[4] };
    r = import_key(ctx, 5, args);
done:
    params_free(&p);
    params_free(&derived);
    params_free(&len);
    return r;
}

BUILTIN(subtle_derive_key) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, derive_key(ctx, argc, argv));
}

/* ---- digest, and the operations no algorithm here supports yet -------------------------------- */

BUILTIN(subtle_digest) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    Call c = { ctx, "digest" };
    if (argc < 2) return rejected(ctx, throw_missing_args(&c, 2, argc));
    if (arg_algorithm(&c, argv[0], 0) < 0 || arg_buffer_source(&c, argv[1], 1) < 0) return rejected(ctx, JS_EXCEPTION);
    Params p;
    if (normalize(ctx, argv[0], OP_DIGEST, &p) < 0) return rejected(ctx, JS_EXCEPTION);
    /* the bytes now: converting the algorithm may have run code that changed them */
    uint8_t *data;
    size_t n;
    js_buffer_source_bytes(argv[1], &data, &n);
    uint8_t out[64];
    js_hash_once(p.hash, data, n, out);
    return settled(ctx, array_buffer_of(ctx, out, p.hash->out_len));
}

/* ---- encrypt, decrypt, wrapKey, unwrapKey ------------------------------------------------------- */

/* One whole run of an AES cipher context (CBC, GCM, key wrap): the output, or false. */
static bool run_cipher(const JSCipherAlg *alg, bool encrypt, JSKeyData *d, const uint8_t *iv, size_t iv_len, long tag_len,
                       const Bytes *aad, const uint8_t *tag, size_t tag_n, const uint8_t *in, size_t n, JSBytesOut *out) {
    JSCipherCtx c;
    bool ok = js_cipher_init(&c, alg, encrypt, d->bytes, d->len, iv, iv_len, true, tag_len) == 0;
    if (ok && aad && aad->n) ok = js_cipher_set_aad(&c, aad->p, aad->n, -1) == 0;
    if (ok && tag) ok = js_cipher_set_auth_tag(&c, tag, tag_n) == 0;
    if (ok) ok = js_cipher_update(&c, in, n, out) == 0 && js_cipher_final(&c, out) == 0;
    if (ok && encrypt && tag_len > 0) {
        const uint8_t *t;
        size_t tn;
        ok = js_cipher_get_auth_tag(&c, &t, &tn);
        if (ok) {
            JSBytesOut tmp = *out;  /* append the tag */
            uint8_t *q = realloc(tmp.p, tmp.n + tn);
            if (!q) js_fatal("out of memory in crypto");
            memcpy(q + tmp.n, t, tn);
            out->p = q;
            out->n = tmp.n + tn;
            out->cap = out->n;
        }
    }
    js_cipher_free(&c);
    return ok;
}

/* aesCipher: the operation on a copy of the data. */
static JSValue aes_cipher(JSContext *ctx, bool encrypt, JSCryptoKey *k, Params *p, const Bytes *data) {
    JSKeyData *d = js_key_data(k->data);
    JSBytesOut out = { 0 };
    bool ok;
    switch (k->alg) {
    case JS_WEB_AES_CTR: {
        if (p->counter.n != 16) return dom_error(ctx, "OperationError", "algorithm.counter must contain exactly 16 bytes");
        if (p->length == 0 || p->length > 128) return dom_error(ctx, "OperationError", "AES-CTR algorithm.length must be between 1 and 128");
        uint8_t *o = malloc(data->n ? data->n : 1);
        if (!o) js_fatal("out of memory in crypto");
        ok = js_aes_ctr_masked(d->bytes, d->len, p->counter.p, p->length, data->p, data->n, o);
        JSValue r = ok ? array_buffer_of(ctx, o, data->n) : op_failed(ctx);
        free(o);
        return r;
    }
    case JS_WEB_AES_CBC:
        if (p->iv.n != 16) return dom_error(ctx, "OperationError", "algorithm.iv must contain exactly 16 bytes");
        ok = run_cipher(js_cipher_aes(JS_CIPHER_CBC, d->len), encrypt, d, p->iv.p, 16, -1, NULL, NULL, 0, data->p, data->n, &out);
        break;
    case JS_WEB_AES_GCM: {
        uint32_t tag_bits = p->has_tag_length ? p->tag_length : 128;
        if (tag_bits != 32 && tag_bits != 64 && tag_bits != 96 && (tag_bits < 104 || tag_bits > 128 || tag_bits % 8)) {
            char m[64];
            snprintf(m, sizeof m, "%u is not a valid AES-GCM tag length", tag_bits);
            return dom_error(ctx, "OperationError", m);
        }
        size_t tag_n = tag_bits / 8;
        if (!encrypt && data->n < tag_n) return op_failed(ctx);
        if (p->iv.n < 12) return op_failed(ctx);
        const JSCipherAlg *alg = js_cipher_aes(JS_CIPHER_GCM, d->len);
        ok = encrypt ? run_cipher(alg, true, d, p->iv.p, p->iv.n, (long)tag_n, &p->additional_data, NULL, 0, data->p, data->n, &out)
                     : run_cipher(alg, false, d, p->iv.p, p->iv.n, (long)tag_n, &p->additional_data, data->p + data->n - tag_n, tag_n,
                                  data->p, data->n - tag_n, &out);
        break;
    }
    case JS_WEB_CHACHA20_POLY1305: {
        uint32_t tag_bits = p->has_tag_length ? p->tag_length : 128;
        if (tag_bits != 128) {
            char m[64];
            snprintf(m, sizeof m, "%u is not a valid ChaCha20-Poly1305 tag length", tag_bits);
            return dom_error(ctx, "OperationError", m);
        }
        if (p->iv.n != 12) return dom_error(ctx, "OperationError", "algorithm.iv must contain exactly 12 bytes");
        if (!encrypt && data->n < 16) return op_failed(ctx);
        const JSCipherAlg *alg = js_cipher_by_name("chacha20-poly1305");
        ok = encrypt ? run_cipher(alg, true, d, p->iv.p, 12, 16, &p->additional_data, NULL, 0, data->p, data->n, &out)
                     : run_cipher(alg, false, d, p->iv.p, 12, 16, &p->additional_data, data->p + data->n - 16, 16, data->p, data->n - 16, &out);
        break;
    }
    default: { /* AES-KW, with RFC 3394's default IV */
        static const uint8_t KW_IV[8] = { 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6, 0xA6 };
        ok = run_cipher(js_cipher_aes(JS_CIPHER_WRAP, d->len), encrypt, d, KW_IV, 8, -1, NULL, NULL, 0, data->p, data->n, &out);
        break;
    }
    }
    JSValue r = ok ? array_buffer_of(ctx, out.p ? out.p : (const uint8_t *)"", out.n) : op_failed(ctx);
    free(out.p);
    return r;
}

/* cipherOrWrap: the key must be for the algorithm and allow the use. */
static JSValue cipher_or_wrap(JSContext *ctx, bool encrypt, Params *p, JSCryptoKey *k, const Bytes *data, uint16_t usage) {
    if (params_alg(p) != k->alg) return dom_error(ctx, "InvalidAccessError", "Key algorithm mismatch");
    if (!(k->usage_mask & usage)) {
        const char *op = usage == JS_USAGE_ENCRYPT ? "encrypt" : usage == JS_USAGE_DECRYPT ? "decrypt"
                         : usage == JS_USAGE_WRAP_KEY ? "wrapKey" : "unwrapKey";
        char m[48];
        snprintf(m, sizeof m, "Unable to use this key to %s", op);
        return dom_error(ctx, "InvalidAccessError", m);
    }
    if (k->alg == JS_WEB_RSA_OAEP) {  /* encrypting with the public key, decrypting with the private one */
        JSKeyData *d = js_key_data(k->data);
        if (d->type != (encrypt ? JS_KEY_PUBLIC : JS_KEY_PRIVATE))
            return dom_error(ctx, "InvalidAccessError", "The requested operation is not valid for the provided key");
        JSBytesOut out = { 0 };
        if (js_rsa_crypt(d, encrypt ? JS_RSA_PUBLIC_ENCRYPT : JS_RSA_PRIVATE_DECRYPT, JS_PADDING_OAEP, k->hash, p->label.p, p->label.n,
                         data->p, data->n, &out))
            return op_failed(ctx);
        JSValue r = array_buffer_of(ctx, out.p ? out.p : (const uint8_t *)"", out.n);
        free(out.p);
        return r;
    }
    if (k->alg == JS_WEB_AES_KW && !(usage & (JS_USAGE_WRAP_KEY | JS_USAGE_UNWRAP_KEY)))
        return dom_error(ctx, "NotSupportedError", "Unrecognized algorithm name");
    return aes_cipher(ctx, encrypt, k, p, data);
}

static JSValue encrypt_decrypt(JSContext *ctx, uint32_t argc, const JSValue *argv, bool encrypt) {
    Call c = { ctx, encrypt ? "encrypt" : "decrypt" };
    if (argc < 3) return throw_missing_args(&c, 3, argc);
    if (arg_algorithm(&c, argv[0], 0) < 0) return JS_EXCEPTION;
    JSCryptoKey *k = arg_key(&c, argv[1], 1);
    if (!k || arg_buffer_source(&c, argv[2], 2) < 0) return JS_EXCEPTION;
    Params p;
    JSValue r = JS_EXCEPTION;
    if (normalize(ctx, argv[0], encrypt ? OP_ENCRYPT : OP_DECRYPT, &p) == 0) {
        Bytes data;
        bytes_copy(&data, argv[2]);
        r = cipher_or_wrap(ctx, encrypt, &p, k, &data, encrypt ? JS_USAGE_ENCRYPT : JS_USAGE_DECRYPT);
        bytes_free(&data);
    }
    params_free(&p);
    return r;
}

BUILTIN(subtle_encrypt) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, encrypt_decrypt(ctx, argc, argv, true));
}

BUILTIN(subtle_decrypt) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, encrypt_decrypt(ctx, argc, argv, false));
}

/* wrapKey's and unwrapKey's algorithm: normalized for the operation, else for encrypt (decrypt). */
static int normalize_wrap(JSContext *ctx, JSValue alg, bool wrap, Params *p) {
    if (normalize(ctx, alg, wrap ? OP_WRAP_KEY : OP_UNWRAP_KEY, p) == 0) return 0;
    params_free(p);
    js_discard(js_take_exception(ctx));
    return normalize(ctx, alg, wrap ? OP_ENCRYPT : OP_DECRYPT, p);
}

static JSValue wrap_key(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    Call c = { ctx, "wrapKey" };
    if (argc < 4) return throw_missing_args(&c, 4, argc);
    if (arg_format(&c, argv[0], 0) < 0) return JS_EXCEPTION;
    if (!arg_key(&c, argv[1], 1)) return JS_EXCEPTION;
    JSCryptoKey *wrapping = arg_key(&c, argv[2], 2);
    if (!wrapping || arg_algorithm(&c, argv[3], 3) < 0) return JS_EXCEPTION;
    Params p;
    JSValue r = JS_EXCEPTION;
    if (normalize_wrap(ctx, argv[3], true, &p) == 0) {
        JSValue exported = export_key(ctx, 2, argv);
        if (!js_is_exception(exported)) {
            Bytes data = { 0 };
            if (js_is_object(exported) && !js_is_array_buffer(exported)) {  /* a JWK: its JSON, as UTF-8 */
                JSValue json = js_json_stringify(ctx, exported, JS_UNDEFINED, JS_UNDEFINED, NULL);
                if (js_is_exception(json)) goto out;
                JSStrView v = js_string_view(ctx, json);
                size_t n = js_view_to_utf8(v, NULL, 0);
                size_t padded = params_alg(&p) == JS_WEB_AES_KW && v.length % 8 ? n + 8 - v.length % 8 : n;
                data.p = malloc(padded ? padded : 1);
                if (!data.p) js_fatal("out of memory in crypto");
                js_view_to_utf8(v, (char *)data.p, n);
                memset(data.p + n, ' ', padded - n);  /* AES-KW's whole blocks */
                data.n = padded;
            } else {
                bytes_copy(&data, exported);
            }
            r = cipher_or_wrap(ctx, true, &p, wrapping, &data, JS_USAGE_WRAP_KEY);
            bytes_free(&data);
        }
    }
out:
    params_free(&p);
    return r;
}

BUILTIN(subtle_wrap_key) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, wrap_key(ctx, argc, argv));
}

/* Whether bytes are well-formed UTF-8 (TextDecoder's fatal mode). */
static bool valid_utf8(const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n;) {
        uint8_t b = p[i];
        if (b < 0x80) {
            i++;
            continue;
        }
        size_t need;
        uint32_t cp, min;
        if (b >= 0xC2 && b <= 0xDF) need = 1, cp = b & 0x1Fu, min = 0x80;
        else if ((b & 0xF0) == 0xE0) need = 2, cp = b & 0x0Fu, min = 0x800;
        else if (b >= 0xF0 && b <= 0xF4) need = 3, cp = b & 0x07u, min = 0x10000;
        else return false;
        if (n - i <= need) return false;
        for (size_t k = 1; k <= need; k++) {
            if ((p[i + k] & 0xC0) != 0x80) return false;
            cp = cp << 6 | (p[i + k] & 0x3Fu);
        }
        if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        i += need + 1;
    }
    return true;
}

static JSValue unwrap_key(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    Call c = { ctx, "unwrapKey" };
    if (argc < 7) return throw_missing_args(&c, 7, argc);
    int format = arg_format(&c, argv[0], 0);
    if (format < 0 || arg_buffer_source(&c, argv[1], 1) < 0) return JS_EXCEPTION;
    JSCryptoKey *unwrapping = arg_key(&c, argv[2], 2);
    if (!unwrapping || arg_algorithm(&c, argv[3], 3) < 0 || arg_algorithm(&c, argv[4], 4) < 0) return JS_EXCEPTION;
    uint16_t mask;
    if (js_is_exception(arg_usages(&c, argv[6], 6, &mask))) return JS_EXCEPTION;
    Params p;
    JSValue r = JS_EXCEPTION;
    if (normalize_wrap(ctx, argv[3], false, &p) == 0) {
        Bytes wrapped;
        bytes_copy(&wrapped, argv[1]);
        JSValue key_data = cipher_or_wrap(ctx, false, &p, unwrapping, &wrapped, JS_USAGE_UNWRAP_KEY);
        bytes_free(&wrapped);
        if (!js_is_exception(key_data) && format == FORMAT_JWK) {
            JSArrayBuffer *b = js_as_array_buffer(key_data);
            JSValue text = valid_utf8(b->data, b->byte_length) ? js_decode_utf8_bytes(ctx, b->data, b->byte_length) : JS_EXCEPTION;
            key_data = js_is_exception(text) ? JS_EXCEPTION : js_json_parse(ctx, text);
            if (js_is_exception(key_data)) {
                if (js_has_exception(ctx)) js_discard(js_take_exception(ctx));
                key_data = dom_error(ctx, "DataError", "Invalid wrapped JWK key");
            }
        }
        if (!js_is_exception(key_data)) {
            JSValue args[5] = { argv[0], key_data, argv[4], argv[5], argv[6] };
            r = import_key(ctx, 5, args);
        }
    }
    params_free(&p);
    return r;
}

BUILTIN(subtle_unwrap_key) {
    (void)callee, (void)new_target;
    if (!is_subtle(this_val)) return rejected(ctx, js_throw_invalid_this(ctx, "SubtleCrypto"));
    return settled(ctx, unwrap_key(ctx, argc, argv));
}

/* ---- Realm ------------------------------------------------------------------------------------- */

BUILTIN(subtle_ctor) {
    UNUSED_ARGS;
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
}

static const JSBuiltin subtle_proto[] = {  /* Node's order and lengths */
    WEBIDL_OPERATION("encrypt", subtle_encrypt, 3),
    WEBIDL_OPERATION("decrypt", subtle_decrypt, 3),
    WEBIDL_OPERATION("sign", subtle_sign, 3),
    WEBIDL_OPERATION("verify", subtle_verify, 4),
    WEBIDL_OPERATION("digest", subtle_digest, 2),
    WEBIDL_OPERATION("generateKey", subtle_generate_key, 3),
    WEBIDL_OPERATION("deriveKey", subtle_derive_key, 5),
    WEBIDL_OPERATION("deriveBits", subtle_derive_bits, 2),
    WEBIDL_OPERATION("importKey", subtle_import_key, 5),
    WEBIDL_OPERATION("exportKey", subtle_export_key, 2),
    WEBIDL_OPERATION("wrapKey", subtle_wrap_key, 4),
    WEBIDL_OPERATION("unwrapKey", subtle_unwrap_key, 7),
    WEBIDL_OPERATION("getPublicKey", subtle_get_public_key, 2),
    WEBIDL_OPERATION("encapsulateBits", subtle_encapsulate_bits, 2),
    WEBIDL_OPERATION("encapsulateKey", subtle_encapsulate_key, 5),
    WEBIDL_OPERATION("decapsulateBits", subtle_decapsulate_bits, 3),
    WEBIDL_OPERATION("decapsulateKey", subtle_decapsulate_key, 6),
};

void js_crypto_install_subtle(JSContext *ctx, JSObject *global) {
    js_define_web_class(ctx, global, "SubtleCrypto", subtle_ctor, 0, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE],
                        JS_INTRINSIC_SUBTLE_CRYPTO_PROTOTYPE);
    JSValue sp = ctx->intrinsics[JS_INTRINSIC_SUBTLE_CRYPTO_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(sp), subtle_proto, JS_COUNTOF(subtle_proto));
    js_define_data(ctx, js_as_object(sp), JS_SYMBOL(toStringTag), str(ctx, "SubtleCrypto"), JS_PROP_CONFIGURABLE);
    ctx->intrinsics[JS_INTRINSIC_SUBTLE_CRYPTO] =
        js_object_value(js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &subtle_class, sp, 0)));
}
