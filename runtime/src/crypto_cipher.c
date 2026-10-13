/* The crypto primitives' ciphers: one streaming context for every cipher node:crypto
 * offers (AES in ECB, CBC, CFB, CFB1, CFB8, OFB, CTR, GCM, CCM and key wrap; 2- and 3-key
 * DES-EDE; ChaCha20 and ChaCha20-Poly1305), with OpenSSL's padding, chunking and checks. Web
 * Crypto's AES runs on it too. BoringSSL gives the block functions (the fastest the CPU has:
 * AES-NI, ARMv8, else constant-time), GCM, ChaCha20 and Poly1305; the modes over a block (CBC,
 * CFB, OFB, a 128-bit CTR, key wrap, CCM) are ours. */
#include <stdlib.h>
#include <string.h>

#include <openssl/chacha.h>
#include <openssl/cipher.h>
#include <openssl/poly1305.h>

#include "crypto_internal.h"
#include "js_builtins.h"
#include "js_exception.h"

/* ---- The table (getCiphers, getCipherInfo: Node's values for each name) ------------------------- */

#define AES(name, info, mode, nid, bs, iv, kl, m) { name, info, mode, nid, JS_CIPHER_##m, 0, kl, iv, bs }
#define DES(name, info, mode, nid, bs, iv, kl, m) { name, info, mode, nid, JS_CIPHER_##m, 1, kl, iv, bs }

static const JSCipherAlg CIPHERS[] = {
    AES("aes-128-cbc", "aes-128-cbc", "cbc", 419, 16, 16, 16, CBC),
    AES("aes-128-ccm", "id-aes128-ccm", "ccm", 896, 1, 12, 16, CCM),
    AES("aes-128-cfb", "aes-128-cfb", "cfb", 421, 1, 16, 16, CFB),
    AES("aes-128-cfb1", "aes-128-cfb1", "cfb", 650, 1, 16, 16, CFB1),
    AES("aes-128-cfb8", "aes-128-cfb8", "cfb", 653, 1, 16, 16, CFB8),
    AES("aes-128-ctr", "aes-128-ctr", "ctr", 904, 1, 16, 16, CTR),
    AES("aes-128-ecb", "aes-128-ecb", "ecb", 418, 16, 0, 16, ECB),
    AES("aes-128-gcm", "id-aes128-gcm", "gcm", 895, 1, 12, 16, GCM),
    AES("aes-128-ofb", "aes-128-ofb", "ofb", 420, 1, 16, 16, OFB),
    AES("aes-192-cbc", "aes-192-cbc", "cbc", 423, 16, 16, 24, CBC),
    AES("aes-192-ccm", "id-aes192-ccm", "ccm", 899, 1, 12, 24, CCM),
    AES("aes-192-cfb", "aes-192-cfb", "cfb", 425, 1, 16, 24, CFB),
    AES("aes-192-cfb1", "aes-192-cfb1", "cfb", 651, 1, 16, 24, CFB1),
    AES("aes-192-cfb8", "aes-192-cfb8", "cfb", 654, 1, 16, 24, CFB8),
    AES("aes-192-ctr", "aes-192-ctr", "ctr", 905, 1, 16, 24, CTR),
    AES("aes-192-ecb", "aes-192-ecb", "ecb", 422, 16, 0, 24, ECB),
    AES("aes-192-gcm", "id-aes192-gcm", "gcm", 898, 1, 12, 24, GCM),
    AES("aes-192-ofb", "aes-192-ofb", "ofb", 424, 1, 16, 24, OFB),
    AES("aes-256-cbc", "aes-256-cbc", "cbc", 427, 16, 16, 32, CBC),
    AES("aes-256-ccm", "id-aes256-ccm", "ccm", 902, 1, 12, 32, CCM),
    AES("aes-256-cfb", "aes-256-cfb", "cfb", 429, 1, 16, 32, CFB),
    AES("aes-256-cfb1", "aes-256-cfb1", "cfb", 652, 1, 16, 32, CFB1),
    AES("aes-256-cfb8", "aes-256-cfb8", "cfb", 655, 1, 16, 32, CFB8),
    AES("aes-256-ctr", "aes-256-ctr", "ctr", 906, 1, 16, 32, CTR),
    AES("aes-256-ecb", "aes-256-ecb", "ecb", 426, 16, 0, 32, ECB),
    AES("aes-256-gcm", "id-aes256-gcm", "gcm", 901, 1, 12, 32, GCM),
    AES("aes-256-ofb", "aes-256-ofb", "ofb", 428, 1, 16, 32, OFB),
    AES("aes128", "aes-128-cbc", "cbc", 419, 16, 16, 16, CBC),
    AES("aes128-wrap", "id-aes128-wrap", "wrap", 788, 8, 8, 16, WRAP),
    AES("aes128-wrap-pad", "id-aes128-wrap-pad", "wrap", 897, 8, 4, 16, WRAP_PAD),
    AES("aes192", "aes-192-cbc", "cbc", 423, 16, 16, 24, CBC),
    AES("aes192-wrap", "id-aes192-wrap", "wrap", 789, 8, 8, 24, WRAP),
    AES("aes192-wrap-pad", "id-aes192-wrap-pad", "wrap", 900, 8, 4, 24, WRAP_PAD),
    AES("aes256", "aes-256-cbc", "cbc", 427, 16, 16, 32, CBC),
    AES("aes256-wrap", "id-aes256-wrap", "wrap", 790, 8, 8, 32, WRAP),
    AES("aes256-wrap-pad", "id-aes256-wrap-pad", "wrap", 903, 8, 4, 32, WRAP_PAD),
    { "chacha20", "chacha20", "stream", 1019, JS_CIPHER_CHACHA20, 2, 32, 16, 0 },
    { "chacha20-poly1305", "chacha20-poly1305", "stream", 1018, JS_CIPHER_CHACHA20_POLY1305, 2, 32, 12, 0 },
    DES("des-ede", "des-ede", "ecb", 32, 8, 0, 16, ECB),
    DES("des-ede-cbc", "des-ede-cbc", "cbc", 43, 8, 8, 16, CBC),
    DES("des-ede-cfb", "des-ede-cfb", "cfb", 60, 1, 8, 16, CFB),
    DES("des-ede-ecb", "des-ede", "ecb", 32, 8, 0, 16, ECB),
    DES("des-ede-ofb", "des-ede-ofb", "ofb", 62, 1, 8, 16, OFB),
    DES("des-ede3", "des-ede3", "ecb", 33, 8, 0, 24, ECB),
    DES("des-ede3-cbc", "des-ede3-cbc", "cbc", 44, 8, 8, 24, CBC),
    DES("des-ede3-cfb", "des-ede3-cfb", "cfb", 61, 1, 8, 24, CFB),
    DES("des-ede3-cfb1", "des-ede3-cfb1", "cfb", 658, 1, 8, 24, CFB1),
    DES("des-ede3-cfb8", "des-ede3-cfb8", "cfb", 659, 1, 8, 24, CFB8),
    DES("des-ede3-ecb", "des-ede3", "ecb", 33, 8, 0, 24, ECB),
    DES("des-ede3-ofb", "des-ede3-ofb", "ofb", 63, 1, 8, 24, OFB),
    DES("des3", "des-ede3-cbc", "cbc", 44, 8, 8, 24, CBC),
    AES("id-aes128-CCM", "id-aes128-ccm", "ccm", 896, 1, 12, 16, CCM),
    AES("id-aes128-GCM", "id-aes128-gcm", "gcm", 895, 1, 12, 16, GCM),
    AES("id-aes128-wrap", "id-aes128-wrap", "wrap", 788, 8, 8, 16, WRAP),
    AES("id-aes128-wrap-pad", "id-aes128-wrap-pad", "wrap", 897, 8, 4, 16, WRAP_PAD),
    AES("id-aes192-CCM", "id-aes192-ccm", "ccm", 899, 1, 12, 24, CCM),
    AES("id-aes192-GCM", "id-aes192-gcm", "gcm", 898, 1, 12, 24, GCM),
    AES("id-aes192-wrap", "id-aes192-wrap", "wrap", 789, 8, 8, 24, WRAP),
    AES("id-aes192-wrap-pad", "id-aes192-wrap-pad", "wrap", 900, 8, 4, 24, WRAP_PAD),
    AES("id-aes256-CCM", "id-aes256-ccm", "ccm", 902, 1, 12, 32, CCM),
    AES("id-aes256-GCM", "id-aes256-gcm", "gcm", 901, 1, 12, 32, GCM),
    AES("id-aes256-wrap", "id-aes256-wrap", "wrap", 790, 8, 8, 32, WRAP),
    AES("id-aes256-wrap-pad", "id-aes256-wrap-pad", "wrap", 903, 8, 4, 32, WRAP_PAD),
};

const size_t js_cipher_count = JS_COUNTOF(CIPHERS);

const JSCipherAlg *js_cipher_at(size_t i) { return i < JS_COUNTOF(CIPHERS) ? &CIPHERS[i] : NULL; }

static bool same_ci(const char *a, const char *b) {
    for (; *a && *b; a++, b++) {
        char x = *a >= 'A' && *a <= 'Z' ? (char)(*a + 32) : *a, y = *b >= 'A' && *b <= 'Z' ? (char)(*b + 32) : *b;
        if (x != y) return false;
    }
    return *a == *b;
}

const JSCipherAlg *js_cipher_by_name(const char *name) {
    for (size_t i = 0; i < JS_COUNTOF(CIPHERS); i++)
        if (same_ci(name, CIPHERS[i].name) || same_ci(name, CIPHERS[i].info_name)) return &CIPHERS[i];
    return NULL;
}

const JSCipherAlg *js_cipher_by_nid(int nid) {
    for (size_t i = 0; i < JS_COUNTOF(CIPHERS); i++)
        if (CIPHERS[i].nid == nid) return &CIPHERS[i];
    return NULL;
}

/* An AES cipher of this mode and key length (Web Crypto's). */
const JSCipherAlg *js_cipher_aes(uint8_t mode, size_t key_len) {
    for (size_t i = 0; i < JS_COUNTOF(CIPHERS); i++)
        if (CIPHERS[i].mode == mode && CIPHERS[i].prim == 0 && CIPHERS[i].key_len == key_len) return &CIPHERS[i];
    return NULL;
}

/* ---- Block functions ----------------------------------------------------------------------------- */

/* One block encrypted (decrypted) in place: AES's, or 3DES's (blk 8). */
static void block_enc(JSCipherCtx *c, uint8_t *b) {
    if (c->blk == 8) DES_ecb3_encrypt((const DES_cblock *)b, (DES_cblock *)b, &c->des[0], &c->des[1], &c->des[2], DES_ENCRYPT);
    else AES_encrypt(b, b, &c->aes_enc);
}
static void block_dec(JSCipherCtx *c, uint8_t *b) {
    if (c->blk == 8) DES_ecb3_encrypt((const DES_cblock *)b, (DES_cblock *)b, &c->des[0], &c->des[1], &c->des[2], DES_DECRYPT);
    else AES_decrypt(b, b, &c->aes_dec);
}

/* CBC over one block, in place, chaining through c->iv */
static void cbc_enc(JSCipherCtx *c, uint8_t *b) {
    for (size_t i = 0; i < c->blk; i++) b[i] ^= c->iv[i];
    block_enc(c, b);
    memcpy(c->iv, b, c->blk);
}
static void cbc_dec(JSCipherCtx *c, uint8_t *b) {
    uint8_t in[16];
    memcpy(in, b, c->blk);
    block_dec(c, b);
    for (size_t i = 0; i < c->blk; i++) b[i] ^= c->iv[i];
    memcpy(c->iv, in, c->blk);
}

static const EVP_CIPHER *gcm_cipher(size_t key_len) {
    return key_len == 16 ? EVP_aes_128_gcm() : key_len == 24 ? EVP_aes_192_gcm() : EVP_aes_256_gcm();
}

/* ---- Output buffer ------------------------------------------------------------------------------- */

static void out_put(JSBytesOut *o, const uint8_t *p, size_t n) {
    if (o->n + n > o->cap) {
        size_t cap = o->cap ? o->cap : 64;
        while (cap < o->n + n) cap *= 2;
        uint8_t *q = realloc(o->p, cap);
        if (!q) js_fatal("out of memory in crypto");
        o->p = q;
        o->cap = cap;
    }
    if (n) memcpy(o->p + o->n, p, n);
    o->n += n;
}

static void buf_put(JSBytesOut *b, const uint8_t *p, size_t n) { out_put(b, p, n); }

/* ---- Setup ----------------------------------------------------------------------------------------- */

static bool valid_ccm_tag(size_t n) { return n >= 4 && n <= 16 && n % 2 == 0; }
static bool valid_gcm_tag(size_t n) { return n == 4 || n == 8 || (n >= 12 && n <= 16); }

int js_cipher_init(JSCipherCtx *c, const JSCipherAlg *alg, bool encrypt, const uint8_t *key, size_t key_len, const uint8_t *iv,
                   size_t iv_len, bool has_iv, long tag_len) {
    memset(c, 0, sizeof *c);
    c->alg = alg;
    c->encrypt = encrypt;
    c->padding = true;
    c->blk = alg->prim == 1 ? 8 : 16;
    if (key_len != alg->key_len) return JS_CIPHER_ERR_KEYLEN;
    /* the IV: AEAD modes take a range of lengths, the others exactly theirs (ECB none) */
    switch (alg->mode) {
    case JS_CIPHER_GCM:
        if (!has_iv || iv_len == 0) return JS_CIPHER_ERR_IV;
        break;
    case JS_CIPHER_CCM:
        if (!has_iv || iv_len < 7 || iv_len > 13) return JS_CIPHER_ERR_IV;
        break;
    case JS_CIPHER_ECB:
        if (has_iv && iv_len != 0) return JS_CIPHER_ERR_IV;
        break;
    default:
        if (!has_iv || iv_len != alg->iv_len) return JS_CIPHER_ERR_IV;
        break;
    }
    if (alg->mode != JS_CIPHER_GCM) {  /* GCM takes any length, straight into BoringSSL's */
        if (iv_len > sizeof c->nonce) return JS_CIPHER_ERR_IV;
        if (iv_len) memcpy(c->nonce, iv, iv_len);
        c->nonce_len = iv_len;
    }
    /* the tag length (-1: not given) */
    c->tag_len = 16;
    if (alg->mode == JS_CIPHER_CCM) {
        if (tag_len < 0) return JS_CIPHER_ERR_TAG_REQUIRED;
        if (!valid_ccm_tag((size_t)tag_len)) return JS_CIPHER_ERR_TAG_LENGTH;
        c->tag_len = (size_t)tag_len;
    } else if (alg->mode == JS_CIPHER_GCM) {
        if (tag_len >= 0 && !valid_gcm_tag((size_t)tag_len)) return JS_CIPHER_ERR_TAG_LENGTH;
        if (tag_len >= 0) c->tag_len = (size_t)tag_len, c->tag_len_given = true;
    } else if (alg->mode == JS_CIPHER_CHACHA20_POLY1305) {
        if (tag_len >= 0 && (tag_len < 1 || tag_len > 16)) return JS_CIPHER_ERR_TAG_LENGTH;
        if (tag_len >= 0) c->tag_len = (size_t)tag_len;
    }
    memcpy(c->key, key, key_len);
    if (alg->prim == 0) {
        AES_set_encrypt_key(key, (unsigned)key_len * 8, &c->aes_enc);
        AES_set_decrypt_key(key, (unsigned)key_len * 8, &c->aes_dec);
    } else if (alg->prim == 1) {  /* DES-EDE: K1, K2, K1; DES-EDE3: K1, K2, K3 */
        DES_set_key_unchecked((const DES_cblock *)key, &c->des[0]);
        DES_set_key_unchecked((const DES_cblock *)(key + 8), &c->des[1]);
        DES_set_key_unchecked((const DES_cblock *)(key + (key_len == 24 ? 16 : 0)), &c->des[2]);
    }
    if (iv_len && alg->mode != JS_CIPHER_GCM && alg->mode != JS_CIPHER_CCM) memcpy(c->iv, iv, iv_len < 16 ? iv_len : 16);
    switch (alg->mode) {
    case JS_CIPHER_GCM:
        c->gcm = EVP_CIPHER_CTX_new();
        if (!c->gcm) js_fatal("out of memory in crypto");
        if (!EVP_CipherInit_ex(c->gcm, gcm_cipher(key_len), NULL, NULL, NULL, encrypt) ||
            !EVP_CIPHER_CTX_ctrl(c->gcm, EVP_CTRL_GCM_SET_IVLEN, (int)iv_len, NULL) ||
            !EVP_CipherInit_ex(c->gcm, NULL, NULL, key, iv, -1))
            return JS_CIPHER_ERR_IV;
        break;
    case JS_CIPHER_CHACHA20:
        c->counter = (uint32_t)iv[0] | (uint32_t)iv[1] << 8 | (uint32_t)iv[2] << 16 | (uint32_t)iv[3] << 24;
        memcpy(c->nonce, iv + 4, 12);
        c->ks_pos = 64;
        break;
    case JS_CIPHER_CHACHA20_POLY1305:
        c->counter = 1;  /* block 0 makes the Poly1305 key */
        c->ks_pos = 64;
        break;
    default:
        c->ks_pos = c->blk;
        break;
    }
    return 0;
}

void js_cipher_free(JSCipherCtx *c) {
    EVP_CIPHER_CTX_free(c->gcm);
    c->gcm = NULL;
    free(c->aad.p);
    free(c->data.p);
    memset(c->key, 0, sizeof c->key);
    c->aad.p = c->data.p = NULL;
}

/* ---- Streams of keystream ----------------------------------------------------------------------- */

static const uint8_t ZEROS[64];

static void chacha_block(JSCipherCtx *c) {
    CRYPTO_chacha_20(c->ks, ZEROS, 64, c->key, c->nonce, c->counter++);
    c->ks_pos = 0;
}

static void ctr_increment(uint8_t *ctr, size_t n) {
    for (size_t i = n; i-- > 0;)
        if (++ctr[i]) break;
}

/* ---- Update ------------------------------------------------------------------------------------- */

/* PKCS#7 blocks (ECB, CBC): whole blocks go through, a partial one waits; decrypting with padding
 * holds back the last whole block for final. */
static void blocks_update(JSCipherCtx *c, const uint8_t *p, size_t n, JSBytesOut *out) {
    size_t blk = c->blk;
    bool hold = !c->encrypt && c->padding;
    while (n > 0) {
        size_t take = blk - c->buf_len < n ? blk - c->buf_len : n;
        memcpy(c->buf + c->buf_len, p, take);
        c->buf_len += take;
        p += take;
        n -= take;
        if (c->buf_len < blk || (hold && n == 0)) break;
        uint8_t b[16];
        memcpy(b, c->buf, blk);
        if (c->alg->mode == JS_CIPHER_ECB) {
            if (c->encrypt) block_enc(c, b);
            else block_dec(c, b);
        } else if (c->encrypt) {
            cbc_enc(c, b);
        } else {
            cbc_dec(c, b);
        }
        out_put(out, b, blk);
        c->buf_len = 0;
    }
}

static void stream_update(JSCipherCtx *c, const uint8_t *p, size_t n, JSBytesOut *out) {
    size_t blk = c->blk;
    for (size_t i = 0; i < n; i++) {
        uint8_t x = p[i], y;
        switch (c->alg->mode) {
        case JS_CIPHER_CTR:
            if (c->ks_pos == blk) {
                memcpy(c->ks, c->iv, blk);
                block_enc(c, c->ks);
                ctr_increment(c->iv, blk);
                c->ks_pos = 0;
            }
            y = x ^ c->ks[c->ks_pos++];
            break;
        case JS_CIPHER_OFB:
            if (c->ks_pos == blk) {
                block_enc(c, c->iv);
                memcpy(c->ks, c->iv, blk);
                c->ks_pos = 0;
            }
            y = x ^ c->ks[c->ks_pos++];
            break;
        case JS_CIPHER_CFB:
            if (c->ks_pos == blk) {
                memcpy(c->ks, c->iv, blk);
                block_enc(c, c->ks);
                c->ks_pos = 0;
            }
            y = x ^ c->ks[c->ks_pos];
            c->iv[c->ks_pos++] = c->encrypt ? y : x;  /* the next register: this block's ciphertext */
            break;
        case JS_CIPHER_CFB8: {
            uint8_t k[16];
            memcpy(k, c->iv, blk);
            block_enc(c, k);
            y = x ^ k[0];
            memmove(c->iv, c->iv + 1, blk - 1);
            c->iv[blk - 1] = c->encrypt ? y : x;
            break;
        }
        case JS_CIPHER_CFB1: {
            y = 0;
            for (int bit = 7; bit >= 0; bit--) {
                uint8_t k[16];
                memcpy(k, c->iv, blk);
                block_enc(c, k);
                uint8_t in = (uint8_t)((x >> bit) & 1), o = (uint8_t)(in ^ (k[0] >> 7));
                y |= (uint8_t)(o << bit);
                uint8_t shifted = c->encrypt ? o : in;  /* the register takes the ciphertext bit */
                for (size_t j = 0; j < blk; j++) c->iv[j] = (uint8_t)(c->iv[j] << 1 | (j + 1 < blk ? c->iv[j + 1] >> 7 : shifted));
            }
            break;
        }
        default: /* ChaCha20, and ChaCha20-Poly1305's encryption */
            if (c->ks_pos == 64) chacha_block(c);
            y = x ^ c->ks[c->ks_pos++];
            break;
        }
        out_put(out, &y, 1);
    }
}

/* AES key wrap (RFC 3394) and with padding (RFC 5649): the whole input of one update. */
static int wrap(JSCipherCtx *c, const uint8_t *p, size_t n, JSBytesOut *out) {
    bool pad = c->alg->mode == JS_CIPHER_WRAP_PAD;
    uint8_t a[8];
    size_t len = n;
    if (pad) {
        if (n == 0) return JS_CIPHER_ERR_STATE;
        memcpy(a, c->iv, 4);
        a[4] = (uint8_t)(n >> 24), a[5] = (uint8_t)(n >> 16), a[6] = (uint8_t)(n >> 8), a[7] = (uint8_t)n;
        len = (n + 7) / 8 * 8;
    } else {
        if (n < 16 || n % 8) return JS_CIPHER_ERR_STATE;
        memcpy(a, c->iv, 8);
    }
    uint8_t *r = calloc(len + 8, 1);
    if (!r) js_fatal("out of memory in crypto");
    memcpy(r + 8, p, n);
    size_t blocks = len / 8;
    if (pad && blocks == 1) {  /* one block: encrypted once, with A in front */
        memcpy(r, a, 8);
        block_enc(c, r);
    } else {
        for (size_t j = 0; j < 6; j++) {
            for (size_t i = 1; i <= blocks; i++) {
                uint8_t b[16];
                memcpy(b, a, 8);
                memcpy(b + 8, r + 8 * i, 8);
                block_enc(c, b);
                uint64_t t = (uint64_t)(blocks * j + i);
                memcpy(a, b, 8);
                for (int k = 0; k < 8; k++) a[7 - k] ^= (uint8_t)(t >> (8 * k));
                memcpy(r + 8 * i, b + 8, 8);
            }
        }
        memcpy(r, a, 8);
    }
    out_put(out, r, len + 8);
    free(r);
    return 0;
}

static int unwrap(JSCipherCtx *c, const uint8_t *p, size_t n, JSBytesOut *out) {
    bool pad = c->alg->mode == JS_CIPHER_WRAP_PAD;
    if (n % 8 || n < (pad ? 16u : 24u)) return JS_CIPHER_ERR_STATE;
    size_t blocks = n / 8 - 1;
    uint8_t a[8], *r = malloc(n);
    if (!r) js_fatal("out of memory in crypto");
    memcpy(r, p, n);
    if (pad && blocks == 1) {
        uint8_t b[16];
        memcpy(b, r, 16);
        block_dec(c, b);
        memcpy(a, b, 8);
        memcpy(r + 8, b + 8, 8);
    } else {
        memcpy(a, r, 8);
        for (size_t j = 6; j-- > 0;) {
            for (size_t i = blocks; i >= 1; i--) {
                uint8_t b[16];
                uint64_t t = (uint64_t)(blocks * j + i);
                memcpy(b, a, 8);
                for (int k = 0; k < 8; k++) b[7 - k] ^= (uint8_t)(t >> (8 * k));
                memcpy(b + 8, r + 8 * i, 8);
                block_dec(c, b);
                memcpy(a, b, 8);
                memcpy(r + 8 * i, b + 8, 8);
            }
        }
    }
    int err = 0;
    size_t len = blocks * 8;
    if (pad) {
        size_t mli = (size_t)a[4] << 24 | (size_t)a[5] << 16 | (size_t)a[6] << 8 | a[7];
        if (memcmp(a, c->iv, 4) != 0 || mli > len || mli + 8 <= len) err = JS_CIPHER_ERR_STATE;
        else {
            for (size_t i = mli; i < len; i++)
                if (r[8 + i]) err = JS_CIPHER_ERR_STATE;
            len = mli;
        }
    } else if (!js_crypto_equal(a, c->iv, 8)) {
        err = JS_CIPHER_ERR_STATE;
    }
    if (!err) out_put(out, r + 8, len);
    free(r);
    return err;
}

/* CCM (NIST SP 800-38C) over the AES block: the counter block for i */
static void ccm_counter(const JSCipherCtx *c, uint64_t i, uint8_t *a) {
    size_t L = 15 - c->nonce_len;
    memset(a, 0, 16);
    a[0] = (uint8_t)(L - 1);
    memcpy(a + 1, c->nonce, c->nonce_len);
    for (size_t k = 0; k < L && k < 8; k++) a[15 - k] = (uint8_t)(i >> (8 * k));
}

/* CBC-MAC over B0, the AAD (its length encoded first) and the payload, each padded with zeros */
static void ccm_mac(JSCipherCtx *c, const uint8_t *p, size_t n, uint8_t *x) {
    size_t L = 15 - c->nonce_len, at = 0;
    memset(x, 0, 16);
    x[0] = (uint8_t)((c->aad.n ? 0x40 : 0) | ((c->tag_len - 2) / 2) << 3 | (L - 1));
    memcpy(x + 1, c->nonce, c->nonce_len);
    for (size_t k = 0; k < L && k < 8; k++) x[15 - k] = (uint8_t)((uint64_t)n >> (8 * k));
    block_enc(c, x);
    if (c->aad.n) {
        uint8_t head[10];
        size_t hn;
        uint64_t a = c->aad.n;
        if (a < 0xFF00) head[0] = (uint8_t)(a >> 8), head[1] = (uint8_t)a, hn = 2;
        else if (a <= 0xFFFFFFFFu) {
            head[0] = 0xFF, head[1] = 0xFE, hn = 6;
            for (int k = 0; k < 4; k++) head[2 + k] = (uint8_t)(a >> (24 - 8 * k));
        } else {
            head[0] = 0xFF, head[1] = 0xFF, hn = 10;
            for (int k = 0; k < 8; k++) head[2 + k] = (uint8_t)(a >> (56 - 8 * k));
        }
        for (size_t k = 0; k < hn; k++) {
            x[at++] ^= head[k];
            if (at == 16) block_enc(c, x), at = 0;
        }
        for (size_t k = 0; k < c->aad.n; k++) {
            x[at++] ^= c->aad.p[k];
            if (at == 16) block_enc(c, x), at = 0;
        }
        if (at) block_enc(c, x), at = 0;
    }
    for (size_t k = 0; k < n; k++) {
        x[at++] ^= p[k];
        if (at == 16) block_enc(c, x), at = 0;
    }
    if (at) block_enc(c, x);
}

static void ccm_ctr(JSCipherCtx *c, const uint8_t *in, uint8_t *out, size_t n) {
    uint8_t a[16];
    for (size_t k = 0; k < n; k += 16) {
        ccm_counter(c, k / 16 + 1, a);
        block_enc(c, a);
        for (size_t j = 0; j < 16 && k + j < n; j++) out[k + j] = in[k + j] ^ a[j];
    }
}

/* The CCM run, done at its one update: the lengths are known only now. */
static int ccm_run(JSCipherCtx *c, const uint8_t *p, size_t n, JSBytesOut *out) {
    size_t L = 15 - c->nonce_len;
    if (L < 8 && n >= (1ULL << (8 * L))) return JS_CIPHER_ERR_MESSAGE_LENGTH;
    if (c->ccm_length_set && n != c->ccm_length) return JS_CIPHER_ERR_STATE;
    uint8_t *d = malloc(n ? n : 1);
    if (!d) js_fatal("out of memory in crypto");
    uint8_t x[16], s0[16];
    ccm_counter(c, 0, s0);
    block_enc(c, s0);
    if (c->encrypt) {
        ccm_mac(c, p, n, x);
        ccm_ctr(c, p, d, n);
        for (size_t k = 0; k < c->tag_len; k++) c->tag[k] = x[k] ^ s0[k];
        out_put(out, d, n);
    } else {
        ccm_ctr(c, p, d, n);
        ccm_mac(c, d, n, x);
        for (size_t k = 0; k < c->tag_len; k++) x[k] ^= s0[k];
        if (c->tag_set && js_crypto_equal(x, c->tag, c->tag_len)) out_put(out, d, n);
        else c->auth_failed = true;  /* the output is nothing; final reports it */
    }
    memset(d, 0, n);
    free(d);
    return 0;
}

/* ChaCha20-Poly1305's tag (RFC 8439): Poly1305, keyed by block 0, over the AAD and ciphertext */
static void chapoly_tag(JSCipherCtx *c, uint8_t tag[16]) {
    uint8_t otk[32], lens[16];
    CRYPTO_chacha_20(otk, ZEROS, 32, c->key, c->nonce, 0);
    poly1305_state st;
    CRYPTO_poly1305_init(&st, otk);
    CRYPTO_poly1305_update(&st, c->aad.p ? c->aad.p : ZEROS, c->aad.n);
    CRYPTO_poly1305_update(&st, ZEROS, (16 - c->aad.n % 16) % 16);
    CRYPTO_poly1305_update(&st, c->data.p ? c->data.p : ZEROS, c->data.n);
    CRYPTO_poly1305_update(&st, ZEROS, (16 - c->data.n % 16) % 16);
    for (int k = 0; k < 8; k++) lens[k] = (uint8_t)((uint64_t)c->aad.n >> (8 * k)), lens[8 + k] = (uint8_t)((uint64_t)c->data.n >> (8 * k));
    CRYPTO_poly1305_update(&st, lens, 16);
    CRYPTO_poly1305_finish(&st, tag);
    memset(otk, 0, sizeof otk);
}

int js_cipher_update(JSCipherCtx *c, const uint8_t *p, size_t n, JSBytesOut *out) {
    if (c->state == JS_CIPHER_FINAL) return JS_CIPHER_ERR_STATE;
    switch (c->alg->mode) {
    case JS_CIPHER_ECB:
    case JS_CIPHER_CBC:
        blocks_update(c, p, n, out);
        break;
    case JS_CIPHER_GCM:
        if (n) {
            size_t start = out->n;
            out_put(out, p, n);
            int got;
            if (!EVP_CipherUpdate(c->gcm, out->p + start, &got, p, (int)n)) return JS_CIPHER_ERR_STATE;
            out->n = start + (size_t)got;
        }
        break;
    case JS_CIPHER_CCM: {
        if (c->state == JS_CIPHER_UPDATED) return JS_CIPHER_ERR_STATE;  /* CCM takes its data at once */
        int e = ccm_run(c, p, n, out);
        if (e) return e;
        break;
    }
    case JS_CIPHER_WRAP:
    case JS_CIPHER_WRAP_PAD: {
        int e = c->encrypt ? wrap(c, p, n, out) : unwrap(c, p, n, out);
        if (e) return e;
        break;
    }
    case JS_CIPHER_CHACHA20_POLY1305: {
        size_t start = out->n;
        stream_update(c, p, n, out);
        buf_put(&c->data, c->encrypt ? out->p + start : p, n);  /* Poly1305 runs over the ciphertext at final */
        break;
    }
    default:
        stream_update(c, p, n, out);
        break;
    }
    c->state = JS_CIPHER_UPDATED;
    return 0;
}

/* ---- Final -------------------------------------------------------------------------------------- */

int js_cipher_final(JSCipherCtx *c, JSBytesOut *out) {
    if (c->state == JS_CIPHER_FINAL) return JS_CIPHER_ERR_FINALIZED;
    bool updated = c->state == JS_CIPHER_UPDATED;
    c->state = JS_CIPHER_FINAL;
    size_t blk = c->blk;
    switch (c->alg->mode) {
    case JS_CIPHER_ECB:
    case JS_CIPHER_CBC: {
        uint8_t b[16];
        if (c->encrypt) {
            if (!c->padding) return c->buf_len ? JS_CIPHER_ERR_FINAL_BLOCK : 0;
            uint8_t pad = (uint8_t)(blk - c->buf_len);
            memcpy(b, c->buf, c->buf_len);
            memset(b + c->buf_len, pad, pad);
            c->buf_len = 0;
            if (c->alg->mode == JS_CIPHER_ECB) block_enc(c, b);
            else cbc_enc(c, b);
            out_put(out, b, blk);
            return 0;
        }
        if (!c->padding) return c->buf_len ? JS_CIPHER_ERR_FINAL_BLOCK : 0;
        if (c->buf_len != blk) return JS_CIPHER_ERR_FINAL_BLOCK;
        memcpy(b, c->buf, blk);
        if (c->alg->mode == JS_CIPHER_ECB) block_dec(c, b);
        else cbc_dec(c, b);
        uint8_t pad = b[blk - 1];
        if (pad == 0 || pad > blk) return JS_CIPHER_ERR_BAD_DECRYPT;
        for (size_t i = blk - pad; i < blk; i++)
            if (b[i] != pad) return JS_CIPHER_ERR_BAD_DECRYPT;
        out_put(out, b, blk - pad);
        return 0;
    }
    case JS_CIPHER_GCM: {
        (void)updated;
        uint8_t rest[16];
        int got;
        if (c->encrypt) {
            if (!EVP_CipherFinal_ex(c->gcm, rest, &got) || !EVP_CIPHER_CTX_ctrl(c->gcm, EVP_CTRL_GCM_GET_TAG, 16, c->tag))
                return JS_CIPHER_ERR_STATE;
            c->tag_ready = true;
            return 0;
        }
        if (!c->tag_set || !EVP_CIPHER_CTX_ctrl(c->gcm, EVP_CTRL_GCM_SET_TAG, (int)c->given_tag_len, c->tag) ||
            !EVP_CipherFinal_ex(c->gcm, rest, &got))
            return JS_CIPHER_ERR_AUTH;
        return 0;
    }
    case JS_CIPHER_CCM:
        if (c->encrypt) {
            if (!updated) return JS_CIPHER_ERR_TAG_NOT_SET;
            c->tag_ready = true;
            return 0;
        }
        return !updated || c->auth_failed ? JS_CIPHER_ERR_AUTH : 0;
    case JS_CIPHER_CHACHA20_POLY1305: {
        uint8_t tag[16];
        chapoly_tag(c, tag);
        if (c->encrypt) {
            memcpy(c->tag, tag, 16);
            c->tag_ready = true;
            return 0;
        }
        if (!c->tag_set || !js_crypto_equal(tag, c->tag, c->given_tag_len)) return JS_CIPHER_ERR_AUTH;
        return 0;
    }
    default:
        return 0;
    }
}

/* ---- AEAD -------------------------------------------------------------------------------------- */

int js_cipher_set_aad(JSCipherCtx *c, const uint8_t *p, size_t n, long plaintext_length) {
    switch (c->alg->mode) {
    case JS_CIPHER_GCM: {
        if (c->state != JS_CIPHER_INIT) return JS_CIPHER_ERR_STATE;
        int got;
        if (n && !EVP_CipherUpdate(c->gcm, NULL, &got, p, (int)n)) return JS_CIPHER_ERR_STATE;
        return 0;
    }
    case JS_CIPHER_CCM:
        if (c->state != JS_CIPHER_INIT) return JS_CIPHER_ERR_STATE;
        if (plaintext_length < 0) return JS_CIPHER_ERR_PLAINTEXT_LENGTH;
        {
            size_t L = 15 - c->nonce_len;
            if (L < 8 && (uint64_t)plaintext_length >= (1ULL << (8 * L))) return JS_CIPHER_ERR_MESSAGE_LENGTH;
        }
        c->ccm_length = (size_t)plaintext_length;
        c->ccm_length_set = true;
        buf_put(&c->aad, p, n);
        return 0;
    case JS_CIPHER_CHACHA20_POLY1305:
        if (c->state != JS_CIPHER_INIT) return JS_CIPHER_ERR_STATE;
        buf_put(&c->aad, p, n);
        return 0;
    default:
        return JS_CIPHER_ERR_STATE;
    }
}

int js_cipher_set_auth_tag(JSCipherCtx *c, const uint8_t *p, size_t n) {
    uint8_t mode = c->alg->mode;
    if (c->encrypt || (mode != JS_CIPHER_GCM && mode != JS_CIPHER_CCM && mode != JS_CIPHER_CHACHA20_POLY1305) || c->tag_set ||
        c->state == JS_CIPHER_FINAL)
        return JS_CIPHER_ERR_STATE;
    bool ok = mode == JS_CIPHER_GCM ? (c->tag_len_given ? n == c->tag_len : valid_gcm_tag(n)) : n == c->tag_len;
    if (!ok) return JS_CIPHER_ERR_TAG_LENGTH;
    memcpy(c->tag, p, n);
    c->given_tag_len = n;
    c->tag_set = true;
    return 0;
}

bool js_cipher_get_auth_tag(JSCipherCtx *c, const uint8_t **p, size_t *n) {
    if (!c->encrypt || !c->tag_ready) return false;
    *p = c->tag;
    *n = c->tag_len;
    return true;
}

bool js_cipher_set_padding(JSCipherCtx *c, bool padding) {
    if (c->state == JS_CIPHER_FINAL) return false;
    c->padding = padding;
    return true;
}

/* ---- Web Crypto's AES-CTR ---------------------------------------------------------------------- */

/* The rightmost `bits` bits of the counter block count (wrapping within them), the rest stay;
 * false when the data needs more blocks than the counter has values (they would repeat). */
bool js_aes_ctr_masked(const uint8_t *key, size_t key_len, const uint8_t counter[16], unsigned bits, const uint8_t *in, size_t n,
                       uint8_t *out) {
    size_t blocks = (n + 15) / 16;
    if (bits < 64 && blocks > (1ULL << bits)) return false;
    JSCipherCtx c;
    memset(&c, 0, sizeof c);
    c.blk = 16;
    AES_set_encrypt_key(key, (unsigned)key_len * 8, &c.aes_enc);
    uint8_t ctr[16];
    memcpy(ctr, counter, 16);
    for (size_t i = 0; i < n; i += 16) {
        uint8_t ks[16];
        memcpy(ks, ctr, 16);
        block_enc(&c, ks);
        size_t take = n - i < 16 ? n - i : 16;
        for (size_t j = 0; j < take; j++) out[i + j] = in[i + j] ^ ks[j];
        /* increment the low `bits` bits, big-endian, carrying no further */
        unsigned left = bits;
        for (int b = 15; b >= 0 && left > 0; b--) {
            unsigned width = left >= 8 ? 8 : left;
            uint8_t mask = (uint8_t)((1u << width) - 1);
            uint8_t v = (uint8_t)(((ctr[b] & mask) + 1) & mask);
            ctr[b] = (uint8_t)((ctr[b] & ~mask) | v);
            left -= width;
            if (v != 0) break;  /* no carry */
        }
    }
    return true;
}
