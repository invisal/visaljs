/* Big-integer primitives on BoringSSL's BIGNUM: node:crypto's finite-field Diffie-Hellman
 * (modular exponentiation), generatePrime and checkPrime. Integers travel as big-endian bytes. */
#include <stdlib.h>
#include <string.h>

#include <openssl/bn.h>
#include <openssl/err.h>

#include "builtins_util.h"
#include "crypto_internal.h"
#include "js_buffer.h"
#include "js_crypto.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_web.h"
#include "jscontext.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

static BIGNUM *bn_arg(JSValue v) {
    uint8_t *p;
    size_t n;
    if (!js_buffer_source_bytes(v, &p, &n)) return NULL;
    return BN_bin2bn(p, n, NULL);
}

/* A BIGNUM as a Buffer: big-endian, `pad` bytes long (zeros in front) or minimal (0: none, for zero) */
static JSValue bn_buffer(JSContext *ctx, const BIGNUM *b, size_t pad) {
    size_t n = pad ? pad : BN_num_bytes(b);
    uint8_t *out = malloc(n ? n : 1);
    if (!out) js_fatal("out of memory in crypto");
    if (pad) BN_bn2bin_padded(out, n, b);
    else BN_bn2bin(b, out);
    JSValue r = js_new_buffer_from_bytes(ctx, out, n);
    free(out);
    return r;
}

/* cryptoModExp(base, exponent, modulus, pad) → base^exponent mod modulus, a Buffer (`pad` bytes, or
 * minimal) | null for a modulus of zero. Constant time over the exponent for an odd modulus (the
 * secret is the exponent in Diffie-Hellman). */
PRIMITIVE(js_crypto_mod_exp) {
    UNUSED_ARGS;
    BIGNUM *b = bn_arg(ARG(0)), *e = bn_arg(ARG(1)), *m = bn_arg(ARG(2)), *r = BN_new();
    BN_CTX *bc = BN_CTX_new();
    if (!b || !e || !m || !r || !bc) {
        BN_free(b), BN_free(e), BN_free(m), BN_free(r), BN_CTX_free(bc);
        return js_throw_type_error(ctx, "cryptoModExp: bytes expected");
    }
    JSValue out = JS_NULL;
    if (!BN_is_zero(m)) {
        bool ok;
        if (BN_is_odd(m) && BN_cmp(b, m) < 0) ok = BN_mod_exp_mont_consttime(r, b, e, m, bc, NULL);
        else ok = BN_mod_exp(r, b, e, m, bc);
        if (ok) out = bn_buffer(ctx, r, js_is_number(ARG(3)) ? (size_t)js_as_number(ARG(3)) : 0);
    }
    BN_clear_free(e);
    BN_free(b), BN_free(m), BN_free(r), BN_CTX_free(bc);
    ERR_clear_error();
    return out;
}

/* cryptoGeneratePrime(bits, safe, add | undefined, rem | undefined) → a prime, a Buffer | null
 * when there is none with those constraints */
PRIMITIVE(js_crypto_generate_prime) {
    UNUSED_ARGS;
    int bits = js_is_number(ARG(0)) ? (int)js_as_number(ARG(0)) : 0;
    BIGNUM *add = js_is_undefined(ARG(2)) ? NULL : bn_arg(ARG(2)), *rem = js_is_undefined(ARG(3)) ? NULL : bn_arg(ARG(3));
    BIGNUM *p = BN_new();
    JSValue out = JS_NULL;
    if (p && BN_generate_prime_ex(p, bits, js_truthy(ARG(1)), add, rem, NULL)) out = bn_buffer(ctx, p, 0);
    BN_free(p), BN_free(add), BN_free(rem);
    ERR_clear_error();
    return out;
}

/* cryptoCheckPrime(candidate, checks) → whether it is (probably) prime: `checks` Miller-Rabin rounds,
 * or 0 for the number OpenSSL chooses */
PRIMITIVE(js_crypto_check_prime) {
    UNUSED_ARGS;
    BIGNUM *c = bn_arg(ARG(0));
    BN_CTX *bc = BN_CTX_new();
    int checks = js_is_number(ARG(1)) ? (int)js_as_number(ARG(1)) : 0;
    int prime = 0;
    if (c && bc && !BN_primality_test(&prime, c, checks ? checks : BN_prime_checks_for_generation, bc, 0, NULL)) prime = 0;
    BN_free(c), BN_CTX_free(bc);
    ERR_clear_error();
    return js_bool(prime);
}
