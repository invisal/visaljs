/* Asymmetric keys: RSA, RSA-PSS, EC (P-256, P-384, P-521) and X25519 keys in the key
 * record (crypto_internal.h), their DER encodings (SPKI, PKCS#8, PKCS#1, SEC1, and the public key
 * of an X.509 certificate) with a small DER reader and writer of our own, and their generation on
 * BoringSSL. node:crypto's KeyObject is built on the primitives at the end; Web Crypto's keys share
 * the record. PEM and JWK are the prelude's (base64 in JS), over the DER and the parts here. */
#include <stdlib.h>
#include <string.h>

#include <openssl/bn.h>
#include <openssl/curve25519.h>
#include <openssl/ec.h>
#include <openssl/ec_key.h>
#include <openssl/err.h>
#include <openssl/nid.h>
#include <openssl/rsa.h>

#include "builtins_util.h"
#include "crypto_internal.h"
#include "internal.h"
#include "js_buffer.h"
#include "js_crypto.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

/* ---- DER ---------------------------------------------------------------------------------------- */

enum { DER_INT = 0x02, DER_BIT_STRING = 0x03, DER_OCTET_STRING = 0x04, DER_NULL = 0x05, DER_OID = 0x06, DER_SEQ = 0x30 };
#define DER_CTX(n) (0xA0 | (n))  /* [n], constructed */

typedef struct Der {
    const uint8_t *p;
    size_t         n;
} Der;

/* The next TLV of `in` (definite lengths only), its tag and contents. */
static bool der_read(Der *in, uint8_t *tag, Der *content) {
    if (in->n < 2) return false;
    *tag = in->p[0];
    size_t len = in->p[1], at = 2;
    if (len & 0x80) {
        size_t bytes = len & 0x7F;
        if (bytes == 0 || bytes > 4 || in->n < 2 + bytes) return false;
        len = 0;
        for (size_t i = 0; i < bytes; i++) len = len << 8 | in->p[2 + i];
        at += bytes;
    }
    if (in->n - at < len) return false;
    content->p = in->p + at;
    content->n = len;
    in->p += at + len;
    in->n -= at + len;
    return true;
}

static bool der_expect(Der *in, uint8_t want, Der *content) {
    uint8_t tag;
    Der save = *in;
    if (!der_read(in, &tag, content) || tag != want) {
        *in = save;
        return false;
    }
    return true;
}

/* An optional [n]: read when it is next. */
static bool der_optional(Der *in, uint8_t want, Der *content) {
    if (in->n == 0 || in->p[0] != want) return false;
    return der_expect(in, want, content);
}

/* A non-negative INTEGER's magnitude, without its leading zeros. */
static bool der_uint(Der *in, Der *v) {
    if (!der_expect(in, DER_INT, v) || v->n == 0 || (v->p[0] & 0x80)) return false;
    while (v->n > 1 && v->p[0] == 0) v->p++, v->n--;
    return true;
}

static bool der_small_uint(Der *in, uint32_t *out) {
    Der v;
    if (!der_uint(in, &v) || v.n > 4) return false;
    *out = 0;
    for (size_t i = 0; i < v.n; i++) *out = *out << 8 | v.p[i];
    return true;
}

static bool der_oid_is(Der oid, const uint8_t *want, size_t n) { return oid.n == n && memcmp(oid.p, want, n) == 0; }

/* The writer: TLVs appended to a buffer; a constructed one is built in its own and wrapped. */
static void w_raw(JSBytesOut *o, const uint8_t *p, size_t n) {
    if (o->n + n > o->cap) {
        size_t cap = o->cap ? o->cap : 128;
        while (cap < o->n + n) cap *= 2;
        uint8_t *q = realloc(o->p, cap);
        if (!q) js_fatal("out of memory in crypto");
        o->p = q;
        o->cap = cap;
    }
    if (n) memcpy(o->p + o->n, p, n);
    o->n += n;
}

static void w_tlv(JSBytesOut *o, uint8_t tag, const uint8_t *p, size_t n) {
    uint8_t h[6];
    size_t k = 0;
    h[k++] = tag;
    if (n < 0x80) h[k++] = (uint8_t)n;
    else if (n < 0x100) h[k++] = 0x81, h[k++] = (uint8_t)n;
    else if (n < 0x10000) h[k++] = 0x82, h[k++] = (uint8_t)(n >> 8), h[k++] = (uint8_t)n;
    else h[k++] = 0x83, h[k++] = (uint8_t)(n >> 16), h[k++] = (uint8_t)(n >> 8), h[k++] = (uint8_t)n;
    w_raw(o, h, k);
    w_raw(o, p, n);
}

/* Wraps `inner` (freed) as one TLV of `o`. */
static void w_wrap(JSBytesOut *o, uint8_t tag, JSBytesOut *inner) {
    w_tlv(o, tag, inner->p, inner->n);
    free(inner->p);
    memset(inner, 0, sizeof *inner);
}

/* An unsigned big-endian integer: minimal, a zero byte in front when the high bit is set. */
static void w_uint(JSBytesOut *o, const uint8_t *p, size_t n) {
    while (n > 1 && p[0] == 0) p++, n--;
    if (n == 0) {
        static const uint8_t zero = 0;
        w_tlv(o, DER_INT, &zero, 1);
        return;
    }
    if (p[0] & 0x80) {
        uint8_t *t = malloc(n + 1);
        if (!t) js_fatal("out of memory in crypto");
        t[0] = 0;
        memcpy(t + 1, p, n);
        w_tlv(o, DER_INT, t, n + 1);
        free(t);
    } else {
        w_tlv(o, DER_INT, p, n);
    }
}

static void w_small_uint(JSBytesOut *o, uint32_t v) {
    uint8_t b[4] = { (uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v };
    w_uint(o, b, 4);
}

/* ---- Identifiers ------------------------------------------------------------------------------- */

static const uint8_t OID_RSA[] = { 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01 };
static const uint8_t OID_RSA_PSS[] = { 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0A };
static const uint8_t OID_MGF1[] = { 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x08 };
static const uint8_t OID_EC[] = { 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01 };
static const uint8_t OID_X25519[] = { 0x2B, 0x65, 0x6E };
static const uint8_t OID_ED25519[] = { 0x2B, 0x65, 0x70 };
static const uint8_t OID_DH[] = { 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x03, 0x01 };
static const uint8_t OID_DSA[] = { 0x2A, 0x86, 0x48, 0xCE, 0x38, 0x04, 0x01 };

static const struct {
    int            curve;      /* JS_EC_* */
    const char    *name;       /* Node's (OpenSSL's) */
    const char    *jwk;        /* JWK's crv */
    uint8_t        size;       /* bytes of a coordinate or scalar */
    uint8_t        oid_len;
    const uint8_t *oid;
} CURVES[] = {
    { JS_EC_P256, "prime256v1", "P-256", 32, 8, (const uint8_t *)"\x2A\x86\x48\xCE\x3D\x03\x01\x07" },
    { JS_EC_P384, "secp384r1", "P-384", 48, 5, (const uint8_t *)"\x2B\x81\x04\x00\x22" },
    { JS_EC_P521, "secp521r1", "P-521", 66, 5, (const uint8_t *)"\x2B\x81\x04\x00\x23" },
};

static int curve_index(int curve) {
    for (int i = 0; i < (int)JS_COUNTOF(CURVES); i++)
        if (CURVES[i].curve == curve) return i;
    return -1;
}

static int curve_by_oid(Der oid) {
    for (int i = 0; i < (int)JS_COUNTOF(CURVES); i++)
        if (der_oid_is(oid, CURVES[i].oid, CURVES[i].oid_len)) return CURVES[i].curve;
    return -1;
}

/* The hash of a DER AlgorithmIdentifier's OID (the JSHashAlg's, which is length-prefixed). */
static const JSHashAlg *hash_by_oid(Der oid) {
    static const char *const names[] = { "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256", "md5" };
    for (size_t i = 0; i < JS_COUNTOF(names); i++) {
        const JSHashAlg *h = js_hash_by_name(names[i]);
        if (h->oid && der_oid_is(oid, h->oid + 1, h->oid[0])) return h;
    }
    return NULL;
}

/* ---- Errors (the prelude words them, as Node's do) --------------------------------------------- */

enum {
    KEY_ERR_DECODE = 1,   /* not a key the decoder takes: "DECODER routines::unsupported" */
    KEY_ERR_TAG,          /* bad DER: "asn1 encoding routines::wrong tag" */
    KEY_ERR_KEY_TYPE,     /* a key type not provided (Ed25519, DSA, …) */
    KEY_ERR_ENCODING,     /* an encoding the key's type can't have (pkcs1 of an EC key) */
    KEY_ERR_GENERATE,     /* parameters key generation rejects */
};

/* ---- The key's parts ---------------------------------------------------------------------------- */

static void set_part(JSKeyData *k, int i, Der v) { js_key_part_set(&k->part[i], v.p, v.n); }

/* A scalar or coordinate in a fixed size (zeros in front). */
static void set_part_fixed(JSKeyData *k, int i, const uint8_t *p, size_t n, size_t size) {
    while (n > size && p[0] == 0) p++, n--;
    uint8_t buf[66] = { 0 };
    if (n > size) n = size;
    memcpy(buf + size - n, p, n);
    js_key_part_set(&k->part[i], buf, size);
}

/* A finite-field key's public value from the private one: y = g^x mod p */
static bool ff_compute_pub(JSKeyData *k) {
    bool dh = k->kind == JS_ASYM_DH;
    const JSKeyPart *p = &k->part[dh ? JS_DH_P : JS_DSA_P], *g = &k->part[dh ? JS_DH_G : JS_DSA_G], *x = &k->part[dh ? JS_DH_PRIV : JS_DSA_PRIV];
    if (!p->p || !g->p || !x->p) return false;
    BIGNUM *bp = BN_bin2bn(p->p, p->n, NULL), *bg = BN_bin2bn(g->p, g->n, NULL), *bx = BN_bin2bn(x->p, x->n, NULL), *y = BN_new();
    BN_CTX *bc = BN_CTX_new();
    bool ok = bp && bg && bx && y && bc && BN_is_odd(bp) && BN_mod_exp_mont_consttime(y, bg, bx, bp, bc, NULL);
    if (ok) {
        size_t n = BN_num_bytes(y);
        uint8_t *buf = malloc(n ? n : 1);
        if (!buf) js_fatal("out of memory in crypto");
        if (n == 0) buf[0] = 0, n = 1;
        else BN_bn2bin(y, buf);
        js_key_part_set(&k->part[dh ? JS_DH_PUB : JS_DSA_PUB], buf, n);
        free(buf);
    }
    BN_free(bp), BN_free(bg), BN_clear_free(bx), BN_free(y), BN_CTX_free(bc);
    ERR_clear_error();
    return ok;
}

/* The EC public point (or X25519 public value) from the private scalar. */
static bool ec_compute_pub(JSKeyData *k) {
    uint8_t pub[133];
    size_t n;
    if (!js_ec_public_of(k->curve, k->part[JS_EC_PRIV].p, k->part[JS_EC_PRIV].n, pub, &n)) return false;
    js_key_part_set(&k->part[JS_EC_PUB], pub, n);
    return true;
}

/* ---- Decoding ----------------------------------------------------------------------------------- */

/* RSASSA-PSS-params: present (true) or absent; their fields, with the defaults. */
static bool pss_params(JSKeyData *k, Der params) {
    Der seq, f, alg, oid;
    if (!der_expect(&params, DER_SEQ, &seq)) return false;
    k->pss_params = true;
    k->pss_hash = js_hash_by_name("sha1");
    k->pss_mgf1 = k->pss_hash;
    k->pss_salt = 20;
    if (der_optional(&seq, DER_CTX(0), &f)) {
        if (!der_expect(&f, DER_SEQ, &alg) || !der_expect(&alg, DER_OID, &oid) || !(k->pss_hash = hash_by_oid(oid))) return false;
    }
    if (der_optional(&seq, DER_CTX(1), &f)) {
        Der mgf, inner;
        if (!der_expect(&f, DER_SEQ, &mgf) || !der_expect(&mgf, DER_OID, &oid) || !der_oid_is(oid, OID_MGF1, sizeof OID_MGF1)) return false;
        if (!der_expect(&mgf, DER_SEQ, &inner) || !der_expect(&inner, DER_OID, &oid) || !(k->pss_mgf1 = hash_by_oid(oid))) return false;
    }
    if (der_optional(&seq, DER_CTX(2), &f) && !der_small_uint(&f, &k->pss_salt)) return false;
    return true;
}

/* An AlgorithmIdentifier: the kind (and curve, PSS parameters) into k. */
static int algorithm_identifier(JSKeyData *k, Der alg_seq) {
    Der oid;
    if (!der_expect(&alg_seq, DER_OID, &oid)) return KEY_ERR_TAG;
    if (der_oid_is(oid, OID_RSA, sizeof OID_RSA)) {
        k->kind = JS_ASYM_RSA;
    } else if (der_oid_is(oid, OID_RSA_PSS, sizeof OID_RSA_PSS)) {
        k->kind = JS_ASYM_RSA_PSS;
        if (alg_seq.n && !pss_params(k, alg_seq)) return KEY_ERR_TAG;
    } else if (der_oid_is(oid, OID_EC, sizeof OID_EC)) {
        Der curve;
        k->kind = JS_ASYM_EC;
        if (!der_expect(&alg_seq, DER_OID, &curve)) return KEY_ERR_TAG;
        k->curve = curve_by_oid(curve);
        if (k->curve < 0) return KEY_ERR_KEY_TYPE;
    } else if (der_oid_is(oid, OID_X25519, sizeof OID_X25519)) {
        k->kind = JS_ASYM_X25519;
        k->curve = JS_EC_X25519;
    } else if (der_oid_is(oid, OID_ED25519, sizeof OID_ED25519)) {
        k->kind = JS_ASYM_ED25519;
        k->curve = JS_EC_ED25519;
    } else if (der_oid_is(oid, OID_DH, sizeof OID_DH) || der_oid_is(oid, OID_DSA, sizeof OID_DSA)) {
        /* DHParameter (PKCS#3: p, g[, privateValueLength]) or Dss-Parms (p, q, g) */
        bool dh = oid.n == sizeof OID_DH;
        Der params, v;
        k->kind = dh ? JS_ASYM_DH : JS_ASYM_DSA;
        if (!der_expect(&alg_seq, DER_SEQ, &params)) return KEY_ERR_TAG;
        int n = dh ? 2 : 3;
        for (int i = 0; i < n; i++) {
            if (!der_uint(&params, &v)) return KEY_ERR_TAG;
            set_part(k, i, v);
        }
    } else {
        return KEY_ERR_KEY_TYPE;
    }
    return 0;
}

/* RSAPublicKey (PKCS#1) */
static int rsa_public(JSKeyData *k, Der in) {
    Der seq, n, e;
    if (!der_expect(&in, DER_SEQ, &seq) || !der_uint(&seq, &n) || !der_uint(&seq, &e)) return KEY_ERR_TAG;
    set_part(k, JS_RSA_N, n);
    set_part(k, JS_RSA_E, e);
    return 0;
}

/* RSAPrivateKey (PKCS#1) */
static int rsa_private(JSKeyData *k, Der in) {
    Der seq, v;
    uint32_t version;
    if (!der_expect(&in, DER_SEQ, &seq) || !der_small_uint(&seq, &version)) return KEY_ERR_TAG;
    for (int i = 0; i < 8; i++) {
        if (!der_uint(&seq, &v)) return KEY_ERR_TAG;
        set_part(k, i, v);
    }
    return 0;
}

/* ECPrivateKey (SEC1): the curve from its parameters, or the one already known. */
static int ec_private(JSKeyData *k, Der in) {
    Der seq, d, f, oid, pub;
    uint32_t version;
    if (!der_expect(&in, DER_SEQ, &seq) || !der_small_uint(&seq, &version) || !der_expect(&seq, DER_OCTET_STRING, &d)) return KEY_ERR_TAG;
    if (der_optional(&seq, DER_CTX(0), &f)) {
        if (!der_expect(&f, DER_OID, &oid)) return KEY_ERR_TAG;
        k->curve = curve_by_oid(oid);
    }
    int ci = curve_index(k->curve);
    if (ci < 0) return KEY_ERR_KEY_TYPE;
    k->kind = JS_ASYM_EC;
    set_part_fixed(k, JS_EC_PRIV, d.p, d.n, CURVES[ci].size);
    if (der_optional(&seq, DER_CTX(1), &f) && der_expect(&f, DER_BIT_STRING, &pub) && pub.n > 1 && pub.p[0] == 0) {
        js_key_part_set(&k->part[JS_EC_PUB], pub.p + 1, pub.n - 1);
        return 0;
    }
    return ec_compute_pub(k) ? 0 : KEY_ERR_TAG;
}

/* SubjectPublicKeyInfo */
static int spki(JSKeyData *k, Der in) {
    Der seq, alg, bits;
    if (!der_expect(&in, DER_SEQ, &seq) || !der_expect(&seq, DER_SEQ, &alg)) return KEY_ERR_TAG;
    int e = algorithm_identifier(k, alg);
    if (e) return e;
    if (!der_expect(&seq, DER_BIT_STRING, &bits) || bits.n < 1 || bits.p[0] != 0) return KEY_ERR_TAG;
    Der key = { bits.p + 1, bits.n - 1 };
    if (k->kind == JS_ASYM_RSA || k->kind == JS_ASYM_RSA_PSS) return rsa_public(k, key);
    if (k->kind == JS_ASYM_DH || k->kind == JS_ASYM_DSA) {
        Der y;
        if (!der_uint(&key, &y)) return KEY_ERR_TAG;
        set_part(k, k->kind == JS_ASYM_DH ? JS_DH_PUB : JS_DSA_PUB, y);
        return 0;
    }
    if ((k->kind == JS_ASYM_X25519 || k->kind == JS_ASYM_ED25519) && key.n != 32) return KEY_ERR_TAG;
    if (k->kind == JS_ASYM_EC && (key.n != 1 + 2u * CURVES[curve_index(k->curve)].size || key.p[0] != 4)) return KEY_ERR_TAG;
    js_key_part_set(&k->part[JS_EC_PUB], key.p, key.n);
    return 0;
}

/* PrivateKeyInfo (PKCS#8) */
static int pkcs8(JSKeyData *k, Der in) {
    Der seq, alg, priv;
    uint32_t version;
    if (!der_expect(&in, DER_SEQ, &seq) || !der_small_uint(&seq, &version) || !der_expect(&seq, DER_SEQ, &alg)) return KEY_ERR_TAG;
    int e = algorithm_identifier(k, alg);
    if (e) return e;
    if (!der_expect(&seq, DER_OCTET_STRING, &priv)) return KEY_ERR_TAG;
    switch (k->kind) {
    case JS_ASYM_RSA:
    case JS_ASYM_RSA_PSS:
        return rsa_private(k, priv);
    case JS_ASYM_EC:
        return ec_private(k, priv);
    case JS_ASYM_DH:
    case JS_ASYM_DSA: {
        Der x;
        if (!der_uint(&priv, &x)) return KEY_ERR_TAG;
        set_part(k, k->kind == JS_ASYM_DH ? JS_DH_PRIV : JS_DSA_PRIV, x);
        return ff_compute_pub(k) ? 0 : KEY_ERR_TAG;
    }
    default: {
        Der scalar;
        if (!der_expect(&priv, DER_OCTET_STRING, &scalar) || scalar.n != 32) return KEY_ERR_TAG;
        js_key_part_set(&k->part[JS_EC_PRIV], scalar.p, 32);
        return ec_compute_pub(k) ? 0 : KEY_ERR_TAG;
    }
    }
}

/* An X.509 certificate's subjectPublicKeyInfo. */
static int certificate(JSKeyData *k, Der in) {
    Der cert, tbs, f;
    if (!der_expect(&in, DER_SEQ, &cert) || !der_expect(&cert, DER_SEQ, &tbs)) return KEY_ERR_TAG;
    der_optional(&tbs, DER_CTX(0), &f);  /* version */
    uint8_t tag;
    for (int i = 0; i < 5; i++)  /* serialNumber, signature, issuer, validity, subject */
        if (!der_read(&tbs, &tag, &f)) return KEY_ERR_TAG;
    Der spki_tlv = tbs;
    if (!der_read(&tbs, &tag, &f)) return KEY_ERR_TAG;
    spki_tlv.n = (size_t)(tbs.p - spki_tlv.p);
    return spki(k, spki_tlv);
}

/* ---- Encoding ----------------------------------------------------------------------------------- */

static void w_hash_alg(JSBytesOut *o, const JSHashAlg *h) {
    JSBytesOut a = { 0 };
    w_tlv(&a, DER_OID, h->oid + 1, h->oid[0]);
    w_tlv(&a, DER_NULL, NULL, 0);
    w_wrap(o, DER_SEQ, &a);
}

/* The key's AlgorithmIdentifier. */
static void w_algorithm(JSBytesOut *o, const JSKeyData *k) {
    JSBytesOut a = { 0 };
    switch (k->kind) {
    case JS_ASYM_RSA:
        w_tlv(&a, DER_OID, OID_RSA, sizeof OID_RSA);
        w_tlv(&a, DER_NULL, NULL, 0);
        break;
    case JS_ASYM_RSA_PSS:
        w_tlv(&a, DER_OID, OID_RSA_PSS, sizeof OID_RSA_PSS);
        if (k->pss_params) {  /* the fields that aren't their defaults, as OpenSSL writes them */
            JSBytesOut p = { 0 }, f = { 0 };
            const JSHashAlg *sha1 = js_hash_by_name("sha1");
            if (k->pss_hash != sha1) {
                w_hash_alg(&f, k->pss_hash);
                w_wrap(&p, DER_CTX(0), &f);
            }
            if (k->pss_mgf1 != sha1) {
                JSBytesOut m = { 0 };
                w_tlv(&m, DER_OID, OID_MGF1, sizeof OID_MGF1);
                w_hash_alg(&m, k->pss_mgf1);
                w_wrap(&f, DER_SEQ, &m);
                w_wrap(&p, DER_CTX(1), &f);
            }
            if (k->pss_salt != 20) {
                w_small_uint(&f, k->pss_salt);
                w_wrap(&p, DER_CTX(2), &f);
            }
            w_wrap(&a, DER_SEQ, &p);
        }
        break;
    case JS_ASYM_EC: {
        int ci = curve_index(k->curve);
        w_tlv(&a, DER_OID, OID_EC, sizeof OID_EC);
        w_tlv(&a, DER_OID, CURVES[ci].oid, CURVES[ci].oid_len);
        break;
    }
    case JS_ASYM_ED25519:
        w_tlv(&a, DER_OID, OID_ED25519, sizeof OID_ED25519);
        break;
    case JS_ASYM_DH:
    case JS_ASYM_DSA: {
        bool dh = k->kind == JS_ASYM_DH;
        JSBytesOut p = { 0 };
        w_tlv(&a, DER_OID, dh ? OID_DH : OID_DSA, dh ? sizeof OID_DH : sizeof OID_DSA);
        for (int i = 0; i < (dh ? 2 : 3); i++) w_uint(&p, k->part[i].p, k->part[i].n);
        w_wrap(&a, DER_SEQ, &p);
        break;
    }
    default:
        w_tlv(&a, DER_OID, OID_X25519, sizeof OID_X25519);
        break;
    }
    w_wrap(o, DER_SEQ, &a);
}

static void w_rsa_public(JSBytesOut *o, const JSKeyData *k) {
    JSBytesOut s = { 0 };
    w_uint(&s, k->part[JS_RSA_N].p, k->part[JS_RSA_N].n);
    w_uint(&s, k->part[JS_RSA_E].p, k->part[JS_RSA_E].n);
    w_wrap(o, DER_SEQ, &s);
}

static void w_rsa_private(JSBytesOut *o, const JSKeyData *k) {
    JSBytesOut s = { 0 };
    w_small_uint(&s, 0);
    for (int i = 0; i < 8; i++) w_uint(&s, k->part[i].p, k->part[i].n);
    w_wrap(o, DER_SEQ, &s);
}

/* ECPrivateKey, with its parameters (SEC1's form) or without (inside PKCS#8, as OpenSSL writes it) */
static void w_ec_private(JSBytesOut *o, const JSKeyData *k, bool with_params) {
    JSBytesOut s = { 0 }, f = { 0 };
    w_small_uint(&s, 1);
    w_tlv(&s, DER_OCTET_STRING, k->part[JS_EC_PRIV].p, k->part[JS_EC_PRIV].n);
    if (with_params) {
        int ci = curve_index(k->curve);
        w_tlv(&f, DER_OID, CURVES[ci].oid, CURVES[ci].oid_len);
        w_wrap(&s, DER_CTX(0), &f);
    }
    JSBytesOut bits = { 0 };
    static const uint8_t unused = 0;
    w_raw(&bits, &unused, 1);
    w_raw(&bits, k->part[JS_EC_PUB].p, k->part[JS_EC_PUB].n);
    w_tlv(&f, DER_BIT_STRING, bits.p, bits.n);
    free(bits.p);
    w_wrap(&s, DER_CTX(1), &f);
    w_wrap(o, DER_SEQ, &s);
}

static void w_spki(JSBytesOut *o, const JSKeyData *k) {
    JSBytesOut s = { 0 }, key = { 0 };
    w_algorithm(&s, k);
    static const uint8_t unused = 0;
    w_raw(&key, &unused, 1);
    if (k->kind == JS_ASYM_RSA || k->kind == JS_ASYM_RSA_PSS) w_rsa_public(&key, k);
    else if (k->kind == JS_ASYM_DH) w_uint(&key, k->part[JS_DH_PUB].p, k->part[JS_DH_PUB].n);
    else if (k->kind == JS_ASYM_DSA) w_uint(&key, k->part[JS_DSA_PUB].p, k->part[JS_DSA_PUB].n);
    else w_raw(&key, k->part[JS_EC_PUB].p, k->part[JS_EC_PUB].n);
    w_tlv(&s, DER_BIT_STRING, key.p, key.n);
    free(key.p);
    w_wrap(o, DER_SEQ, &s);
}

static void w_pkcs8(JSBytesOut *o, const JSKeyData *k) {
    JSBytesOut s = { 0 }, priv = { 0 };
    w_small_uint(&s, 0);
    w_algorithm(&s, k);
    if (k->kind == JS_ASYM_RSA || k->kind == JS_ASYM_RSA_PSS) w_rsa_private(&priv, k);
    else if (k->kind == JS_ASYM_EC) w_ec_private(&priv, k, false);
    else if (k->kind == JS_ASYM_DH) w_uint(&priv, k->part[JS_DH_PRIV].p, k->part[JS_DH_PRIV].n);
    else if (k->kind == JS_ASYM_DSA) w_uint(&priv, k->part[JS_DSA_PRIV].p, k->part[JS_DSA_PRIV].n);
    else w_tlv(&priv, DER_OCTET_STRING, k->part[JS_EC_PRIV].p, k->part[JS_EC_PRIV].n);
    w_wrap(&s, DER_OCTET_STRING, &priv);
    w_wrap(o, DER_SEQ, &s);
}

/* the largest RSA key generated (OpenSSL's limit) */
#define RSA_MAX_BITS 16384

/* ---- The handle's primitives -------------------------------------------------------------------- */

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED_PRIMITIVE_ARGS (void)callee, (void)this_val, (void)new_target

/* The encodings, by the code the prelude passes */
enum { ENC_SPKI, ENC_PKCS1, ENC_PKCS8, ENC_SEC1, ENC_CERT };

static JSKeyData *key_arg(JSContext *ctx, JSValue v) {
    JSKeyData *k = js_key_data(v);
    if (!k) js_discard(js_throw_type_error(ctx, "crypto: a key handle expected"));
    return k;
}

int js_key_parse_der(JSContext *ctx, const uint8_t *p, size_t n, int enc, bool priv, JSValue *out) {
    JSKeyData *k = js_new_asym_key(ctx, priv ? JS_KEY_PRIVATE : JS_KEY_PUBLIC, JS_ASYM_NONE);
    Der in = { p, n };
    int e;
    switch (enc) {
    case ENC_SPKI: e = spki(k, in); break;
    case ENC_PKCS8: e = pkcs8(k, in); break;
    case ENC_SEC1: k->curve = -1; e = ec_private(k, in); break;
    case ENC_CERT: e = certificate(k, in); break;
    default:
        k->kind = JS_ASYM_RSA;
        e = priv ? rsa_private(k, in) : rsa_public(k, in);
        break;
    }
    *out = js_object_value(&k->obj);
    return e;
}

/* cryptoKeyParse(der, encoding, private): a key handle, or an error code (KEY_ERR_*). */
PRIMITIVE(js_crypto_key_parse) {
    UNUSED_PRIMITIVE_ARGS;
    uint8_t *p;
    size_t n;
    if (!js_buffer_source_bytes(ARG(0), &p, &n) || !js_is_number(ARG(1))) return js_throw_type_error(ctx, "cryptoKeyParse: bad arguments");
    JSValue key;
    int e = js_key_parse_der(ctx, p, n, (int)js_as_number(ARG(1)), js_truthy(ARG(2)), &key);
    return e ? js_int32(e) : key;
}

int js_key_export_der(const JSKeyData *k, int enc, JSBytesOut *o) {
    switch (enc) {
    case ENC_SPKI: w_spki(o, k); return 0;
    case ENC_PKCS8: w_pkcs8(o, k); return 0;
    case ENC_PKCS1:
        if (k->kind != JS_ASYM_RSA) return KEY_ERR_ENCODING;
        if (k->type == JS_KEY_PRIVATE) w_rsa_private(o, k);
        else w_rsa_public(o, k);
        return 0;
    case ENC_SEC1:
        if (k->kind != JS_ASYM_EC) return KEY_ERR_ENCODING;
        w_ec_private(o, k, true);
        return 0;
    default:
        return KEY_ERR_ENCODING;
    }
}

/* cryptoKeyExport(handle, encoding): DER, a Buffer, or KEY_ERR_ENCODING. */
PRIMITIVE(js_crypto_key_export) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = key_arg(ctx, ARG(0));
    if (!k) return JS_EXCEPTION;
    JSBytesOut o = { 0 };
    int e = js_key_export_der(k, js_is_number(ARG(1)) ? (int)js_as_number(ARG(1)) : -1, &o);
    if (e) return js_int32(e);
    JSValue r = js_new_buffer_from_bytes(ctx, o.p, o.n);
    free(o.p);
    return r;
}

static const char *const KINDS[] = { NULL, "rsa", "rsa-pss", "ec", "x25519", "ed25519", "dh", "dsa" };

/* cryptoKeyInfo(handle): [type, asymmetricKeyType, namedCurve, pss], pss [hash, mgf1, salt] or null. */
PRIMITIVE(js_crypto_key_info) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = key_arg(ctx, ARG(0));
    if (!k) return JS_EXCEPTION;
    static const char *const TYPES[] = { "secret", "public", "private" };
    JSValue a = js_new_array(ctx, 4);
    int ci = curve_index(k->curve);
    JSValue pss = JS_NULL;
    if (k->pss_params) {
        pss = js_new_array(ctx, 3);
        if (js_array_append(ctx, pss, js_new_string_cstr(ctx, k->pss_hash->name)) < 0 ||
            js_array_append(ctx, pss, js_new_string_cstr(ctx, k->pss_mgf1->name)) < 0 ||
            js_array_append(ctx, pss, js_number(k->pss_salt)) < 0)
            return JS_EXCEPTION;
    }
    JSValue items[4] = { js_new_string_cstr(ctx, TYPES[k->type]), KINDS[k->kind] ? js_new_string_cstr(ctx, KINDS[k->kind]) : JS_UNDEFINED,
                         ci >= 0 ? js_new_string_cstr(ctx, CURVES[ci].name) : JS_UNDEFINED, pss };
    for (int i = 0; i < 4; i++)
        if (js_array_append(ctx, a, items[i]) < 0) return JS_EXCEPTION;
    return a;
}

/* cryptoKeyParts(handle): the parts as Buffers (undefined when absent): RSA's n, e, d, p, q, dp,
 * dq, qi; an EC or X25519 key's public point and private scalar. */
PRIMITIVE(js_crypto_key_parts) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = key_arg(ctx, ARG(0));
    if (!k) return JS_EXCEPTION;
    JSValue a = js_new_array(ctx, JS_KEY_PARTS);
    for (int i = 0; i < JS_KEY_PARTS; i++) {
        JSValue v = k->part[i].p ? js_new_buffer_from_bytes(ctx, k->part[i].p, k->part[i].n) : JS_UNDEFINED;
        if (js_is_exception(v) || js_array_append(ctx, a, v) < 0) return JS_EXCEPTION;
    }
    return a;
}

int js_key_from_parts(JSContext *ctx, int kind, bool priv, int curve, const JSKeyPart parts[JS_KEY_PARTS], JSValue *out) {
    JSKeyData *k = js_new_asym_key(ctx, priv ? JS_KEY_PRIVATE : JS_KEY_PUBLIC, (uint8_t)kind);
    *out = js_object_value(&k->obj);
    for (int i = 0; i < JS_KEY_PARTS; i++)
        if (parts[i].p) js_key_part_set(&k->part[i], parts[i].p, parts[i].n);
    if (kind == JS_ASYM_RSA || kind == JS_ASYM_DH || kind == JS_ASYM_DSA) {
        for (int i = 0; i < JS_KEY_PARTS; i++) {  /* minimal integers */
            JSKeyPart *pt = &k->part[i];
            size_t z = 0;
            while (pt->p && z + 1 < pt->n && pt->p[z] == 0) z++;
            if (z) memmove(pt->p, pt->p + z, pt->n -= z);
        }
        if (kind != JS_ASYM_RSA && priv && !k->part[kind == JS_ASYM_DH ? JS_DH_PUB : JS_DSA_PUB].p && !ff_compute_pub(k)) return KEY_ERR_TAG;
        return 0;
    }
    k->curve = kind == JS_ASYM_X25519 ? JS_EC_X25519 : kind == JS_ASYM_ED25519 ? JS_EC_ED25519 : curve;
    if (kind == JS_ASYM_EC) {
        int ci = curve_index(curve);
        if (ci < 0) return KEY_ERR_KEY_TYPE;
        if (priv) set_part_fixed(k, JS_EC_PRIV, k->part[JS_EC_PRIV].p, k->part[JS_EC_PRIV].n, CURVES[ci].size);
    }
    if (priv && !ec_compute_pub(k)) return KEY_ERR_TAG;
    return 0;
}

int js_ec_curve_by_jwk(const char *crv) {
    for (int i = 0; i < (int)JS_COUNTOF(CURVES); i++)
        if (strcmp(crv, CURVES[i].jwk) == 0) return CURVES[i].curve;
    return -1;
}

const char *js_ec_curve_jwk(int curve) {
    int ci = curve_index(curve);
    return ci < 0 ? NULL : CURVES[ci].jwk;
}

/* cryptoKeyFromParts(kind, private, curve, parts): a key from a JWK's parts (Buffers, as
 * cryptoKeyParts gives them; EC's public point uncompressed); an error code for a curve or kind
 * not provided. */
PRIMITIVE(js_crypto_key_from_parts) {
    UNUSED_PRIMITIVE_ARGS;
    char kind[16] = "", curve[16] = "";
    JSValue parts = ARG(3);
    if (!js_is_string(ARG(0)) || !js_is_array(parts)) return js_throw_type_error(ctx, "cryptoKeyFromParts: bad arguments");
    js_view_to_utf8(js_string_view(ctx, ARG(0)), kind, sizeof kind - 1);
    if (js_is_string(ARG(2))) js_view_to_utf8(js_string_view(ctx, ARG(2)), curve, sizeof curve - 1);
    JSKeyPart got[JS_KEY_PARTS] = { { 0 } };
    for (int i = 0; i < JS_KEY_PARTS; i++) {
        JSValue v = js_get_elem(ctx, parts, js_int32(i));
        if (js_is_exception(v)) return v;
        uint8_t *p;
        size_t n;
        if (js_buffer_source_bytes(v, &p, &n)) got[i].p = p, got[i].n = n;
    }
    int k = strcmp(kind, "rsa") == 0 ? JS_ASYM_RSA : strcmp(kind, "x25519") == 0 ? JS_ASYM_X25519 : strcmp(kind, "ed25519") == 0 ? JS_ASYM_ED25519
          : strcmp(kind, "dh") == 0 ? JS_ASYM_DH : strcmp(kind, "dsa") == 0 ? JS_ASYM_DSA : JS_ASYM_EC;
    JSValue key;
    int e = js_key_from_parts(ctx, k, js_truthy(ARG(1)), js_ec_curve_by_jwk(curve), got, &key);
    return e ? js_int32(e) : key;
}

/* cryptoKeyPublic(handle): the public key of a private one (a new handle). */
JSValue js_key_public(JSContext *ctx, JSValue private_key) {
    JSKeyData *k = js_new_asym_key(ctx, JS_KEY_PUBLIC, js_key_data(private_key)->kind);
    JSKeyData *src = js_key_data(private_key);
    k->curve = src->curve;
    k->pss_params = src->pss_params, k->pss_hash = src->pss_hash, k->pss_mgf1 = src->pss_mgf1, k->pss_salt = src->pss_salt;
    if (src->kind == JS_ASYM_RSA || src->kind == JS_ASYM_RSA_PSS) {
        js_key_part_set(&k->part[JS_RSA_N], src->part[JS_RSA_N].p, src->part[JS_RSA_N].n);
        js_key_part_set(&k->part[JS_RSA_E], src->part[JS_RSA_E].p, src->part[JS_RSA_E].n);
    } else if (src->kind == JS_ASYM_DH || src->kind == JS_ASYM_DSA) {  /* the parameters and the public key */
        int n = src->kind == JS_ASYM_DH ? JS_DH_PRIV : JS_DSA_PRIV;
        for (int i = 0; i < n; i++) js_key_part_set(&k->part[i], src->part[i].p, src->part[i].n);
    } else {
        js_key_part_set(&k->part[JS_EC_PUB], src->part[JS_EC_PUB].p, src->part[JS_EC_PUB].n);
    }
    return js_object_value(&k->obj);
}

PRIMITIVE(js_crypto_key_public) {
    UNUSED_PRIMITIVE_ARGS;
    if (!key_arg(ctx, ARG(0))) return JS_EXCEPTION;
    return js_key_public(ctx, ARG(0));
}

/* cryptoKeyEquals(a, b): the same type and the same key. */
PRIMITIVE(js_crypto_key_equals) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *a = key_arg(ctx, ARG(0)), *b = a ? key_arg(ctx, ARG(1)) : NULL;
    if (!a || !b) return JS_EXCEPTION;
    if (a->type != b->type || a->kind != b->kind) return JS_FALSE;
    if (a->type == JS_KEY_SECRET) return js_bool(a->len == b->len && js_crypto_equal(a->bytes, b->bytes, a->len));
    JSBytesOut x = { 0 }, y = { 0 };
    if (a->type == JS_KEY_PUBLIC) w_spki(&x, a), w_spki(&y, b);
    else w_pkcs8(&x, a), w_pkcs8(&y, b);
    bool eq = x.n == y.n && js_crypto_equal(x.p, y.p, x.n);
    free(x.p), free(y.p);
    return js_bool(eq);
}

/* cryptoKeySecret(bytes): a secret key handle holding a copy. */
PRIMITIVE(js_crypto_key_secret) {
    UNUSED_PRIMITIVE_ARGS;
    uint8_t *p;
    size_t n;
    if (!js_buffer_source_bytes(ARG(0), &p, &n)) return js_throw_type_error(ctx, "cryptoKeySecret: bytes expected");
    return js_new_secret_key(ctx, p, n);
}

/* cryptoKeySecretBytes(handle): a copy of a secret key's bytes, a Buffer. */
PRIMITIVE(js_crypto_key_secret_bytes) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = key_arg(ctx, ARG(0));
    if (!k) return JS_EXCEPTION;
    return js_new_buffer_from_bytes(ctx, k->bytes, k->len);
}

int js_key_generate_rsa(JSContext *ctx, bool pss, uint32_t bits, uint32_t e, JSValue *out) {
    if (bits < 512 || bits > RSA_MAX_BITS || e < 3 || !(e & 1)) return KEY_ERR_GENERATE;
    RSA *r = RSA_new();
    BIGNUM *be = BN_new();
    int err = KEY_ERR_GENERATE;
    if (r && be && BN_set_word(be, e) && RSA_generate_key_ex(r, (int)bits, be, NULL)) {
        JSKeyData *k = js_new_asym_key(ctx, JS_KEY_PRIVATE, pss ? JS_ASYM_RSA_PSS : JS_ASYM_RSA);
        const BIGNUM *parts[8] = {
            RSA_get0_n(r), RSA_get0_e(r), RSA_get0_d(r), RSA_get0_p(r), RSA_get0_q(r), RSA_get0_dmp1(r), RSA_get0_dmq1(r), RSA_get0_iqmp(r),
        };
        uint8_t *buf = malloc(RSA_MAX_BITS / 8 + 1);
        if (!buf) js_fatal("out of memory in crypto");
        for (int i = 0; i < 8; i++) {
            size_t n = BN_bn2bin(parts[i], buf);
            if (n == 0) buf[0] = 0, n = 1;
            js_key_part_set(&k->part[i], buf, n);
        }
        memset(buf, 0, RSA_MAX_BITS / 8 + 1);
        free(buf);
        *out = js_object_value(&k->obj);
        err = 0;
    }
    BN_free(be);
    RSA_free(r);
    ERR_clear_error();
    return err;
}

int js_key_generate_ec(JSContext *ctx, int curve, JSValue *out) {
    if (curve != JS_EC_X25519 && curve != JS_EC_ED25519 && curve_index(curve) < 0) return KEY_ERR_GENERATE;
    JSKeyData *k = js_new_asym_key(ctx, JS_KEY_PRIVATE, curve == JS_EC_X25519 ? JS_ASYM_X25519 : curve == JS_EC_ED25519 ? JS_ASYM_ED25519 : JS_ASYM_EC);
    k->curve = curve;
    if (curve == JS_EC_ED25519) {
        uint8_t pub[32], priv[64];
        ED25519_keypair(pub, priv);
        js_key_part_set(&k->part[JS_EC_PRIV], priv, 32);  /* the seed */
        js_key_part_set(&k->part[JS_EC_PUB], pub, 32);
        memset(priv, 0, sizeof priv);
        *out = js_object_value(&k->obj);
        return 0;
    }
    if (curve == JS_EC_X25519) {
        uint8_t pub[32], priv[32];
        X25519_keypair(pub, priv);
        js_key_part_set(&k->part[JS_EC_PRIV], priv, 32);
        js_key_part_set(&k->part[JS_EC_PUB], pub, 32);
        memset(priv, 0, sizeof priv);
        *out = js_object_value(&k->obj);
        return 0;
    }
    int nid = curve == JS_EC_P256 ? NID_X9_62_prime256v1 : curve == JS_EC_P384 ? NID_secp384r1 : NID_secp521r1;
    EC_KEY *key = EC_KEY_new_by_curve_name(nid);
    int err = KEY_ERR_GENERATE;
    if (key && EC_KEY_generate_key(key)) {
        size_t fs = CURVES[curve_index(curve)].size;
        uint8_t priv[66];
        BN_bn2bin_padded(priv, fs, EC_KEY_get0_private_key(key));
        js_key_part_set(&k->part[JS_EC_PRIV], priv, fs);
        memset(priv, 0, sizeof priv);
        if (ec_compute_pub(k)) {
            *out = js_object_value(&k->obj);
            err = 0;
        }
    }
    EC_KEY_free(key);
    ERR_clear_error();
    return err;
}

/* DSA parameters of L and N bits (q prime of N bits, p prime of L bits with q dividing p − 1, g of
 * order q), then a key: any (L, N), as OpenSSL's divisorLength allows */
int js_key_generate_dsa(JSContext *ctx, uint32_t l, uint32_t n, JSValue *out) {
    if (l < 512 || l > 10000 || n < 160 || n >= l) return KEY_ERR_GENERATE;
    BIGNUM *q = BN_new(), *q2 = BN_new(), *one = BN_new(), *p = BN_new(), *e = BN_new(), *g = BN_new(), *h = BN_new(), *x = BN_new();
    BN_CTX *bc = BN_CTX_new();
    bool ok = q && q2 && one && p && e && g && h && x && bc && BN_one(one) &&
              BN_generate_prime_ex(q, (int)n, 0, NULL, NULL, NULL) && BN_lshift1(q2, q) &&
              BN_generate_prime_ex(p, (int)l, 0, q2, one, NULL);  /* p ≡ 1 (mod 2q) */
    /* g = h^((p − 1)/q) mod p for the first h from 2 that gives more than 1 */
    ok = ok && BN_sub(e, p, one) && BN_div(e, NULL, e, q, bc);
    for (unsigned w = 2; ok; w++) {
        ok = BN_set_word(h, w) && BN_mod_exp_mont(g, h, e, p, bc, NULL);
        if (ok && !BN_is_one(g)) break;
    }
    /* x in [1, q − 1] */
    ok = ok && BN_rand_range_ex(x, 1, q);
    int err = KEY_ERR_GENERATE;
    if (ok) {
        JSKeyData *k = js_new_asym_key(ctx, JS_KEY_PRIVATE, JS_ASYM_DSA);
        const BIGNUM *parts[4] = { p, q, g, NULL };
        parts[3] = x;
        int idx[4] = { JS_DSA_P, JS_DSA_Q, JS_DSA_G, JS_DSA_PRIV };
        uint8_t *buf = malloc(l / 8 + 2);
        if (!buf) js_fatal("out of memory in crypto");
        for (int i = 0; i < 4; i++) {
            size_t len = BN_bn2bin(parts[i], buf);
            js_key_part_set(&k->part[idx[i]], buf, len);
        }
        free(buf);
        if (ff_compute_pub(k)) {
            *out = js_object_value(&k->obj);
            err = 0;
        }
    }
    BN_free(q), BN_free(q2), BN_free(one), BN_free(p), BN_free(e), BN_free(g), BN_free(h), BN_clear_free(x), BN_CTX_free(bc);
    ERR_clear_error();
    return err;
}

/* cryptoKeyGenerate(kind, sizeOrCurve, publicExponent, pss): a private key handle, or
 * KEY_ERR_GENERATE. RSA's size in bits; EC's curve by Node's name; pss [hash, mgf1, salt] or null. */
PRIMITIVE(js_crypto_key_generate) {
    UNUSED_PRIMITIVE_ARGS;
    char kind[16] = "";
    if (!js_is_string(ARG(0))) return js_throw_type_error(ctx, "cryptoKeyGenerate: bad arguments");
    js_view_to_utf8(js_string_view(ctx, ARG(0)), kind, sizeof kind - 1);
    JSValue key;
    if (strcmp(kind, "dsa") == 0) {  /* (L, N) */
        double l = js_is_number(ARG(1)) ? js_as_number(ARG(1)) : 0, n = js_is_number(ARG(2)) ? js_as_number(ARG(2)) : 0;
        if (l < 0 || l > 10000 || n < 0 || n > 10000) return js_int32(KEY_ERR_GENERATE);
        int err = js_key_generate_dsa(ctx, (uint32_t)l, (uint32_t)n, &key);
        return err ? js_int32(err) : key;
    }
    if (strcmp(kind, "rsa") == 0 || strcmp(kind, "rsa-pss") == 0) {
        double bits = js_is_number(ARG(1)) ? js_as_number(ARG(1)) : 0, e = js_is_number(ARG(2)) ? js_as_number(ARG(2)) : 65537;
        if (bits < 0 || bits > RSA_MAX_BITS || e < 0 || e > 4294967295.0) return js_int32(KEY_ERR_GENERATE);
        int err = js_key_generate_rsa(ctx, kind[3] != 0, (uint32_t)bits, (uint32_t)e, &key);
        if (err) return js_int32(err);
        JSKeyData *k = js_key_data(key);
        if (kind[3] && js_is_array(ARG(3))) {
            JSValue h = js_get_elem(ctx, ARG(3), js_int32(0)), m = js_get_elem(ctx, ARG(3), js_int32(1)), s = js_get_elem(ctx, ARG(3), js_int32(2));
            char hn[32] = "", mn[32] = "";
            if (js_is_string(h)) js_view_to_utf8(js_string_view(ctx, h), hn, sizeof hn - 1);
            if (js_is_string(m)) js_view_to_utf8(js_string_view(ctx, m), mn, sizeof mn - 1);
            k->pss_params = true;
            k->pss_hash = js_hash_by_name(hn[0] ? hn : "sha1");
            k->pss_mgf1 = mn[0] ? js_hash_by_name(mn) : k->pss_hash;
            k->pss_salt = js_is_number(s) ? (uint32_t)js_as_number(s) : 20;
            if (!k->pss_hash || !k->pss_mgf1) k->pss_params = false;
        }
        return key;
    }
    int curve = -1;
    if (strcmp(kind, "x25519") == 0) {
        curve = JS_EC_X25519;
    } else if (strcmp(kind, "ed25519") == 0) {
        curve = JS_EC_ED25519;
    } else {
        char name[24] = "";
        if (js_is_string(ARG(1))) js_view_to_utf8(js_string_view(ctx, ARG(1)), name, sizeof name - 1);
        for (int i = 0; i < (int)JS_COUNTOF(CURVES); i++)
            if (strcmp(name, CURVES[i].name) == 0 || strcmp(name, CURVES[i].jwk) == 0) curve = CURVES[i].curve;
        if (curve < 0) return js_int32(KEY_ERR_GENERATE);
    }
    int err = js_key_generate_ec(ctx, curve, &key);
    return err ? js_int32(err) : key;
}
