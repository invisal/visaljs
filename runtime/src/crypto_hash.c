/* The crypto primitives' hashes, HMAC and random bytes: BoringSSL's MD5, SHA-1 and
 * SHA-2, SHA-512/224 and /256 on its SHA-512 with their own IVs, and SHA-3 and SHAKE on a
 * Keccak-f[1600] of our own (BoringSSL has none to offer). HMAC is generic over them; random
 * bytes are BoringSSL's. */
#include <ctype.h>
#include <string.h>

#include <openssl/rand.h>

#include "crypto_internal.h"
#include "js_builtins.h"
#include "js_exception.h"

/* ---- Keccak (FIPS 202) ------------------------------------------------------------------------ */

static const uint64_t KECCAK_RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808AULL, 0x8000000080008000ULL,
    0x000000000000808BULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008AULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000AULL,
    0x000000008000808BULL, 0x800000000000008BULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800AULL, 0x800000008000000AULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL,
};
static const unsigned KECCAK_ROT[25] = { 0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14 };

static inline uint64_t rotl64(uint64_t x, unsigned n) { return n ? (x << n) | (x >> (64 - n)) : x; }

static void keccak_f(uint64_t a[25]) {
    for (int round = 0; round < 24; round++) {
        uint64_t c[5], d[5], b[25];
        for (int x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
        for (int x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
        for (int i = 0; i < 25; i++) a[i] ^= d[i % 5];
        /* rho and pi: B[y, 2x + 3y] = rot(A[x, y]) */
        for (int x = 0; x < 5; x++)
            for (int y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y], KECCAK_ROT[x + 5 * y]);
        for (int y = 0; y < 5; y++)
            for (int x = 0; x < 5; x++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & b[(x + 2) % 5 + 5 * y]);
        a[0] ^= KECCAK_RC[round];
    }
}

static void keccak_xor_byte(JSKeccak *k, uint32_t i, uint8_t b) { k->a[i / 8] ^= (uint64_t)b << (8 * (i % 8)); }

static void keccak_absorb(JSKeccak *k, const uint8_t *p, size_t n) {
    while (n--) {
        keccak_xor_byte(k, k->pos++, *p++);
        if (k->pos == k->rate) {
            keccak_f(k->a);
            k->pos = 0;
        }
    }
}

static void keccak_squeeze(JSKeccak *k, uint8_t suffix, uint8_t *out, size_t n) {
    if (!k->squeezing) {
        keccak_xor_byte(k, k->pos, suffix);
        keccak_xor_byte(k, k->rate - 1, 0x80);
        keccak_f(k->a);
        k->pos = 0;
        k->squeezing = true;
    }
    while (n--) {
        if (k->pos == k->rate) {
            keccak_f(k->a);
            k->pos = 0;
        }
        *out++ = (uint8_t)(k->a[k->pos / 8] >> (8 * (k->pos % 8)));
        k->pos++;
    }
}

/* ---- The algorithms ---------------------------------------------------------------------------- */

static const uint64_t SHA512_224_IV[8] = {
    0x8C3D37C819544DA2ULL, 0x73E1996689DCD4D6ULL, 0x1DFAB7AE32FF9C82ULL, 0x679DD514582F9FCFULL,
    0x0F6D2B697BD44DA8ULL, 0x77E36F7304C48942ULL, 0x3F9D85A86A1D36C8ULL, 0x1112E6AD91D692A1ULL,
};
static const uint64_t SHA512_256_IV[8] = {
    0x22312194FC2BF72CULL, 0x9F555FA3C84C64C2ULL, 0x2393B86B6F53B151ULL, 0x963877195940EABDULL,
    0x96283EE2A88EFFE3ULL, 0xBE5E1E2553863992ULL, 0x2B0199FC2C85B8AAULL, 0x0EB72DDC81C52CA2ULL,
};

/* OIDs as the DigestInfo takes them (crypto_asym.c): the length, then the OID's bytes */
static const unsigned char OID_MD5[] = { 0x08, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x02, 0x05 };
static const unsigned char OID_SHA1[] = { 0x05, 0x2B, 0x0E, 0x03, 0x02, 0x1A };
#define NIST_HASH_OID(last) { 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, (last) }
static const unsigned char OID_SHA256[] = NIST_HASH_OID(0x01);
static const unsigned char OID_SHA384[] = NIST_HASH_OID(0x02);
static const unsigned char OID_SHA512[] = NIST_HASH_OID(0x03);
static const unsigned char OID_SHA224[] = NIST_HASH_OID(0x04);
static const unsigned char OID_SHA512_224[] = NIST_HASH_OID(0x05);
static const unsigned char OID_SHA512_256[] = NIST_HASH_OID(0x06);
static const unsigned char OID_SHA3_224[] = NIST_HASH_OID(0x07);
static const unsigned char OID_SHA3_256[] = NIST_HASH_OID(0x08);
static const unsigned char OID_SHA3_384[] = NIST_HASH_OID(0x09);
static const unsigned char OID_SHA3_512[] = NIST_HASH_OID(0x0A);

/* BoringSSL's hashes over JSHashState */
#define IMPL(id, ctx, field, init, update, final)                                                                      \
    static void id##_init(JSHashState *s) { init(&s->field); }                                                          \
    static void id##_update(JSHashState *s, const void *p, size_t n) { update(&s->field, p, n); }                       \
    static void id##_final(JSHashState *s, uint8_t *out) { final(out, &s->field); }                                     \
    static const JSHashImpl id##_impl = { id##_init, id##_update, id##_final };
IMPL(md5, MD5_CTX, md5, MD5_Init, MD5_Update, MD5_Final)
IMPL(sha1, SHA_CTX, sha1, SHA1_Init, SHA1_Update, SHA1_Final)
IMPL(sha224, SHA256_CTX, sha256, SHA224_Init, SHA224_Update, SHA224_Final)
IMPL(sha256, SHA256_CTX, sha256, SHA256_Init, SHA256_Update, SHA256_Final)
IMPL(sha384, SHA512_CTX, sha512, SHA384_Init, SHA384_Update, SHA384_Final)
IMPL(sha512, SHA512_CTX, sha512, SHA512_Init, SHA512_Update, SHA512_Final)

static void md5sha1_init(JSHashState *s) {
    MD5_Init(&s->md5sha1.md5);
    SHA1_Init(&s->md5sha1.sha1);
}
static void md5sha1_update(JSHashState *s, const void *p, size_t n) {
    MD5_Update(&s->md5sha1.md5, p, n);
    SHA1_Update(&s->md5sha1.sha1, p, n);
}
static void md5sha1_final(JSHashState *s, uint8_t *out) {
    MD5_Final(out, &s->md5sha1.md5);
    SHA1_Final(out + 16, &s->md5sha1.sha1);
}
static const JSHashImpl md5sha1_impl = { md5sha1_init, md5sha1_update, md5sha1_final };

#define BSSL(name, web, len, block, impl, oid) { name, web, JS_HASH_BORINGSSL, false, len, block, &impl, NULL, 0, oid }
#define SHA512T(name, len, iv, oid) { name, NULL, JS_HASH_SHA512T, false, len, 128, &sha512_impl, iv, 0, oid }
#define KECCAK(name, xof, len, rate, suffix, oid) { name, NULL, JS_HASH_KECCAK, xof, len, rate, NULL, NULL, suffix, oid }

static const JSHashAlg ALGS[] = {
    BSSL("md5", NULL, 16, 64, md5_impl, OID_MD5),
    BSSL("sha1", "SHA-1", 20, 64, sha1_impl, OID_SHA1),
    BSSL("sha224", NULL, 28, 64, sha224_impl, OID_SHA224),
    BSSL("sha256", "SHA-256", 32, 64, sha256_impl, OID_SHA256),
    BSSL("sha384", "SHA-384", 48, 128, sha384_impl, OID_SHA384),
    BSSL("sha512", "SHA-512", 64, 128, sha512_impl, OID_SHA512),
    BSSL("md5-sha1", NULL, 36, 64, md5sha1_impl, NULL),
    SHA512T("sha512-224", 28, SHA512_224_IV, OID_SHA512_224),
    SHA512T("sha512-256", 32, SHA512_256_IV, OID_SHA512_256),
    KECCAK("sha3-224", false, 28, 144, 0x06, OID_SHA3_224),
    KECCAK("sha3-256", false, 32, 136, 0x06, OID_SHA3_256),
    KECCAK("sha3-384", false, 48, 104, 0x06, OID_SHA3_384),
    KECCAK("sha3-512", false, 64, 72, 0x06, OID_SHA3_512),
    KECCAK("shake128", true, 16, 168, 0x1F, NULL),
    KECCAK("shake256", true, 32, 136, 0x1F, NULL),
};

enum { H_MD5, H_SHA1, H_SHA224, H_SHA256, H_SHA384, H_SHA512, H_MD5SHA1, H_SHA512_224, H_SHA512_256, H_SHA3_224, H_SHA3_256, H_SHA3_384, H_SHA3_512, H_SHAKE128, H_SHAKE256 };

/* Every name OpenSSL takes for them (its EVP names, its aliases, its fetch names) */
static const struct { const char *name; uint8_t alg; } NAMES[] = {
    { "md5", H_MD5 }, { "rsa-md5", H_MD5 }, { "md5withrsaencryption", H_MD5 }, { "ssl3-md5", H_MD5 },
    { "sha1", H_SHA1 }, { "sha-1", H_SHA1 }, { "rsa-sha1", H_SHA1 }, { "rsa-sha1-2", H_SHA1 }, { "sha1withrsaencryption", H_SHA1 }, { "ssl3-sha1", H_SHA1 },
    { "sha224", H_SHA224 }, { "sha-224", H_SHA224 }, { "sha2-224", H_SHA224 }, { "rsa-sha224", H_SHA224 }, { "sha224withrsaencryption", H_SHA224 },
    { "sha256", H_SHA256 }, { "sha-256", H_SHA256 }, { "sha2-256", H_SHA256 }, { "rsa-sha256", H_SHA256 }, { "sha256withrsaencryption", H_SHA256 },
    { "sha384", H_SHA384 }, { "sha-384", H_SHA384 }, { "sha2-384", H_SHA384 }, { "rsa-sha384", H_SHA384 }, { "sha384withrsaencryption", H_SHA384 },
    { "sha512", H_SHA512 }, { "sha-512", H_SHA512 }, { "sha2-512", H_SHA512 }, { "rsa-sha512", H_SHA512 }, { "sha512withrsaencryption", H_SHA512 },
    { "md5-sha1", H_MD5SHA1 },
    { "sha512-224", H_SHA512_224 }, { "sha-512/224", H_SHA512_224 }, { "sha2-512/224", H_SHA512_224 },
    { "rsa-sha512/224", H_SHA512_224 }, { "sha512-224withrsaencryption", H_SHA512_224 },
    { "sha512-256", H_SHA512_256 }, { "sha-512/256", H_SHA512_256 }, { "sha2-512/256", H_SHA512_256 },
    { "rsa-sha512/256", H_SHA512_256 }, { "sha512-256withrsaencryption", H_SHA512_256 },
    { "sha3-224", H_SHA3_224 }, { "rsa-sha3-224", H_SHA3_224 }, { "id-rsassa-pkcs1-v1_5-with-sha3-224", H_SHA3_224 },
    { "sha3-256", H_SHA3_256 }, { "rsa-sha3-256", H_SHA3_256 }, { "id-rsassa-pkcs1-v1_5-with-sha3-256", H_SHA3_256 },
    { "sha3-384", H_SHA3_384 }, { "rsa-sha3-384", H_SHA3_384 }, { "id-rsassa-pkcs1-v1_5-with-sha3-384", H_SHA3_384 },
    { "sha3-512", H_SHA3_512 }, { "rsa-sha3-512", H_SHA3_512 }, { "id-rsassa-pkcs1-v1_5-with-sha3-512", H_SHA3_512 },
    { "shake128", H_SHAKE128 }, { "shake-128", H_SHAKE128 }, { "shake256", H_SHAKE256 }, { "shake-256", H_SHAKE256 },
};

/* crypto.getHashes(): Node's list, less the hashes we don't have (RIPEMD-160, BLAKE2, SM3) */
const char *const js_hash_names[] = {
    "RSA-MD5", "RSA-SHA1", "RSA-SHA1-2", "RSA-SHA224", "RSA-SHA256", "RSA-SHA3-224", "RSA-SHA3-256", "RSA-SHA3-384",
    "RSA-SHA3-512", "RSA-SHA384", "RSA-SHA512", "RSA-SHA512/224", "RSA-SHA512/256",
    "id-rsassa-pkcs1-v1_5-with-sha3-224", "id-rsassa-pkcs1-v1_5-with-sha3-256", "id-rsassa-pkcs1-v1_5-with-sha3-384",
    "id-rsassa-pkcs1-v1_5-with-sha3-512", "md5", "md5-sha1", "md5WithRSAEncryption", "sha1", "sha1WithRSAEncryption",
    "sha224", "sha224WithRSAEncryption", "sha256", "sha256WithRSAEncryption", "sha3-224", "sha3-256", "sha3-384",
    "sha3-512", "sha384", "sha384WithRSAEncryption", "sha512", "sha512-224", "sha512-224WithRSAEncryption",
    "sha512-256", "sha512-256WithRSAEncryption", "sha512WithRSAEncryption", "shake128", "shake256", "ssl3-md5",
    "ssl3-sha1",
};
const size_t js_hash_names_count = JS_COUNTOF(js_hash_names);

static bool same_ci(const char *a, const char *b) {
    for (; *a && *b; a++, b++)
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return false;
    return *a == *b;
}

const JSHashAlg *js_hash_by_name(const char *name) {
    for (size_t i = 0; i < JS_COUNTOF(NAMES); i++)
        if (same_ci(name, NAMES[i].name)) return &ALGS[NAMES[i].alg];
    return NULL;
}

const JSHashAlg *js_hash_by_web_name(const char *name) {
    for (size_t i = 0; i < JS_COUNTOF(ALGS); i++)
        if (ALGS[i].web && same_ci(name, ALGS[i].web)) return &ALGS[i];
    return NULL;
}

void js_hash_init(JSHashCtx *h, const JSHashAlg *alg) {
    h->alg = alg;
    switch (alg->kind) {
    case JS_HASH_BORINGSSL:
        alg->impl->init(&h->u.hash);
        break;
    case JS_HASH_SHA512T:
        SHA512_Init(&h->u.hash.sha512);
        memcpy(h->u.hash.sha512.h, alg->iv, sizeof h->u.hash.sha512.h);
        break;
    case JS_HASH_KECCAK:
        memset(&h->u.keccak, 0, sizeof h->u.keccak);
        h->u.keccak.rate = alg->block_len;
        break;
    }
}

void js_hash_update(JSHashCtx *h, const void *data, size_t n) {
    if (!n) return;
    if (h->alg->kind == JS_HASH_KECCAK) keccak_absorb(&h->u.keccak, data, n);
    else h->alg->impl->update(&h->u.hash, data, n);
}

void js_hash_final(JSHashCtx *h, uint8_t *out, size_t n) {
    if (h->alg->kind == JS_HASH_KECCAK) {
        keccak_squeeze(&h->u.keccak, h->alg->suffix, out, n);
        return;
    }
    uint8_t full[64];
    h->alg->impl->final(&h->u.hash, full);
    memcpy(out, full, n);
}

void js_hash_once(const JSHashAlg *alg, const void *data, size_t n, uint8_t *out) {
    JSHashCtx h;
    js_hash_init(&h, alg);
    js_hash_update(&h, data, n);
    js_hash_final(&h, out, alg->out_len);
}

/* ---- HMAC (RFC 2104) -------------------------------------------------------------------------- */

void js_hmac_init(JSHmacCtx *m, const JSHashAlg *alg, const uint8_t *key, size_t key_len) {
    uint8_t block[168] = { 0 };  /* the largest block: SHAKE128's rate */
    if (key_len > alg->block_len) js_hash_once(alg, key, key_len, block);
    else if (key_len) memcpy(block, key, key_len);
    for (size_t i = 0; i < alg->block_len; i++) block[i] ^= 0x36;
    js_hash_init(&m->inner, alg);
    js_hash_update(&m->inner, block, alg->block_len);
    for (size_t i = 0; i < alg->block_len; i++) block[i] ^= 0x36 ^ 0x5C;
    js_hash_init(&m->outer, alg);
    js_hash_update(&m->outer, block, alg->block_len);
}

void js_hmac_update(JSHmacCtx *m, const void *data, size_t n) { js_hash_update(&m->inner, data, n); }

void js_hmac_final(JSHmacCtx *m, uint8_t *out) {
    uint8_t inner[64];
    size_t n = m->inner.alg->out_len;
    js_hash_final(&m->inner, inner, n);
    js_hash_update(&m->outer, inner, n);
    js_hash_final(&m->outer, out, n);
}

/* ---- Random bytes ------------------------------------------------------------------------------- */

void js_crypto_random(void *out, size_t n) {
    if (n) RAND_bytes(out, n);
}

bool js_crypto_equal(const uint8_t *a, const uint8_t *b, size_t n) {
    uint8_t d = 0;
    for (size_t i = 0; i < n; i++) d |= a[i] ^ b[i];
    return d == 0;
}
