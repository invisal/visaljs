/* Asymmetric operations on the key record: RSA signatures (PKCS#1 v1.5 and PSS
 * encodings of our own, so any hash works and a verifier can recover a PSS salt's length, over
 * BoringSSL's raw RSA), ECDSA (BoringSSL; DER or IEEE P1363 signatures), RSA encryption (OAEP's
 * and PKCS#1 v1.5's paddings ours), and key agreement (EC Diffie-Hellman and X25519), with point
 * compression. The primitives at the end serve node:crypto; Web Crypto calls the functions above. */
#include <stdlib.h>
#include <string.h>

#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/curve25519.h>
#include <openssl/dsa.h>
#include <openssl/ec.h>
#include <openssl/ec_key.h>
#include <openssl/ecdh.h>
#include <openssl/ecdsa.h>
#include <openssl/err.h>
#include <openssl/mem.h>
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

/* ---- Keys as BoringSSL takes them --------------------------------------------------------------- */

static size_t bit_length(const JSKeyPart *n) {
    size_t i = 0;
    while (i < n->n && n->p[i] == 0) i++;
    if (i == n->n) return 0;
    size_t bits = (n->n - i - 1) * 8;
    for (uint8_t top = n->p[i]; top; top >>= 1) bits++;
    return bits;
}

static size_t rsa_size(const JSKeyData *k) { return (bit_length(&k->part[JS_RSA_N]) + 7) / 8; }

static bool is_rsa(const JSKeyData *k) { return k->kind == JS_ASYM_RSA || k->kind == JS_ASYM_RSA_PSS; }

static BIGNUM *bn_of(const JSKeyPart *p) { return p->p ? BN_bin2bn(p->p, p->n, NULL) : NULL; }

/* The key as BoringSSL's RSA: its private half too with `priv` (any exponent, as OpenSSL takes) */
static RSA *rsa_of(const JSKeyData *k, bool priv) {
    BIGNUM *b[JS_KEY_PARTS];
    for (int i = 0; i < JS_KEY_PARTS; i++) b[i] = bn_of(&k->part[i]);
    RSA *r;
    if (!priv) r = RSA_new_public_key_large_e(b[JS_RSA_N], b[JS_RSA_E]);
    else if (b[JS_RSA_P] && b[JS_RSA_Q] && b[JS_RSA_DP] && b[JS_RSA_DQ] && b[JS_RSA_QI])
        r = RSA_new_private_key_large_e(b[JS_RSA_N], b[JS_RSA_E], b[JS_RSA_D], b[JS_RSA_P], b[JS_RSA_Q], b[JS_RSA_DP], b[JS_RSA_DQ],
                                        b[JS_RSA_QI]);
    else r = RSA_new_private_key_no_crt(b[JS_RSA_N], b[JS_RSA_E], b[JS_RSA_D]);
    for (int i = 0; i < JS_KEY_PARTS; i++) BN_clear_free(b[i]);
    ERR_clear_error();
    return r;
}

/* x ← x^e mod n, in place over the modulus's length */
static bool rsa_public_op(const JSKeyData *k, uint8_t *x, size_t n) {
    RSA *r = rsa_of(k, false);
    if (!r) return false;
    uint8_t *out = malloc(n);
    if (!out) js_fatal("out of memory in crypto");
    size_t got;
    bool ok = RSA_verify_raw(r, &got, out, n, x, n, RSA_NO_PADDING) && got == n;
    if (ok) memcpy(x, out, n);
    free(out);
    RSA_free(r);
    ERR_clear_error();
    return ok;
}

/* x ← x^d mod n (CRT), in place */
static bool rsa_private_op(const JSKeyData *k, uint8_t *x) {
    RSA *r = rsa_of(k, true);
    if (!r) return false;
    size_t n = rsa_size(k), got;
    uint8_t *out = malloc(n);
    if (!out) js_fatal("out of memory in crypto");
    bool ok = RSA_sign_raw(r, &got, out, n, x, n, RSA_NO_PADDING) && got == n;
    if (ok) memcpy(x, out, n);
    memset(out, 0, n);
    free(out);
    RSA_free(r);
    ERR_clear_error();
    return ok;
}

static int ec_nid(int curve) {
    return curve == JS_EC_P256 ? NID_X9_62_prime256v1 : curve == JS_EC_P384 ? NID_secp384r1 : curve == JS_EC_P521 ? NID_secp521r1 : NID_undef;
}

/* The key as BoringSSL's EC_KEY: its private scalar too with `priv` */
static EC_KEY *ec_key_of(const JSKeyData *k, bool priv) {
    EC_KEY *key = EC_KEY_new_by_curve_name(ec_nid(k->curve));
    if (!key) return NULL;
    const EC_GROUP *g = EC_KEY_get0_group(key);
    EC_POINT *pt = EC_POINT_new(g);
    bool ok = pt && k->part[JS_EC_PUB].p && EC_POINT_oct2point(g, pt, k->part[JS_EC_PUB].p, k->part[JS_EC_PUB].n, NULL) &&
              EC_KEY_set_public_key(key, pt);
    EC_POINT_free(pt);
    if (ok && priv) {
        BIGNUM *d = bn_of(&k->part[JS_EC_PRIV]);
        ok = d && EC_KEY_set_private_key(key, d);
        BN_clear_free(d);
    }
    ERR_clear_error();
    if (!ok) {
        EC_KEY_free(key);
        return NULL;
    }
    return key;
}

/* ---- MGF1 (RFC 8017 B.2.1) ---------------------------------------------------------------------- */

static void mgf1_xor(const JSHashAlg *h, const uint8_t *seed, size_t seed_len, uint8_t *data, size_t n) {
    uint8_t block[64];
    for (uint32_t c = 0; n > 0; c++) {
        uint8_t be[4] = { (uint8_t)(c >> 24), (uint8_t)(c >> 16), (uint8_t)(c >> 8), (uint8_t)c };
        JSHashCtx ctx;
        js_hash_init(&ctx, h);
        js_hash_update(&ctx, seed, seed_len);
        js_hash_update(&ctx, be, 4);
        js_hash_final(&ctx, block, h->out_len);
        size_t take = n < h->out_len ? n : h->out_len;
        for (size_t i = 0; i < take; i++) data[i] ^= block[i];
        data += take;
        n -= take;
    }
}

/* ---- Signatures --------------------------------------------------------------------------------- */

/* EMSA-PSS-ENCODE, then the private operation: sig gets the modulus's length. */
static int pss_sign(const JSKeyData *k, const JSHashAlg *h, const JSHashAlg *mgf, const uint8_t *mhash, long salt_len, uint8_t *sig) {
    size_t mod_bits = bit_length(&k->part[JS_RSA_N]), em_bits = mod_bits - 1, em_len = (em_bits + 7) / 8, hlen = h->out_len;
    size_t max_salt = em_len >= hlen + 2 ? em_len - hlen - 2 : 0;
    size_t slen = salt_len == JS_SALT_DIGEST ? hlen : salt_len < 0 ? max_salt : (size_t)salt_len;
    if (em_len < hlen + slen + 2) return JS_ASYM_ERR_TOO_LARGE;  /* as OpenSSL reports it */
    uint8_t salt[1024], hh[64];
    if (slen > sizeof salt) return JS_ASYM_ERR_TOO_LARGE;
    js_crypto_random(salt, slen);
    static const uint8_t zeros[8] = { 0 };
    JSHashCtx ctx;
    js_hash_init(&ctx, h);
    js_hash_update(&ctx, zeros, 8);
    js_hash_update(&ctx, mhash, hlen);
    js_hash_update(&ctx, salt, slen);
    js_hash_final(&ctx, hh, hlen);
    size_t k_len = rsa_size(k), db_len = em_len - hlen - 1;
    uint8_t *em = sig + (k_len - em_len);
    memset(sig, 0, k_len);
    em[db_len - slen - 1] = 0x01;
    memcpy(em + db_len - slen, salt, slen);
    mgf1_xor(mgf, hh, hlen, em, db_len);
    em[0] &= (uint8_t)(0xFF >> (8 * em_len - em_bits));
    memcpy(em + db_len, hh, hlen);
    em[em_len - 1] = 0xBC;
    return rsa_private_op(k, sig) ? 0 : JS_ASYM_ERR_FAILED;
}

/* EMSA-PSS-VERIFY after the public operation; salt_len JS_SALT_AUTO recovers it. */
static bool pss_verify(const JSKeyData *k, const JSHashAlg *h, const JSHashAlg *mgf, const uint8_t *mhash, long salt_len,
                       const uint8_t *sig, size_t sig_len) {
    size_t k_len = rsa_size(k), mod_bits = bit_length(&k->part[JS_RSA_N]), em_bits = mod_bits - 1, em_len = (em_bits + 7) / 8;
    size_t hlen = h->out_len;
    if (sig_len != k_len || em_len < hlen + 2) return false;
    uint8_t *x = malloc(k_len);
    if (!x) js_fatal("out of memory in crypto");
    memcpy(x, sig, k_len);
    bool ok = rsa_public_op(k, x, k_len);
    uint8_t *em = x + (k_len - em_len);
    if (ok && k_len != em_len && x[0] != 0) ok = false;
    if (ok && em[em_len - 1] != 0xBC) ok = false;
    size_t db_len = em_len - hlen - 1;
    if (ok && (em[0] & ~(0xFF >> (8 * em_len - em_bits)))) ok = false;
    if (ok) {
        uint8_t hh[64];
        memcpy(hh, em + db_len, hlen);
        mgf1_xor(mgf, hh, hlen, em, db_len);
        em[0] &= (uint8_t)(0xFF >> (8 * em_len - em_bits));
        size_t i = 0;
        while (i < db_len && em[i] == 0) i++;
        size_t slen = i < db_len ? db_len - i - 1 : 0;
        if (i == db_len || em[i] != 0x01) ok = false;
        else if (salt_len == JS_SALT_DIGEST && slen != hlen) ok = false;
        else if (salt_len >= 0 && slen != (size_t)salt_len) ok = false;
        if (ok) {
            static const uint8_t zeros[8] = { 0 };
            uint8_t h2[64];
            JSHashCtx ctx;
            js_hash_init(&ctx, h);
            js_hash_update(&ctx, zeros, 8);
            js_hash_update(&ctx, mhash, hlen);
            js_hash_update(&ctx, em + i + 1, slen);
            js_hash_final(&ctx, h2, hlen);
            ok = js_crypto_equal(h2, hh, hlen);
        }
    }
    free(x);
    return ok;
}

/* EMSA-PKCS1-v1_5's T: the DigestInfo (with its NULL parameters, or without them) or, for
 * MD5+SHA-1, the digest alone. Its length, or 0 for a hash without an OID. */
static size_t digest_info(const JSHashAlg *h, const uint8_t *digest, bool with_null, uint8_t *t) {
    size_t hl = h->out_len;
    if (!h->oid) {
        if (strcmp(h->name, "md5-sha1") != 0) return 0;
        memcpy(t, digest, hl);
        return hl;
    }
    size_t ol = h->oid[0], alg = 2 + ol + (with_null ? 2 : 0), n = 0;
    t[n++] = 0x30, t[n++] = (uint8_t)(2 + alg + 2 + hl);
    t[n++] = 0x30, t[n++] = (uint8_t)alg;
    t[n++] = 0x06, t[n++] = (uint8_t)ol;
    memcpy(t + n, h->oid + 1, ol), n += ol;
    if (with_null) t[n++] = 0x05, t[n++] = 0x00;
    t[n++] = 0x04, t[n++] = (uint8_t)hl;
    memcpy(t + n, digest, hl);
    return n + hl;
}

/* 00 01 FF … FF 00 T, over the modulus's length: false when T doesn't fit */
static bool pkcs1_type1(uint8_t *em, size_t k_len, const uint8_t *t, size_t tl) {
    if (tl + 11 > k_len) return false;
    em[0] = 0, em[1] = 1;
    memset(em + 2, 0xFF, k_len - tl - 3);
    em[k_len - tl - 1] = 0;
    memcpy(em + k_len - tl, t, tl);
    return true;
}

/* The key as BoringSSL's DSA: its private value too with `priv` */
static DSA *dsa_of(const JSKeyData *k, bool priv) {
    DSA *d = DSA_new();
    if (!d) return NULL;
    BIGNUM *p = bn_of(&k->part[JS_DSA_P]), *q = bn_of(&k->part[JS_DSA_Q]), *g = bn_of(&k->part[JS_DSA_G]);
    BIGNUM *y = bn_of(&k->part[JS_DSA_PUB]), *x = priv ? bn_of(&k->part[JS_DSA_PRIV]) : NULL;
    if (!p || !q || !g || !y || (priv && !x) || !DSA_set0_pqg(d, p, q, g)) {
        BN_free(p), BN_free(q), BN_free(g), BN_free(y), BN_clear_free(x);
        DSA_free(d);
        return NULL;
    }
    if (!DSA_set0_key(d, y, x)) {
        BN_free(y), BN_clear_free(x);
        DSA_free(d);
        return NULL;
    }
    return d;
}

/* (r, s) as DER (Dss-Sig-Value) or IEEE P1363 (r || s, each q's length) */
static int dsa_sig_out(const BIGNUM *r, const BIGNUM *s, size_t qlen, bool p1363, JSBytesOut *out) {
    if (p1363) {
        out->p = malloc(2 * qlen);
        if (!out->p) js_fatal("out of memory in crypto");
        BN_bn2bin_padded(out->p, qlen, r);
        BN_bn2bin_padded(out->p + qlen, qlen, s);
        out->n = out->cap = 2 * qlen;
        return 0;
    }
    CBB cbb, seq;
    uint8_t *der;
    size_t n;
    if (!CBB_init(&cbb, 0) || !CBB_add_asn1(&cbb, &seq, CBS_ASN1_SEQUENCE) || !BN_marshal_asn1(&seq, r) || !BN_marshal_asn1(&seq, s) ||
        !CBB_finish(&cbb, &der, &n)) {
        CBB_cleanup(&cbb);
        return JS_ASYM_ERR_FAILED;
    }
    out->p = malloc(n);
    if (!out->p) js_fatal("out of memory in crypto");
    memcpy(out->p, der, n);
    out->n = out->cap = n;
    OPENSSL_free(der);
    return 0;
}

/* (r, s) from DER or P1363; false when it isn't one */
static bool dsa_sig_in(const uint8_t *sig, size_t n, size_t qlen, bool p1363, BIGNUM **r, BIGNUM **s) {
    *r = *s = NULL;
    if (p1363) {
        if (n != 2 * qlen) return false;
        *r = BN_bin2bn(sig, qlen, NULL);
        *s = BN_bin2bn(sig + qlen, qlen, NULL);
        return *r && *s;
    }
    CBS cbs, seq;
    CBS_init(&cbs, sig, n);
    *r = BN_new();
    *s = BN_new();
    return *r && *s && CBS_get_asn1(&cbs, &seq, CBS_ASN1_SEQUENCE) && CBS_len(&cbs) == 0 && BN_parse_asn1_unsigned(&seq, *r) &&
           BN_parse_asn1_unsigned(&seq, *s) && CBS_len(&seq) == 0;
}

static int dsa_sign(const JSKeyData *k, const uint8_t *digest, size_t dn, bool p1363, JSBytesOut *out) {
    DSA *d = dsa_of(k, true);
    if (!d) return JS_ASYM_ERR_FAILED;
    DSA_SIG *sig = DSA_do_sign(digest, dn, d);
    int err = JS_ASYM_ERR_FAILED;
    if (sig) {
        const BIGNUM *r, *s;
        DSA_SIG_get0(sig, &r, &s);
        err = dsa_sig_out(r, s, BN_num_bytes(DSA_get0_q(d)), p1363, out);
    }
    DSA_SIG_free(sig);
    DSA_free(d);
    ERR_clear_error();
    return err;
}

static bool dsa_verify(const JSKeyData *k, const uint8_t *digest, size_t dn, bool p1363, const uint8_t *sig, size_t sn) {
    DSA *d = dsa_of(k, false);
    if (!d) return false;
    BIGNUM *r, *s;
    bool valid = false;
    if (dsa_sig_in(sig, sn, BN_num_bytes(DSA_get0_q(d)), p1363, &r, &s)) {
        DSA_SIG *ds = DSA_SIG_new();
        int ok = 0;
        if (ds && DSA_SIG_set0(ds, r, s)) {
            r = s = NULL;
            valid = DSA_do_check_signature(&ok, digest, dn, ds, d) && ok;
        }
        DSA_SIG_free(ds);
    }
    BN_free(r), BN_free(s);
    DSA_free(d);
    ERR_clear_error();
    return valid;
}

static int ec_order_size(const EC_KEY *key) { return (int)BN_num_bytes(EC_GROUP_get0_order(EC_KEY_get0_group(key))); }

int js_asym_sign(const JSKeyData *k, const JSHashAlg *h, const uint8_t *digest, int padding, long salt_len, bool p1363,
                 JSBytesOut *out) {
    if (k->type != JS_KEY_PRIVATE) return JS_ASYM_ERR_KEY_TYPE;
    if (k->kind == JS_ASYM_ED25519) return JS_ASYM_ERR_UNSUPPORTED;
    if (is_rsa(k)) {
        size_t n = rsa_size(k);
        uint8_t *sig = calloc(n, 1);
        if (!sig) js_fatal("out of memory in crypto");
        int err = 0;
        if (k->kind == JS_ASYM_RSA_PSS || padding == JS_PADDING_PSS) {
            const JSHashAlg *mgf = k->kind == JS_ASYM_RSA_PSS && k->pss_params ? k->pss_mgf1 : h;
            err = pss_sign(k, h, mgf, digest, salt_len, sig);
        } else {
            uint8_t t[128];
            size_t tl = digest_info(h, digest, true, t);
            if (!tl) err = JS_ASYM_ERR_DIGEST;
            else if (!pkcs1_type1(sig, n, t, tl)) err = JS_ASYM_ERR_TOO_SMALL;
            else if (!rsa_private_op(k, sig)) err = JS_ASYM_ERR_FAILED;
        }
        if (!err) {
            out->p = sig;
            out->n = out->cap = n;
        } else {
            free(sig);
        }
        return err;
    }
    if (k->kind == JS_ASYM_DSA) return dsa_sign(k, digest, h->out_len, p1363, out);
    if (k->kind != JS_ASYM_EC) return JS_ASYM_ERR_KEY_TYPE;
    EC_KEY *key = ec_key_of(k, true);
    if (!key) return JS_ASYM_ERR_FAILED;
    ECDSA_SIG *sig = ECDSA_do_sign(digest, h->out_len, key);
    int err = sig ? 0 : JS_ASYM_ERR_FAILED;
    if (sig && p1363) {
        size_t n = (size_t)ec_order_size(key);
        out->p = malloc(2 * n);
        if (!out->p) js_fatal("out of memory in crypto");
        BN_bn2bin_padded(out->p, n, ECDSA_SIG_get0_r(sig));
        BN_bn2bin_padded(out->p + n, n, ECDSA_SIG_get0_s(sig));
        out->n = out->cap = 2 * n;
    } else if (sig) {
        uint8_t *der;
        size_t n;
        if (!ECDSA_SIG_to_bytes(&der, &n, sig)) {
            err = JS_ASYM_ERR_FAILED;
        } else {
            out->p = malloc(n);
            if (!out->p) js_fatal("out of memory in crypto");
            memcpy(out->p, der, n);
            out->n = out->cap = n;
            OPENSSL_free(der);
        }
    }
    ECDSA_SIG_free(sig);
    EC_KEY_free(key);
    ERR_clear_error();
    return err;
}

int js_asym_verify(const JSKeyData *k, const JSHashAlg *h, const uint8_t *digest, int padding, long salt_len, bool p1363,
                   const uint8_t *sig, size_t sig_len, bool *valid) {
    *valid = false;
    if (k->type == JS_KEY_SECRET) return JS_ASYM_ERR_KEY_TYPE;
    if (k->kind == JS_ASYM_ED25519) return JS_ASYM_ERR_UNSUPPORTED;
    if (is_rsa(k)) {
        if (k->kind == JS_ASYM_RSA_PSS || padding == JS_PADDING_PSS) {
            const JSHashAlg *mgf = k->kind == JS_ASYM_RSA_PSS && k->pss_params ? k->pss_mgf1 : h;
            *valid = pss_verify(k, h, mgf, digest, salt_len, sig, sig_len);
            return 0;
        }
        uint8_t t[128];
        size_t tl = digest_info(h, digest, true, t), n = rsa_size(k);
        if (!tl) return JS_ASYM_ERR_DIGEST;
        if (sig_len != n) return 0;
        uint8_t *x = malloc(2 * n);
        if (!x) js_fatal("out of memory in crypto");
        memcpy(x, sig, n);
        if (rsa_public_op(k, x, n)) {
            /* the DigestInfo with its NULL parameters, or (as some signers write it) without */
            *valid = pkcs1_type1(x + n, n, t, tl) && js_crypto_equal(x, x + n, n);
            if (!*valid && h->oid) {
                tl = digest_info(h, digest, false, t);
                *valid = pkcs1_type1(x + n, n, t, tl) && js_crypto_equal(x, x + n, n);
            }
        }
        free(x);
        return 0;
    }
    if (k->kind == JS_ASYM_DSA) {
        *valid = dsa_verify(k, digest, h->out_len, p1363, sig, sig_len);
        return 0;
    }
    if (k->kind != JS_ASYM_EC) return JS_ASYM_ERR_KEY_TYPE;
    EC_KEY *key = ec_key_of(k, false);
    if (!key) return 0;
    ECDSA_SIG *s = NULL;
    if (p1363) {
        size_t n = (size_t)ec_order_size(key);
        if (sig_len == 2 * n) {
            s = ECDSA_SIG_new();
            BIGNUM *r = BN_bin2bn(sig, n, NULL), *ss = BN_bin2bn(sig + n, n, NULL);
            if (!s || !ECDSA_SIG_set0(s, r, ss)) BN_free(r), BN_free(ss);
        }
    } else {
        s = ECDSA_SIG_from_bytes(sig, sig_len);
    }
    *valid = s && ECDSA_do_verify(digest, h->out_len, s, key) == 1;
    ECDSA_SIG_free(s);
    EC_KEY_free(key);
    ERR_clear_error();
    return 0;
}

/* ---- Ed25519 ---------------------------------------------------------------------------------------- */

int js_ed25519_sign(const JSKeyData *k, const uint8_t *msg, size_t n, uint8_t sig[64]) {
    if (k->kind != JS_ASYM_ED25519 || k->type != JS_KEY_PRIVATE || k->part[JS_EC_PRIV].n != 32) return JS_ASYM_ERR_KEY_TYPE;
    uint8_t pub[32], priv[64];
    ED25519_keypair_from_seed(pub, priv, k->part[JS_EC_PRIV].p);
    int ok = ED25519_sign(sig, msg, n, priv);
    memset(priv, 0, sizeof priv);
    return ok ? 0 : JS_ASYM_ERR_FAILED;
}

int js_ed25519_verify(const JSKeyData *k, const uint8_t *msg, size_t n, const uint8_t *sig, size_t sig_len, bool *valid) {
    *valid = false;
    if (k->kind != JS_ASYM_ED25519 || k->type == JS_KEY_SECRET || k->part[JS_EC_PUB].n != 32) return JS_ASYM_ERR_KEY_TYPE;
    *valid = sig_len == 64 && ED25519_verify(msg, n, sig, k->part[JS_EC_PUB].p);
    return 0;
}

/* ---- OAEP (RFC 8017 7.1), over any hash ------------------------------------------------------------ */

/* EME-OAEP-ENCODE into em (k_len bytes): false when the message is too long */
static bool oaep_encode(const JSHashAlg *h, const uint8_t *label, size_t label_len, const uint8_t *m, size_t m_len, uint8_t *em, size_t k_len) {
    size_t hl = h->out_len;
    if (k_len < 2 * hl + 2 || m_len > k_len - 2 * hl - 2) return false;
    uint8_t *seed = em + 1, *db = em + 1 + hl;
    size_t db_len = k_len - hl - 1;
    em[0] = 0;
    js_hash_once(h, label, label_len, db);
    memset(db + hl, 0, db_len - hl - m_len - 1);
    db[db_len - m_len - 1] = 0x01;
    memcpy(db + db_len - m_len, m, m_len);
    js_crypto_random(seed, hl);
    mgf1_xor(h, seed, hl, db, db_len);
    mgf1_xor(h, db, db_len, seed, hl);
    return true;
}

/* EME-OAEP-DECODE in place: the message's offset in em and its length, or false */
static bool oaep_decode(const JSHashAlg *h, const uint8_t *label, size_t label_len, uint8_t *em, size_t k_len, size_t *at, size_t *m_len) {
    size_t hl = h->out_len;
    if (k_len < 2 * hl + 2) return false;
    uint8_t *seed = em + 1, *db = em + 1 + hl, lhash[64];
    size_t db_len = k_len - hl - 1;
    mgf1_xor(h, db, db_len, seed, hl);
    mgf1_xor(h, seed, hl, db, db_len);
    js_hash_once(h, label, label_len, lhash);
    unsigned bad = em[0] | !js_crypto_equal(db, lhash, hl);
    size_t i = hl;
    while (i < db_len && db[i] == 0) i++;
    bad |= i == db_len || db[i] != 0x01;
    if (bad) return false;
    *at = 1 + hl + i + 1;
    *m_len = db_len - i - 1;
    return true;
}

/* ---- RSA encryption ----------------------------------------------------------------------------- */

int js_rsa_crypt(const JSKeyData *k, int op, int padding, const JSHashAlg *oaep_hash, const uint8_t *label, size_t label_len,
                 const uint8_t *in, size_t n, JSBytesOut *out) {
    if (!is_rsa(k)) return JS_ASYM_ERR_KEY_TYPE;
    bool private_op = op == JS_RSA_PRIVATE_DECRYPT || op == JS_RSA_PRIVATE_ENCRYPT;
    if (private_op && k->type != JS_KEY_PRIVATE) return JS_ASYM_ERR_KEY_TYPE;
    size_t kl = rsa_size(k);
    uint8_t *x = calloc(kl, 1);
    if (!x) js_fatal("out of memory in crypto");
    int err = 0;
    size_t out_len = kl;
    if (op == JS_RSA_PUBLIC_ENCRYPT && padding == JS_PADDING_OAEP) {
        if (oaep_hash->xof) err = JS_ASYM_ERR_DIGEST;
        else if (!oaep_encode(oaep_hash, label, label_len, in, n, x, kl)) err = JS_ASYM_ERR_TOO_LARGE;
        else if (!rsa_public_op(k, x, kl)) err = JS_ASYM_ERR_TOO_LARGE;
    } else if (op == JS_RSA_PRIVATE_DECRYPT && padding == JS_PADDING_OAEP) {
        size_t at;
        if (oaep_hash->xof) err = JS_ASYM_ERR_DIGEST;
        else if (n != kl) err = JS_ASYM_ERR_OAEP;
        else {
            memcpy(x, in, n);
            if (!rsa_private_op(k, x) || !oaep_decode(oaep_hash, label, label_len, x, kl, &at, &out_len)) err = JS_ASYM_ERR_OAEP;
            else memmove(x, x + at, out_len);
        }
    } else if (op == JS_RSA_PUBLIC_ENCRYPT || op == JS_RSA_PRIVATE_ENCRYPT) {
        if (padding == JS_PADDING_NONE) {
            if (n > kl) err = JS_ASYM_ERR_TOO_LARGE;
            else if (n < kl) err = JS_ASYM_ERR_TOO_SMALL;
            else memcpy(x, in, n);
        } else if (padding != JS_PADDING_PKCS1) {
            err = JS_ASYM_ERR_PADDING;
        } else if (n + 11 > kl) {
            err = JS_ASYM_ERR_TOO_LARGE;
        } else {  /* EME-PKCS1-v1_5 (00 02 random 00 M) or the signature form (00 01 FF… 00 M) */
            size_t ps = kl - n - 3;
            x[1] = op == JS_RSA_PUBLIC_ENCRYPT ? 2 : 1;
            if (op == JS_RSA_PUBLIC_ENCRYPT) {
                js_crypto_random(x + 2, ps);
                for (size_t i = 0; i < ps; i++)
                    while (x[2 + i] == 0) js_crypto_random(x + 2 + i, 1);
            } else {
                memset(x + 2, 0xFF, ps);
            }
            memcpy(x + 3 + ps, in, n);
        }
        if (!err && !(op == JS_RSA_PUBLIC_ENCRYPT ? rsa_public_op(k, x, kl) : rsa_private_op(k, x))) err = JS_ASYM_ERR_TOO_LARGE;
    } else {  /* privateDecrypt or publicDecrypt without OAEP */
        if (n > kl) err = JS_ASYM_ERR_TOO_LARGE;
        else if (n < kl && padding == JS_PADDING_NONE) err = JS_ASYM_ERR_TOO_SMALL;
        else {
            memcpy(x + kl - n, in, n);
            if (!(op == JS_RSA_PRIVATE_DECRYPT ? rsa_private_op(k, x) : rsa_public_op(k, x, kl))) err = JS_ASYM_ERR_TOO_LARGE;
        }
        if (!err && padding == JS_PADDING_PKCS1) {
            uint8_t type = op == JS_RSA_PRIVATE_DECRYPT ? 2 : 1;
            size_t i = 2;
            if (x[0] != 0 || x[1] != type) err = JS_ASYM_ERR_PADDING;
            while (!err && i < kl && x[i] != 0) {
                if (type == 1 && x[i] != 0xFF) err = JS_ASYM_ERR_PADDING;
                i++;
            }
            if (!err && (i == kl || i < 10)) err = JS_ASYM_ERR_PADDING;
            if (!err) {
                out_len = kl - i - 1;
                memmove(x, x + i + 1, out_len);
            }
        } else if (!err && padding != JS_PADDING_NONE) {
            err = JS_ASYM_ERR_PADDING;
        }
    }
    if (err) {
        free(x);
        return err;
    }
    out->p = x;
    out->n = out_len;
    out->cap = kl;
    return 0;
}

/* ---- Points ------------------------------------------------------------------------------------- */

static const struct {
    int         curve;
    const char *name;
    size_t      size;
} FIELDS[] = {
    { JS_EC_P256, "prime256v1", 32 },
    { JS_EC_P384, "secp384r1", 48 },
    { JS_EC_P521, "secp521r1", 66 },
};

int js_ec_curve_by_name(const char *name) {
    for (size_t i = 0; i < JS_COUNTOF(FIELDS); i++)
        if (strcmp(name, FIELDS[i].name) == 0) return FIELDS[i].curve;
    return -1;
}

size_t js_ec_field_size(int curve) {
    for (size_t i = 0; i < JS_COUNTOF(FIELDS); i++)
        if (FIELDS[i].curve == curve) return FIELDS[i].size;
    return curve == JS_EC_X25519 || curve == JS_EC_ED25519 ? 32 : 0;
}

/* Any encoding of a point (uncompressed 04, compressed 02/03, hybrid 06/07) as uncompressed;
 * false when it isn't one of the curve's points. */
bool js_ec_point_uncompressed(int curve, const uint8_t *in, size_t n, uint8_t *out) {
    size_t fs = js_ec_field_size(curve);
    if (!fs || curve == JS_EC_X25519 || curve == JS_EC_ED25519 || n == 0) return false;
    uint8_t buf[133];
    if ((in[0] == 6 || in[0] == 7) && n == 1 + 2 * fs) {  /* hybrid: BoringSSL takes it as uncompressed */
        if ((in[n - 1] & 1) != (in[0] & 1)) return false;
        memcpy(buf, in, n);
        buf[0] = 4;
        in = buf;
    }
    EC_GROUP *g = EC_GROUP_new_by_curve_name(ec_nid(curve));
    EC_POINT *pt = g ? EC_POINT_new(g) : NULL;
    bool ok = pt && EC_POINT_oct2point(g, pt, in, n, NULL) &&
              EC_POINT_point2oct(g, pt, POINT_CONVERSION_UNCOMPRESSED, out, 1 + 2 * fs, NULL) == 1 + 2 * fs;
    EC_POINT_free(pt);
    EC_GROUP_free(g);
    ERR_clear_error();
    return ok;
}

/* An uncompressed point in a format: 4 uncompressed, 2 compressed, 6 hybrid (Node's constants). */
size_t js_ec_point_format(int curve, const uint8_t *point, int format, uint8_t *out) {
    size_t fs = js_ec_field_size(curve);
    uint8_t odd = point[2 * fs] & 1;
    if (format == 2) {
        out[0] = (uint8_t)(2 | odd);
        memcpy(out + 1, point + 1, fs);
        return 1 + fs;
    }
    memcpy(out, point, 1 + 2 * fs);
    if (format == 6) out[0] = (uint8_t)(6 | odd);
    return 1 + 2 * fs;
}

/* The public point of a private scalar, uncompressed (EC), or X25519's public value: false when
 * the scalar isn't one */
bool js_ec_public_of(int curve, const uint8_t *scalar, size_t n, uint8_t *out, size_t *out_len) {
    if (curve == JS_EC_ED25519) {  /* the private key is the seed */
        uint8_t priv[64];
        if (n != 32) return false;
        ED25519_keypair_from_seed(out, priv, scalar);
        memset(priv, 0, sizeof priv);
        *out_len = 32;
        return true;
    }
    if (curve == JS_EC_X25519) {
        if (n != 32) return false;
        X25519_public_from_private(out, scalar);
        *out_len = 32;
        return true;
    }
    size_t fs = js_ec_field_size(curve);
    EC_GROUP *g = EC_GROUP_new_by_curve_name(ec_nid(curve));
    EC_POINT *pt = g ? EC_POINT_new(g) : NULL;
    BIGNUM *d = BN_bin2bn(scalar, n, NULL);
    bool ok = pt && d && !BN_is_zero(d) && BN_cmp(d, EC_GROUP_get0_order(g)) < 0 && EC_POINT_mul(g, pt, d, NULL, NULL, NULL) &&
              EC_POINT_point2oct(g, pt, POINT_CONVERSION_UNCOMPRESSED, out, 1 + 2 * fs, NULL) == 1 + 2 * fs;
    *out_len = 1 + 2 * fs;
    BN_clear_free(d);
    EC_POINT_free(pt);
    EC_GROUP_free(g);
    ERR_clear_error();
    return ok;
}

/* The shared secret of a private key and a peer's public point (EC: the x coordinate; X25519:
 * the u coordinate). 0, or JS_ASYM_ERR_POINT. */
int js_ecdh(const JSKeyData *k, const uint8_t *peer, size_t peer_len, uint8_t *secret, size_t *secret_len) {
    if (k->curve == JS_EC_X25519) {
        if (peer_len != 32 || k->part[JS_EC_PRIV].n != 32) return JS_ASYM_ERR_POINT;
        if (!X25519(secret, k->part[JS_EC_PRIV].p, peer)) return JS_ASYM_ERR_POINT;  /* a small-order point, as OpenSSL rejects it */
        *secret_len = 32;
        return 0;
    }
    uint8_t g[133];
    if (!js_ec_point_uncompressed(k->curve, peer, peer_len, g)) return JS_ASYM_ERR_POINT;
    size_t fs = js_ec_field_size(k->curve);
    EC_KEY *key = ec_key_of(k, true);
    if (!key) return JS_ASYM_ERR_POINT;
    const EC_GROUP *group = EC_KEY_get0_group(key);
    EC_POINT *pt = EC_POINT_new(group);
    bool ok = pt && EC_POINT_oct2point(group, pt, g, 1 + 2 * fs, NULL) && ECDH_compute_key(secret, fs, pt, key, NULL) == (int)fs;
    EC_POINT_free(pt);
    EC_KEY_free(key);
    ERR_clear_error();
    if (!ok) return JS_ASYM_ERR_POINT;
    *secret_len = fs;
    return 0;
}

/* ---- node:crypto's primitives ------------------------------------------------------------------- */

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED_PRIMITIVE_ARGS (void)callee, (void)this_val, (void)new_target

static const JSHashAlg *hash_arg(JSContext *ctx, JSValue v) {
    char name[64];
    if (!js_is_string(v)) return NULL;
    size_t n = js_view_to_utf8(js_string_view(ctx, v), name, sizeof name - 1);
    if (n >= sizeof name - 1) return NULL;
    name[n] = 0;
    return js_hash_by_name(name);
}

static JSValue result(JSContext *ctx, int err, JSBytesOut *out) {
    JSValue r = err ? js_int32(err) : js_new_buffer_from_bytes(ctx, out->p, out->n);
    free(out->p);
    return r;
}

static long num_or(JSValue v, long dflt) { return js_is_number(v) ? (long)js_as_number(v) : dflt; }

/* cryptoSign(key, hash, digest, padding, saltLength, p1363): a Buffer, or an error code. */
PRIMITIVE(js_crypto_sign) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = js_key_data(ARG(0));
    const JSHashAlg *h = hash_arg(ctx, ARG(1));
    uint8_t *d;
    size_t dn;
    if (!k || !js_buffer_source_bytes(ARG(2), &d, &dn)) return js_throw_type_error(ctx, "cryptoSign: bad arguments");
    if (!h || h->xof || dn != h->out_len) return js_int32(JS_ASYM_ERR_DIGEST);
    JSBytesOut out = { 0 };
    return result(ctx, js_asym_sign(k, h, d, (int)num_or(ARG(3), JS_PADDING_PKCS1), num_or(ARG(4), JS_SALT_MAX), js_truthy(ARG(5)), &out), &out);
}

/* cryptoVerify(key, hash, digest, signature, padding, saltLength, p1363): a boolean, or an error code. */
PRIMITIVE(js_crypto_verify) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = js_key_data(ARG(0));
    const JSHashAlg *h = hash_arg(ctx, ARG(1));
    uint8_t *d, *sig;
    size_t dn, sn;
    if (!k || !js_buffer_source_bytes(ARG(2), &d, &dn) || !js_buffer_source_bytes(ARG(3), &sig, &sn))
        return js_throw_type_error(ctx, "cryptoVerify: bad arguments");
    if (!h || h->xof || dn != h->out_len) return js_int32(JS_ASYM_ERR_DIGEST);
    bool valid;
    int err = js_asym_verify(k, h, d, (int)num_or(ARG(4), JS_PADDING_PKCS1), num_or(ARG(5), JS_SALT_AUTO), js_truthy(ARG(6)), sig, sn, &valid);
    return err ? js_int32(err) : js_bool(valid);
}

/* cryptoSignMessage(key, data): Ed25519's signature of a message, a Buffer, or an error code. */
PRIMITIVE(js_crypto_sign_message) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = js_key_data(ARG(0));
    uint8_t *d;
    size_t dn;
    if (!k || !js_buffer_source_bytes(ARG(1), &d, &dn)) return js_throw_type_error(ctx, "cryptoSignMessage: bad arguments");
    uint8_t sig[64];
    int err = js_ed25519_sign(k, d, dn, sig);
    return err ? js_int32(err) : js_new_buffer_from_bytes(ctx, sig, 64);
}

/* cryptoVerifyMessage(key, data, signature): a boolean, or an error code. */
PRIMITIVE(js_crypto_verify_message) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = js_key_data(ARG(0));
    uint8_t *d, *sig;
    size_t dn, sn;
    if (!k || !js_buffer_source_bytes(ARG(1), &d, &dn) || !js_buffer_source_bytes(ARG(2), &sig, &sn))
        return js_throw_type_error(ctx, "cryptoVerifyMessage: bad arguments");
    bool valid;
    int err = js_ed25519_verify(k, d, dn, sig, sn, &valid);
    return err ? js_int32(err) : js_bool(valid);
}

/* cryptoRsaCrypt(key, op, data, padding, oaepHash, oaepLabel): a Buffer, or an error code.
 * op: 0 publicEncrypt, 1 privateDecrypt, 2 privateEncrypt, 3 publicDecrypt. */
PRIMITIVE(js_crypto_rsa_crypt) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = js_key_data(ARG(0));
    uint8_t *in, *label = NULL;
    size_t n, label_len = 0;
    if (!k || !js_is_number(ARG(1)) || !js_buffer_source_bytes(ARG(2), &in, &n)) return js_throw_type_error(ctx, "cryptoRsaCrypt: bad arguments");
    const JSHashAlg *h = js_is_undefined(ARG(4)) ? js_hash_by_name("sha1") : hash_arg(ctx, ARG(4));
    if (!h) return js_int32(JS_ASYM_ERR_DIGEST);
    if (!js_is_undefined(ARG(5))) js_buffer_source_bytes(ARG(5), &label, &label_len);
    JSBytesOut out = { 0 };
    return result(ctx, js_rsa_crypt(k, (int)js_as_number(ARG(1)), (int)num_or(ARG(3), JS_PADDING_OAEP), h, label, label_len, in, n, &out), &out);
}

/* cryptoEcdh(private key, peer public point or key): the shared secret, or an error code. */
PRIMITIVE(js_crypto_ecdh) {
    UNUSED_PRIMITIVE_ARGS;
    JSKeyData *k = js_key_data(ARG(0)), *peer = js_key_data(ARG(1));
    uint8_t *p;
    size_t n;
    if (!k) return js_throw_type_error(ctx, "cryptoEcdh: bad arguments");
    if (peer) p = peer->part[JS_EC_PUB].p, n = peer->part[JS_EC_PUB].n;
    else if (!js_buffer_source_bytes(ARG(1), &p, &n)) return js_throw_type_error(ctx, "cryptoEcdh: bad arguments");
    uint8_t secret[66];
    size_t sn;
    int err = js_ecdh(k, p, n, secret, &sn);
    return err ? js_int32(err) : js_new_buffer_from_bytes(ctx, secret, sn);
}

/* cryptoEcPoint(curve, point, format): the point in a format (4, 2 or 6), or an error code. */
PRIMITIVE(js_crypto_ec_point) {
    UNUSED_PRIMITIVE_ARGS;
    char name[24] = "";
    uint8_t *p;
    size_t n;
    if (!js_is_string(ARG(0)) || !js_buffer_source_bytes(ARG(1), &p, &n)) return js_throw_type_error(ctx, "cryptoEcPoint: bad arguments");
    js_view_to_utf8(js_string_view(ctx, ARG(0)), name, sizeof name - 1);
    int curve = js_ec_curve_by_name(name);
    if (curve < 0) return js_int32(JS_ASYM_ERR_CURVE);
    uint8_t point[133], out[133];
    if (!js_ec_point_uncompressed(curve, p, n, point)) return js_int32(JS_ASYM_ERR_POINT);  /* on the curve too */
    size_t on = js_ec_point_format(curve, point, (int)num_or(ARG(2), 4), out);
    return js_new_buffer_from_bytes(ctx, out, on);
}

/* cryptoEcPrivate(curve, scalar): an EC private key handle, or an error code. */
PRIMITIVE(js_crypto_ec_private) {
    UNUSED_PRIMITIVE_ARGS;
    char name[24] = "";
    uint8_t *p;
    size_t n;
    if (!js_is_string(ARG(0)) || !js_buffer_source_bytes(ARG(1), &p, &n)) return js_throw_type_error(ctx, "cryptoEcPrivate: bad arguments");
    js_view_to_utf8(js_string_view(ctx, ARG(0)), name, sizeof name - 1);
    int curve = js_ec_curve_by_name(name);
    if (curve < 0) return js_int32(JS_ASYM_ERR_CURVE);
    size_t fs = js_ec_field_size(curve);
    while (n > fs && p[0] == 0) p++, n--;
    if (n > fs) return js_int32(JS_ASYM_ERR_POINT);
    JSKeyData *k = js_new_asym_key(ctx, JS_KEY_PRIVATE, JS_ASYM_EC);
    k->curve = curve;
    uint8_t buf[66] = { 0 };
    memcpy(buf + fs - n, p, n);
    js_key_part_set(&k->part[JS_EC_PRIV], buf, fs);
    uint8_t pub[133];
    size_t pn;
    if (!js_ec_public_of(curve, buf, fs, pub, &pn)) return js_int32(JS_ASYM_ERR_POINT);
    js_key_part_set(&k->part[JS_EC_PUB], pub, pn);
    return js_object_value(&k->obj);
}
