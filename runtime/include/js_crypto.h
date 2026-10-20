/* js_crypto.h — crypto: node:crypto's host primitives, which node/index.ts lists for
 * the compiler (generated code declares the ones a program uses), and what the crypto
 * component shares with them. The primitives are the runtime's, as Web Crypto runs on the same
 * C (runtime/src/crypto_internal.h). */
#ifndef JS_CRYPTO_H
#define JS_CRYPTO_H

#include "js_function.h"

/* A version 4 UUID, lowercase (crypto.randomUUID). */
JS_WARN_UNUSED JSValue js_crypto_random_uuid(JSContext *ctx);

#define JS_CRYPTO_PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);
JS_CRYPTO_PRIMITIVE(js_crypto_hash_new)
JS_CRYPTO_PRIMITIVE(js_crypto_hash_info)
JS_CRYPTO_PRIMITIVE(js_crypto_hash_copy)
JS_CRYPTO_PRIMITIVE(js_crypto_hmac_new)
JS_CRYPTO_PRIMITIVE(js_crypto_digest_update)
JS_CRYPTO_PRIMITIVE(js_crypto_digest_final)
JS_CRYPTO_PRIMITIVE(js_crypto_random_fill)
JS_CRYPTO_PRIMITIVE(js_crypto_host_random_uuid)
JS_CRYPTO_PRIMITIVE(js_crypto_timing_safe_equal)
JS_CRYPTO_PRIMITIVE(js_crypto_hashes)
JS_CRYPTO_PRIMITIVE(js_crypto_pbkdf2)
JS_CRYPTO_PRIMITIVE(js_crypto_hkdf)
JS_CRYPTO_PRIMITIVE(js_crypto_scrypt_check)
JS_CRYPTO_PRIMITIVE(js_crypto_scrypt)
JS_CRYPTO_PRIMITIVE(js_crypto_cipher_new)
JS_CRYPTO_PRIMITIVE(js_crypto_cipher_update)
JS_CRYPTO_PRIMITIVE(js_crypto_cipher_final)
JS_CRYPTO_PRIMITIVE(js_crypto_cipher_set_aad)
JS_CRYPTO_PRIMITIVE(js_crypto_cipher_set_auth_tag)
JS_CRYPTO_PRIMITIVE(js_crypto_cipher_get_auth_tag)
JS_CRYPTO_PRIMITIVE(js_crypto_cipher_set_padding)
JS_CRYPTO_PRIMITIVE(js_crypto_cipher_info)
JS_CRYPTO_PRIMITIVE(js_crypto_ciphers)
JS_CRYPTO_PRIMITIVE(js_crypto_key_parse)
JS_CRYPTO_PRIMITIVE(js_crypto_key_export)
JS_CRYPTO_PRIMITIVE(js_crypto_key_info)
JS_CRYPTO_PRIMITIVE(js_crypto_key_parts)
JS_CRYPTO_PRIMITIVE(js_crypto_key_from_parts)
JS_CRYPTO_PRIMITIVE(js_crypto_key_public)
JS_CRYPTO_PRIMITIVE(js_crypto_key_equals)
JS_CRYPTO_PRIMITIVE(js_crypto_key_secret)
JS_CRYPTO_PRIMITIVE(js_crypto_key_secret_bytes)
JS_CRYPTO_PRIMITIVE(js_crypto_key_generate)
JS_CRYPTO_PRIMITIVE(js_crypto_key_handle_of)
JS_CRYPTO_PRIMITIVE(js_crypto_to_crypto_key)
JS_CRYPTO_PRIMITIVE(js_crypto_sign)
JS_CRYPTO_PRIMITIVE(js_crypto_verify)
JS_CRYPTO_PRIMITIVE(js_crypto_rsa_crypt)
JS_CRYPTO_PRIMITIVE(js_crypto_ecdh)
JS_CRYPTO_PRIMITIVE(js_crypto_ec_point)
JS_CRYPTO_PRIMITIVE(js_crypto_ec_private)
JS_CRYPTO_PRIMITIVE(js_crypto_sign_message)
JS_CRYPTO_PRIMITIVE(js_crypto_verify_message)
JS_CRYPTO_PRIMITIVE(js_crypto_mod_exp)
JS_CRYPTO_PRIMITIVE(js_crypto_generate_prime)
JS_CRYPTO_PRIMITIVE(js_crypto_check_prime)
/* node:tls (crypto_tls.c) */
JS_CRYPTO_PRIMITIVE(js_tls_context_new)
JS_CRYPTO_PRIMITIVE(js_tls_context_add_roots)
JS_CRYPTO_PRIMITIVE(js_tls_context_add_ca)
JS_CRYPTO_PRIMITIVE(js_tls_context_set_cert)
JS_CRYPTO_PRIMITIVE(js_tls_context_set_key)
JS_CRYPTO_PRIMITIVE(js_tls_context_ticket_keys)
JS_CRYPTO_PRIMITIVE(js_tls_context_set_sessions)
JS_CRYPTO_PRIMITIVE(js_tls_pkcs12)
JS_CRYPTO_PRIMITIVE(js_tls_root_certificates)
JS_CRYPTO_PRIMITIVE(js_tls_new)
JS_CRYPTO_PRIMITIVE(js_tls_run)
JS_CRYPTO_PRIMITIVE(js_tls_shutdown)
JS_CRYPTO_PRIMITIVE(js_tls_info)
JS_CRYPTO_PRIMITIVE(js_tls_peer_certs)
JS_CRYPTO_PRIMITIVE(js_tls_verify_error)
JS_CRYPTO_PRIMITIVE(js_tls_session)
JS_CRYPTO_PRIMITIVE(js_tls_ticket)
JS_CRYPTO_PRIMITIVE(js_tls_export_keying_material)
JS_CRYPTO_PRIMITIVE(js_tls_set_no_renegotiation)
JS_CRYPTO_PRIMITIVE(js_tls_enable_keylog)
JS_CRYPTO_PRIMITIVE(js_tls_set_max_send_fragment)
JS_CRYPTO_PRIMITIVE(js_tls_finished)
JS_CRYPTO_PRIMITIVE(js_tls_ciphers)
JS_CRYPTO_PRIMITIVE(js_x509_check)
JS_CRYPTO_PRIMITIVE(js_x509_check_issued)
JS_CRYPTO_PRIMITIVE(js_x509_check_key)
#undef JS_CRYPTO_PRIMITIVE

#endif /* JS_CRYPTO_H */
