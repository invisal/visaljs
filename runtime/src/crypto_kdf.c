/* The crypto primitives' key derivation: PBKDF2 (RFC 8018) and HKDF (RFC 5869) over
 * crypto_hash.c's HMAC, so any of its hashes works; scrypt (RFC 7914) with its Salsa20/8 core. */
#include <stdlib.h>
#include <string.h>

#include "crypto_internal.h"

/* ---- PBKDF2 ------------------------------------------------------------------------------------ */

bool js_pbkdf2(const JSHashAlg *alg, const uint8_t *pw, size_t pw_len, const uint8_t *salt, size_t salt_len,
               uint32_t iterations, uint8_t *out, size_t n) {
    if (alg->xof || iterations == 0) return false;
    JSHmacCtx keyed;  /* the password's inner and outer states, copied for each HMAC */
    js_hmac_init(&keyed, alg, pw, pw_len);
    size_t hlen = alg->out_len;
    for (uint32_t block = 1; n > 0; block++) {
        uint8_t u[64], t[64], be[4] = { (uint8_t)(block >> 24), (uint8_t)(block >> 16), (uint8_t)(block >> 8), (uint8_t)block };
        JSHmacCtx m = keyed;
        js_hmac_update(&m, salt, salt_len);
        js_hmac_update(&m, be, 4);
        js_hmac_final(&m, u);
        memcpy(t, u, hlen);
        for (uint32_t i = 1; i < iterations; i++) {
            m = keyed;
            js_hmac_update(&m, u, hlen);
            js_hmac_final(&m, u);
            for (size_t j = 0; j < hlen; j++) t[j] ^= u[j];
        }
        size_t take = n < hlen ? n : hlen;
        memcpy(out, t, take);
        out += take;
        n -= take;
    }
    return true;
}

/* ---- HKDF -------------------------------------------------------------------------------------- */

bool js_hkdf(const JSHashAlg *alg, const uint8_t *ikm, size_t ikm_len, const uint8_t *salt, size_t salt_len,
             const uint8_t *info, size_t info_len, uint8_t *out, size_t n) {
    size_t hlen = alg->out_len;
    if (alg->xof || n > 255 * hlen) return false;
    uint8_t zeros[64] = { 0 }, prk[64], t[64];
    JSHmacCtx m;
    js_hmac_init(&m, alg, salt_len ? salt : zeros, salt_len ? salt_len : hlen);  /* extract */
    js_hmac_update(&m, ikm, ikm_len);
    js_hmac_final(&m, prk);
    size_t t_len = 0;
    for (uint8_t i = 1; n > 0; i++) {  /* expand */
        js_hmac_init(&m, alg, prk, hlen);
        js_hmac_update(&m, t, t_len);
        js_hmac_update(&m, info, info_len);
        js_hmac_update(&m, &i, 1);
        js_hmac_final(&m, t);
        t_len = hlen;
        size_t take = n < hlen ? n : hlen;
        memcpy(out, t, take);
        out += take;
        n -= take;
    }
    return true;
}

/* ---- scrypt ------------------------------------------------------------------------------------ */

static inline uint32_t rotl32(uint32_t x, unsigned n) { return (x << n) | (x >> (32 - n)); }

static void salsa20_8(uint32_t b[16]) {
    uint32_t x[16];
    memcpy(x, b, sizeof x);
    for (int i = 0; i < 8; i += 2) {
#define QR(a, b, c, d) \
    x[b] ^= rotl32(x[a] + x[d], 7), x[c] ^= rotl32(x[b] + x[a], 9), x[d] ^= rotl32(x[c] + x[b], 13), x[a] ^= rotl32(x[d] + x[c], 18)
        QR(0, 4, 8, 12); QR(5, 9, 13, 1); QR(10, 14, 2, 6); QR(15, 3, 7, 11);    /* columns */
        QR(0, 1, 2, 3); QR(5, 6, 7, 4); QR(10, 11, 8, 9); QR(15, 12, 13, 14);   /* rows */
#undef QR
    }
    for (int i = 0; i < 16; i++) b[i] += x[i];
}

/* BlockMix (RFC 7914 §4): b is 2r 64-byte blocks, y scratch of the same size. */
static void block_mix(uint32_t *b, uint32_t *y, uint32_t r) {
    uint32_t x[16];
    memcpy(x, &b[(2 * r - 1) * 16], 64);
    for (uint32_t i = 0; i < 2 * r; i++) {
        for (int j = 0; j < 16; j++) x[j] ^= b[i * 16 + j];
        salsa20_8(x);
        /* even blocks to the first half, odd to the second */
        memcpy(&y[((i & 1) * r + i / 2) * 16], x, 64);
    }
    memcpy(b, y, 128 * (size_t)r);
}

static void romix(uint8_t *block, uint32_t r, uint64_t N, uint32_t *v, uint32_t *x, uint32_t *y) {
    size_t words = 32 * (size_t)r;
    for (size_t i = 0; i < words; i++) {
        const uint8_t *p = block + 4 * i;
        x[i] = (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
    }
    for (uint64_t i = 0; i < N; i++) {
        memcpy(&v[i * words], x, 4 * words);
        block_mix(x, y, r);
    }
    for (uint64_t i = 0; i < N; i++) {
        uint64_t j = x[(2 * r - 1) * 16] & (N - 1);
        for (size_t k = 0; k < words; k++) x[k] ^= v[j * words + k];
        block_mix(x, y, r);
    }
    for (size_t i = 0; i < words; i++) {
        uint8_t *p = block + 4 * i;
        p[0] = (uint8_t)x[i], p[1] = (uint8_t)(x[i] >> 8), p[2] = (uint8_t)(x[i] >> 16), p[3] = (uint8_t)(x[i] >> 24);
    }
}

int js_scrypt_check(uint64_t N, uint64_t r, uint64_t p, uint64_t maxmem) {
    /* OpenSSL's checks (EVP_PBE_scrypt_ex), so the same parameters fail */
    if (r == 0 || p == 0 || N < 2 || (N & (N - 1))) return JS_SCRYPT_INVALID;
    /* OpenSSL reports these as its memory limit too */
    if (p > ((1ULL << 30) - 1) / r) return JS_SCRYPT_MEMORY;
    if (16 * r <= 63 && N >= (1ULL << (16 * r))) return JS_SCRYPT_MEMORY;
    uint64_t blen = p * 128 * r;
    if (N + 2 > UINT64_MAX / (32 * r * 4)) return JS_SCRYPT_MEMORY;
    uint64_t vlen = 32 * r * (N + 2) * 4;
    if (blen > UINT64_MAX - vlen || blen + vlen > maxmem) return JS_SCRYPT_MEMORY;
    return 0;
}

bool js_scrypt(const uint8_t *pw, size_t pw_len, const uint8_t *salt, size_t salt_len, uint64_t N, uint32_t r,
               uint32_t p, uint8_t *out, size_t n) {
    const JSHashAlg *sha256 = js_hash_by_name("sha256");
    size_t blen = (size_t)p * 128 * r;
    uint8_t *b = malloc(blen);
    uint32_t *v = malloc((size_t)N * 128 * r), *xy = malloc(256 * (size_t)r);
    if (!b || !v || !xy) {
        free(b), free(v), free(xy);
        return false;
    }
    js_pbkdf2(sha256, pw, pw_len, salt, salt_len, 1, b, blen);
    for (uint32_t i = 0; i < p; i++) romix(b + (size_t)i * 128 * r, r, N, v, xy, xy + 32 * r);
    js_pbkdf2(sha256, pw, pw_len, b, blen, 1, out, n);
    free(b), free(v), free(xy);
    return true;
}
