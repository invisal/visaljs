/* crypto_internal.h — the crypto primitives, runtime-private: what Web Crypto (the
 * crypto component) and node:crypto's host primitives share. BoringSSL is reached only through
 * the crypto*.c files, behind these. */
#ifndef JS_CRYPTO_INTERNAL_H
#define JS_CRYPTO_INTERNAL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <openssl/aes.h>
#include <openssl/des.h>
#include <openssl/md5.h>
#include <openssl/sha.h>

#include "js_object.h"

/* ---- Hashes ---------------------------------------------------------------------------------- */

typedef enum JSHashKind {
    JS_HASH_BORINGSSL,  /* one of BoringSSL's (MD5, SHA-1, SHA-2, MD5+SHA-1) */
    JS_HASH_SHA512T,    /* SHA-512/t: SHA-512 with its own IV, truncated */
    JS_HASH_KECCAK,     /* SHA-3 and SHAKE (crypto_hash.c's Keccak) */
} JSHashKind;

/* BoringSSL's hash contexts (plain structs: a copy is a copy of the hash) */
typedef union JSHashState {
    MD5_CTX    md5;
    SHA_CTX    sha1;
    SHA256_CTX sha256;
    SHA512_CTX sha512;
    struct { MD5_CTX md5; SHA_CTX sha1; } md5sha1;
} JSHashState;

/* A BoringSSL hash: its functions over JSHashState */
typedef struct JSHashImpl {
    void (*init)(JSHashState *s);
    void (*update)(JSHashState *s, const void *p, size_t n);
    void (*final)(JSHashState *s, uint8_t *out);
} JSHashImpl;

typedef struct JSHashAlg {
    const char          *name;       /* Node's canonical name: "sha256" */
    const char          *web;        /* Web Crypto's: "SHA-256", or NULL */
    uint8_t              kind;       /* JSHashKind */
    bool                 xof;        /* SHAKE: any output length */
    uint16_t             out_len;    /* digest bytes (SHAKE: the default output length) */
    uint16_t             block_len;  /* HMAC's block (Keccak: the rate) */
    const JSHashImpl    *impl;       /* JS_HASH_BORINGSSL */
    const uint64_t      *iv;         /* JS_HASH_SHA512T */
    uint8_t              suffix;     /* JS_HASH_KECCAK: 0x06 SHA-3, 0x1F SHAKE */
    /* its OID (PKCS#1 v1.5 signatures' DigestInfo): the length, then the bytes; or NULL */
    const unsigned char *oid;
} JSHashAlg;

typedef struct JSKeccak {
    uint64_t a[25];
    uint32_t rate, pos;  /* bytes per block; bytes absorbed into this one (or squeezed) */
    bool     squeezing;
} JSKeccak;

typedef struct JSHashCtx {
    const JSHashAlg *alg;
    union {
        JSHashState hash;
        JSKeccak    keccak;
    } u;
} JSHashCtx;

/* By Node's (OpenSSL's) name or alias, case-insensitive: "sha256", "SHA-256", "RSA-SHA256", … */
const JSHashAlg *js_hash_by_name(const char *name);
/* By Web Crypto's name, case-insensitive: "SHA-1", "SHA-256", "SHA-384", "SHA-512". */
const JSHashAlg *js_hash_by_web_name(const char *name);
/* Node's crypto.getHashes(), sorted as Node sorts them. */
extern const char *const js_hash_names[];
extern const size_t js_hash_names_count;

void js_hash_init(JSHashCtx *h, const JSHashAlg *alg);
void js_hash_update(JSHashCtx *h, const void *data, size_t n);
/* The digest (n bytes; SHAKE: any n, else at most out_len). Leaves h unusable but for copies made before. */
void js_hash_final(JSHashCtx *h, uint8_t *out, size_t n);
/* One call: the digest of data, alg->out_len bytes. */
void js_hash_once(const JSHashAlg *alg, const void *data, size_t n, uint8_t *out);

/* ---- HMAC ------------------------------------------------------------------------------------- */

typedef struct JSHmacCtx {
    JSHashCtx inner, outer;
} JSHmacCtx;

/* Any hash but the XOFs. */
void js_hmac_init(JSHmacCtx *m, const JSHashAlg *alg, const uint8_t *key, size_t key_len);
void js_hmac_update(JSHmacCtx *m, const void *data, size_t n);
/* alg->out_len bytes. */
void js_hmac_final(JSHmacCtx *m, uint8_t *out);

/* ---- Key derivation (crypto_kdf.c) ------------------------------------------------------------ */

/* PBKDF2-HMAC: false for an XOF or no iterations. */
bool js_pbkdf2(const JSHashAlg *alg, const uint8_t *pw, size_t pw_len, const uint8_t *salt, size_t salt_len,
               uint32_t iterations, uint8_t *out, size_t n);
/* HKDF: false for an XOF or more than 255 blocks. An empty salt is the hash's length of zeros. */
bool js_hkdf(const JSHashAlg *alg, const uint8_t *ikm, size_t ikm_len, const uint8_t *salt, size_t salt_len,
             const uint8_t *info, size_t info_len, uint8_t *out, size_t n);
/* scrypt's parameters as OpenSSL checks them: 0, or why not. */
enum { JS_SCRYPT_INVALID = 1, JS_SCRYPT_MEMORY = 2 };
int js_scrypt_check(uint64_t N, uint64_t r, uint64_t p, uint64_t maxmem);
/* scrypt with checked parameters: false when its memory can't be allocated. */
bool js_scrypt(const uint8_t *pw, size_t pw_len, const uint8_t *salt, size_t salt_len, uint64_t N, uint32_t r,
               uint32_t p, uint8_t *out, size_t n);

/* ---- Ciphers (crypto_cipher.c) ---------------------------------------------------------------- */

typedef enum JSCipherMode {
    JS_CIPHER_ECB, JS_CIPHER_CBC, JS_CIPHER_CFB, JS_CIPHER_CFB1, JS_CIPHER_CFB8, JS_CIPHER_OFB, JS_CIPHER_CTR, JS_CIPHER_GCM,
    JS_CIPHER_CCM, JS_CIPHER_WRAP, JS_CIPHER_WRAP_PAD, JS_CIPHER_CHACHA20, JS_CIPHER_CHACHA20_POLY1305,
} JSCipherMode;

typedef struct JSCipherAlg {
    const char *name;       /* as getCiphers lists it */
    const char *info_name;  /* getCipherInfo's name (OpenSSL's canonical one) */
    const char *mode_name;  /* getCipherInfo's mode */
    uint16_t    nid;
    uint8_t     mode;       /* JSCipherMode */
    uint8_t     prim;       /* 0 AES, 1 DES-EDE, 2 ChaCha20 */
    uint8_t     key_len;
    uint8_t     iv_len;     /* the default (AEAD) or only length; 0 for none */
    uint8_t     block_size; /* getCipherInfo's blockSize; 0 for none */
} JSCipherAlg;

extern const size_t js_cipher_count;
const JSCipherAlg *js_cipher_at(size_t i);
/* By a name getCiphers lists, or getCipherInfo's, case-insensitive. */
const JSCipherAlg *js_cipher_by_name(const char *name);
const JSCipherAlg *js_cipher_by_nid(int nid);
/* The AES cipher of a mode and key length (Web Crypto's), or NULL. */
const JSCipherAlg *js_cipher_aes(uint8_t mode, size_t key_len);

/* A growing byte buffer (malloc'd; the owner frees p). */
typedef struct JSBytesOut {
    uint8_t *p;
    size_t   n, cap;
} JSBytesOut;

enum { JS_CIPHER_INIT, JS_CIPHER_UPDATED, JS_CIPHER_FINAL };

/* Why an operation failed (each is one of Node's errors) */
enum {
    JS_CIPHER_ERR_KEYLEN = 1, JS_CIPHER_ERR_IV, JS_CIPHER_ERR_TAG_REQUIRED, JS_CIPHER_ERR_TAG_LENGTH, JS_CIPHER_ERR_STATE,
    JS_CIPHER_ERR_FINALIZED, JS_CIPHER_ERR_FINAL_BLOCK, JS_CIPHER_ERR_BAD_DECRYPT, JS_CIPHER_ERR_AUTH, JS_CIPHER_ERR_TAG_NOT_SET,
    JS_CIPHER_ERR_MESSAGE_LENGTH, JS_CIPHER_ERR_PLAINTEXT_LENGTH,
};

typedef struct JSCipherCtx {
    const JSCipherAlg *alg;
    bool     encrypt, padding;
    uint8_t  state;            /* JS_CIPHER_INIT, … */
    uint8_t  blk;              /* the block cipher's block: 16, or 8 for DES */
    AES_KEY  aes_enc, aes_dec;
    DES_key_schedule des[3];
    struct evp_cipher_ctx_st *gcm;  /* BoringSSL's GCM (an EVP_CIPHER_CTX) */
    uint8_t  key[32];          /* ChaCha20's */
    uint8_t  iv[16];           /* the chaining value, counter or feedback register; key wrap's IV */
    uint8_t  nonce[16];        /* CCM's and ChaCha20's */
    size_t   nonce_len;
    uint8_t  buf[16];          /* ECB and CBC: input waiting for a whole block */
    size_t   buf_len;
    uint8_t  ks[64];           /* keystream not used yet */
    size_t   ks_pos;
    uint32_t counter;          /* ChaCha20's block counter */
    uint8_t  tag[16];
    size_t   tag_len, given_tag_len;
    bool     tag_len_given, tag_set, tag_ready, ccm_length_set, auth_failed;
    size_t   ccm_length;
    JSBytesOut aad, data;      /* CCM's AAD, ChaCha20-Poly1305's AAD and ciphertext */
} JSCipherCtx;

/* tag_len: the authTagLength option, -1 for none. 0, or a JS_CIPHER_ERR_*. */
int js_cipher_init(JSCipherCtx *c, const JSCipherAlg *alg, bool encrypt, const uint8_t *key, size_t key_len, const uint8_t *iv,
                   size_t iv_len, bool has_iv, long tag_len);
void js_cipher_free(JSCipherCtx *c);
int js_cipher_update(JSCipherCtx *c, const uint8_t *p, size_t n, JSBytesOut *out);
int js_cipher_final(JSCipherCtx *c, JSBytesOut *out);
/* plaintext_length: CCM's, -1 for none. */
int js_cipher_set_aad(JSCipherCtx *c, const uint8_t *p, size_t n, long plaintext_length);
int js_cipher_set_auth_tag(JSCipherCtx *c, const uint8_t *p, size_t n);
bool js_cipher_get_auth_tag(JSCipherCtx *c, const uint8_t **p, size_t *n);
bool js_cipher_set_padding(JSCipherCtx *c, bool padding);
/* Web Crypto's AES-CTR: `bits` counter bits, the rest of the block fixed. False when it would repeat. */
bool js_aes_ctr_masked(const uint8_t *key, size_t key_len, const uint8_t counter[16], unsigned bits, const uint8_t *in, size_t n,
                       uint8_t *out);

/* ---- Random bytes ------------------------------------------------------------------------------ */

/* Cryptographically secure: BoringSSL's RAND_bytes (the system's entropy, then its DRBG). */
void js_crypto_random(void *out, size_t n);

/* Constant time over n bytes: whether they're equal. */
bool js_crypto_equal(const uint8_t *a, const uint8_t *b, size_t n);

/* ---- Keys (crypto_key.c) ------------------------------------------------------------------------ */

typedef enum JSKeyType { JS_KEY_SECRET, JS_KEY_PUBLIC, JS_KEY_PRIVATE } JSKeyType;

typedef enum JSAsymKind {
    JS_ASYM_NONE, JS_ASYM_RSA, JS_ASYM_RSA_PSS, JS_ASYM_EC, JS_ASYM_X25519, JS_ASYM_ED25519, JS_ASYM_DH, JS_ASYM_DSA,
} JSAsymKind;

/* The curves, by their TLS group numbers (Ed25519 by its signature scheme's) */
enum { JS_EC_P256 = 23, JS_EC_P384 = 24, JS_EC_P521 = 25, JS_EC_X25519 = 29, JS_EC_ED25519 = 0x0807 };

/* The parts of an asymmetric key, by index: RSA's integers (big-endian, minimal), an EC or X25519
 * key's public point (uncompressed for EC) and private scalar. */
enum { JS_RSA_N, JS_RSA_E, JS_RSA_D, JS_RSA_P, JS_RSA_Q, JS_RSA_DP, JS_RSA_DQ, JS_RSA_QI, JS_KEY_PARTS };
enum { JS_EC_PUB, JS_EC_PRIV };
/* finite-field Diffie-Hellman's and DSA's: the parameters, then the keys */
enum { JS_DH_P, JS_DH_G, JS_DH_PUB, JS_DH_PRIV };
enum { JS_DSA_P, JS_DSA_Q, JS_DSA_G, JS_DSA_PUB, JS_DSA_PRIV };

typedef struct JSKeyPart {
    uint8_t *p;
    size_t   n;
} JSKeyPart;

/* Key material: a handle that CryptoKey and node:crypto's KeyObject share. Every buffer is
 * malloc'd and wiped when the handle is collected. */
typedef struct JSKeyData {
    JSObject  obj;
    uint8_t   type;     /* JSKeyType */
    uint8_t   kind;     /* JSAsymKind; NONE for a secret key */
    uint8_t  *bytes;    /* a secret key's */
    size_t    len;
    JSKeyPart part[JS_KEY_PARTS];
    int       curve;    /* EC and X25519: JS_EC_* */
    /* RSA-PSS keys restricted to parameters (their AlgorithmIdentifier has them) */
    bool             pss_params;
    const JSHashAlg *pss_hash, *pss_mgf1;
    uint32_t         pss_salt;
} JSKeyData;

JSKeyData *js_key_data(JSValue v);
/* A secret key holding a copy of the bytes. */
JSValue js_new_secret_key(JSContext *ctx, const uint8_t *p, size_t n);
/* An empty asymmetric key of a type and kind, for crypto_pkey.c to fill. */
JSKeyData *js_new_asym_key(JSContext *ctx, uint8_t type, uint8_t kind);
void js_key_part_set(JSKeyPart *part, const uint8_t *p, size_t n);
/* The key encodings (the node:crypto primitives' codes too), and DER in and out (crypto_pkey.c):
 * 0, or an error code (1 not decodable, 2 bad DER, 3 a key type not provided, 4 an encoding
 * the key can't have). */
enum { JS_KEY_ENC_SPKI, JS_KEY_ENC_PKCS1, JS_KEY_ENC_PKCS8, JS_KEY_ENC_SEC1, JS_KEY_ENC_CERT };
int js_key_parse_der(JSContext *ctx, const uint8_t *p, size_t n, int enc, bool priv, JSValue *out);
int js_key_export_der(const JSKeyData *k, int enc, JSBytesOut *o);
/* A key from its parts (RSA's integers; EC's uncompressed point and scalar; X25519's): only the
 * public ones when !priv; an EC curve as JS_EC_*. */
int js_key_from_parts(JSContext *ctx, int kind, bool priv, int curve, const JSKeyPart parts[JS_KEY_PARTS], JSValue *out);
int js_ec_curve_by_jwk(const char *crv);
/* The public key of a private one (a new handle). */
JSValue js_key_public(JSContext *ctx, JSValue private_key);
/* New private keys: 0, or an error code (5: parameters BoringSSL rejects). */
int js_key_generate_rsa(JSContext *ctx, bool pss, uint32_t bits, uint32_t e, JSValue *out);
int js_key_generate_ec(JSContext *ctx, int curve, JSValue *out);
/* DSA parameters of L and N bits, and a key: 0, or an error code. */
int js_key_generate_dsa(JSContext *ctx, uint32_t l, uint32_t n, JSValue *out);
const char *js_ec_curve_jwk(int curve);

/* Web Crypto's key algorithms */
typedef enum JSWebAlg {
    JS_WEB_HMAC = 1, JS_WEB_PBKDF2, JS_WEB_HKDF, JS_WEB_AES_CTR, JS_WEB_AES_CBC, JS_WEB_AES_GCM, JS_WEB_AES_KW,
    JS_WEB_RSASSA, JS_WEB_RSA_PSS, JS_WEB_RSA_OAEP, JS_WEB_ECDSA, JS_WEB_ECDH, JS_WEB_X25519, JS_WEB_ED25519,
} JSWebAlg;

/* KeyUsage, as bits in this order */
enum {
    JS_USAGE_ENCRYPT = 1 << 0, JS_USAGE_DECRYPT = 1 << 1, JS_USAGE_SIGN = 1 << 2, JS_USAGE_VERIFY = 1 << 3,
    JS_USAGE_DERIVE_KEY = 1 << 4, JS_USAGE_DERIVE_BITS = 1 << 5, JS_USAGE_WRAP_KEY = 1 << 6, JS_USAGE_UNWRAP_KEY = 1 << 7,
};

typedef struct JSCryptoKey {
    JSObject         obj;
    JSValue          data;         /* a JSKeyData */
    JSValue          algorithm;    /* what `algorithm` returns (the same object each time) */
    JSValue          usages;       /* what `usages` returns: an array of strings */
    uint16_t         usage_mask;   /* JS_USAGE_* */
    uint8_t          alg;          /* JSWebAlg */
    bool             extractable;
    const JSHashAlg *hash;         /* HMAC's and RSA's */
    uint32_t         length;       /* HMAC's and AES's, in bits; RSA's modulus length */
} JSCryptoKey;

JSCryptoKey *js_as_crypto_key(JSValue v);
JSValue js_new_crypto_key(JSContext *ctx, JSValue data, uint8_t alg, const JSHashAlg *hash, uint32_t length, JSValue algorithm,
                          JSValue usages, uint16_t mask, bool extractable);

/* ---- Asymmetric operations (crypto_asym.c) ------------------------------------------------------ */

/* RSA paddings and PSS salt lengths: Node's (OpenSSL's) constants */
enum { JS_PADDING_PKCS1 = 1, JS_PADDING_NONE = 3, JS_PADDING_OAEP = 4, JS_PADDING_PSS = 6 };
enum { JS_SALT_DIGEST = -1, JS_SALT_MAX = -2, JS_SALT_AUTO = -2 };  /* -2: the most when signing, any when verifying */
enum { JS_RSA_PUBLIC_ENCRYPT, JS_RSA_PRIVATE_DECRYPT, JS_RSA_PRIVATE_ENCRYPT, JS_RSA_PUBLIC_DECRYPT };
/* why an operation failed (each one of Node's errors) */
enum {
    JS_ASYM_ERR_KEY_TYPE = 1, JS_ASYM_ERR_DIGEST, JS_ASYM_ERR_FAILED, JS_ASYM_ERR_SALT, JS_ASYM_ERR_TOO_LARGE, JS_ASYM_ERR_TOO_SMALL,
    JS_ASYM_ERR_OAEP, JS_ASYM_ERR_PADDING, JS_ASYM_ERR_POINT, JS_ASYM_ERR_CURVE, JS_ASYM_ERR_UNSUPPORTED,
};

/* Ed25519 signs messages, not digests: a 64-byte signature. 0, or an error. */
int js_ed25519_sign(const JSKeyData *k, const uint8_t *msg, size_t n, uint8_t sig[64]);
int js_ed25519_verify(const JSKeyData *k, const uint8_t *msg, size_t n, const uint8_t *sig, size_t sig_len, bool *valid);

/* A signature of a digest (alg->out_len bytes) into out (malloc'd). 0, or an error. */
int js_asym_sign(const JSKeyData *k, const JSHashAlg *h, const uint8_t *digest, int padding, long salt_len, bool p1363,
                 JSBytesOut *out);
int js_asym_verify(const JSKeyData *k, const JSHashAlg *h, const uint8_t *digest, int padding, long salt_len, bool p1363,
                   const uint8_t *sig, size_t sig_len, bool *valid);
int js_rsa_crypt(const JSKeyData *k, int op, int padding, const JSHashAlg *oaep_hash, const uint8_t *label, size_t label_len,
                 const uint8_t *in, size_t n, JSBytesOut *out);
/* The shared secret of a private key and a peer's point (any encoding for EC). */
int js_ecdh(const JSKeyData *k, const uint8_t *peer, size_t peer_len, uint8_t *secret, size_t *secret_len);
int js_ec_curve_by_name(const char *name);
/* A private scalar's public point (EC: uncompressed) or X25519's public value: false when it isn't one. */
bool js_ec_public_of(int curve, const uint8_t *scalar, size_t n, uint8_t *out, size_t *out_len);
size_t js_ec_field_size(int curve);
bool js_ec_point_uncompressed(int curve, const uint8_t *in, size_t n, uint8_t *out);
size_t js_ec_point_format(int curve, const uint8_t *point, int format, uint8_t *out);

/* subtle.importKey's steps, without the promise: a CryptoKey, or JS_EXCEPTION. */
JSValue js_crypto_import_key_steps(JSContext *ctx, uint32_t argc, const JSValue *argv);

/* The crypto component's parts, installed by crypto.c */
void js_crypto_install_key(JSContext *ctx, JSObject *global);
void js_crypto_install_subtle(JSContext *ctx, JSObject *global);

#endif /* JS_CRYPTO_INTERNAL_H */
