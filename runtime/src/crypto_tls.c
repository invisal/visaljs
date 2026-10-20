/* node:tls's host primitives: TLS 1.0–1.3 on BoringSSL, the OpenSSL fork, so
 * connections behave as Node's (OpenSSL's) do: chain building, alerts, half-close, sessions and
 * tickets, X509_V_ERR verification results. node/prelude's tls.js builds Node's SecureContext,
 * TLSSocket and Server on these; this file only drives BoringSSL.
 *
 * A context (tlsContextNew) is an SSL_CTX: versions, ciphers, groups, the trusted CAs (an
 * X509_STORE: the bundled roots, shared and parsed once, or the program's own), certificate chain
 * and key, and the session cache. A connection (tlsNew) is an SSL between two memory BIOs: tlsRun
 * feeds it the peer's records and the data to send, and returns the records to send and the data
 * received. The JS side owns the socket.
 *
 * Certificates are checked as Node checks them: the verify callback lets every handshake through
 * (as Node's does), and the prelude decides once it is done, from SSL_get_verify_result and
 * checkServerIdentity, whether the connection is authorized. */
#include <stdlib.h>
#include <string.h>

#include <openssl/bio.h>
#include <openssl/bytestring.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/pkcs8.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include "builtins_util.h"
#include "crypto_internal.h"
#include "internal.h"
#include "js_buffer.h"
#include "js_crypto.h"
#include "js_exception.h"
#include "js_gc.h"
#include "js_ops.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

#include "tls_roots.gen.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

static void out_append(JSBytesOut *o, const void *p, size_t n) {
    if (o->n + n > o->cap) {
        size_t cap = o->cap ? o->cap : 4096;
        while (cap < o->n + n) cap *= 2;
        uint8_t *q = realloc(o->p, cap);
        if (!q) js_fatal("out of memory in tls");
        o->p = q;
        o->cap = cap;
    }
    memcpy(o->p + o->n, p, n);
    o->n += n;
}

static bool bytes_arg(JSValue v, const uint8_t **p, size_t *n) {
    uint8_t *q;
    if (!js_buffer_source_bytes(v, &q, n)) return false;
    *p = q;
    return true;
}

/* A string argument as a NUL-terminated UTF-8 copy (malloc'd), or NULL. */
static char *string_dup(JSContext *ctx, JSValue v) {
    if (!js_is_string(v)) return NULL;
    JSStrView view = js_string_view(ctx, v);
    size_t n = js_view_to_utf8(view, NULL, 0);
    char *s = malloc(n + 1);
    if (!s) js_fatal("out of memory in tls");
    js_view_to_utf8(view, s, n);
    s[n] = 0;
    return s;
}

static JSValue bytes_or_null(JSContext *ctx, JSBytesOut *o) {
    JSValue v = o->n ? js_new_buffer_from_bytes(ctx, o->p, o->n) : JS_NULL;
    free(o->p);
    return v;
}

/* ---- The bundled roots: one store, parsed the first time a context trusts them -------------------- */

#define ROOT_COUNT (sizeof tls_root_pems / sizeof *tls_root_pems)

static X509_STORE *root_store;

static X509_STORE *roots(void) {
    if (root_store) return root_store;
    root_store = X509_STORE_new();
    for (size_t i = 0; i < ROOT_COUNT; i++) {
        BIO *b = BIO_new_mem_buf(tls_root_pems[i], -1);
        X509 *x = PEM_read_bio_X509(b, NULL, NULL, NULL);
        if (x) X509_STORE_add_cert(root_store, x);
        X509_free(x);
        BIO_free(b);
    }
    ERR_clear_error();
    return root_store;
}

/* tlsRootCertificates() → [pem, …]: tls.rootCertificates */
PRIMITIVE(js_tls_root_certificates) {
    UNUSED_ARGS;
    JSValue a = js_new_array(ctx, (uint32_t)ROOT_COUNT);
    for (size_t i = 0; i < ROOT_COUNT; i++) {
        JSValue s = js_new_string_cstr(ctx, tls_root_pems[i]);
        if (js_is_exception(s) || js_array_append(ctx, a, s) < 0) return JS_EXCEPTION;
    }
    return a;
}

/* ---- Errors ------------------------------------------------------------------------------------- */

/* The first error queued, as [library, reason code, reason name ("WRONG_VERSION_NUMBER")], or 0
 * when there's none; the queue is cleared. */
static JSValue error_info(JSContext *ctx) {
    uint32_t e = ERR_get_error();
    ERR_clear_error();
    if (!e) return js_int32(0);
    const char *reason = ERR_reason_error_string(e);
    JSValue items[3] = { js_int32(ERR_GET_LIB(e)), js_int32(ERR_GET_REASON(e)), js_new_string_cstr(ctx, reason ? reason : "UNKNOWN") };
    return js_new_array_from(ctx, items, 3);
}

/* ---- Contexts ----------------------------------------------------------------------------------- */

typedef struct TlsContextObject {
    JSObject obj;
    SSL_CTX *ctx;
    bool     own_store;  /* the program's CAs, not the shared roots */
} TlsContextObject;

static void context_finalize(JSRuntime *rt, JSCell *cell) {
    (void)rt;
    SSL_CTX_free(((TlsContextObject *)cell)->ctx);
}

static const JSClass context_class = { "SecureContext", sizeof(TlsContextObject), NULL, NULL, NULL, NULL, NULL, context_finalize, NULL };

static TlsContextObject *context_arg(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &context_class ? (TlsContextObject *)js_as_object(v) : NULL;
}

static int verify_accept(int ok, X509_STORE_CTX *store) {
    (void)ok, (void)store;
    return 1;  /* the prelude decides, once the handshake is done (Node's VerifyCallback) */
}

static int on_new_session(SSL *ssl, SSL_SESSION *session);
static int on_alpn_select(SSL *ssl, const uint8_t **out, uint8_t *out_len, const uint8_t *in, unsigned in_len, void *arg);

/* tlsContextNew(minVersion, maxVersion, ciphers, serverPreference, groups | null, sigalgs | null)
 * → context | an error ([library, reason, name]) for a cipher list or groups BoringSSL rejects.
 * Versions are TLS's (0x0301 … 0x0304); ciphers OpenSSL's cipher-list syntax (TLS 1.2 and below:
 * BoringSSL doesn't configure TLS 1.3's). */
PRIMITIVE(js_tls_context_new) {
    UNUSED_ARGS;
    SSL_CTX *c = SSL_CTX_new(TLS_method());
    if (!c) js_fatal("out of memory in tls");
    SSL_CTX_set_min_proto_version(c, js_is_number(ARG(0)) ? (uint16_t)js_as_number(ARG(0)) : TLS1_2_VERSION);
    SSL_CTX_set_max_proto_version(c, js_is_number(ARG(1)) ? (uint16_t)js_as_number(ARG(1)) : TLS1_3_VERSION);
    bool ok = true;
    char *ciphers = string_dup(ctx, ARG(2));
    if (ciphers) ok = SSL_CTX_set_cipher_list(c, ciphers);
    free(ciphers);
    if (js_truthy(ARG(3))) SSL_CTX_set_options(c, SSL_OP_CIPHER_SERVER_PREFERENCE);
    char *groups = string_dup(ctx, ARG(4));
    if (ok && groups) ok = SSL_CTX_set1_groups_list(c, groups);
    free(groups);
    char *sigalgs = string_dup(ctx, ARG(5));
    if (ok && sigalgs) {
        ok = SSL_CTX_set1_sigalgs_list(c, sigalgs);
    } else if (ok) {
        /* the peer's signatures accepted: BoringSSL's, and Ed25519 (OpenSSL's take it; BoringSSL's don't by default) */
        static const uint16_t verify[] = {
            SSL_SIGN_ECDSA_SECP256R1_SHA256, SSL_SIGN_RSA_PSS_RSAE_SHA256, SSL_SIGN_RSA_PKCS1_SHA256, SSL_SIGN_ECDSA_SECP384R1_SHA384,
            SSL_SIGN_RSA_PSS_RSAE_SHA384, SSL_SIGN_RSA_PKCS1_SHA384, SSL_SIGN_RSA_PSS_RSAE_SHA512, SSL_SIGN_RSA_PKCS1_SHA512,
            SSL_SIGN_ED25519, SSL_SIGN_ECDSA_SHA1, SSL_SIGN_RSA_PKCS1_SHA1,
        };
        ok = SSL_CTX_set_verify_algorithm_prefs(c, verify, sizeof verify / sizeof *verify);
    }
    free(sigalgs);
    if (!ok) {
        SSL_CTX_free(c);
        return error_info(ctx);
    }
    SSL_CTX_set_verify(c, SSL_VERIFY_NONE, NULL);
    SSL_CTX_set_session_cache_mode(c, SSL_SESS_CACHE_BOTH);
    SSL_CTX_sess_set_new_cb(c, on_new_session);
    SSL_CTX_set_alpn_select_cb(c, on_alpn_select, NULL);
    static const uint8_t sid[] = "visaljs";
    SSL_CTX_set_session_id_context(c, sid, sizeof sid - 1);
    SSL_CTX_set_mode(c, SSL_MODE_ENABLE_PARTIAL_WRITE | SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
    TlsContextObject *o = (TlsContextObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &context_class, JS_NULL, 0));
    o->ctx = c;
    return js_object_value(&o->obj);
}

/* tlsContextAddRoots(context): trust the bundled root certificates (shared by every context that
 * trusts only them) */
PRIMITIVE(js_tls_context_add_roots) {
    UNUSED_ARGS;
    TlsContextObject *o = context_arg(ARG(0));
    if (!o) return js_throw_type_error(ctx, "tlsContextAddRoots: a context expected");
    X509_STORE *store = roots();
    if (o->own_store) {
        /* both: the roots join the program's CAs */
        STACK_OF(X509_OBJECT) *objs = X509_STORE_get0_objects(store);
        X509_STORE *mine = SSL_CTX_get_cert_store(o->ctx);
        for (size_t i = 0; i < sk_X509_OBJECT_num(objs); i++) {
            X509 *x = X509_OBJECT_get0_X509(sk_X509_OBJECT_value(objs, i));
            if (x) X509_STORE_add_cert(mine, x);
        }
    } else {
        X509_STORE_up_ref(store);
        SSL_CTX_set_cert_store(o->ctx, store);
    }
    ERR_clear_error();
    return JS_UNDEFINED;
}

static X509 *x509_arg(JSValue v) {
    const uint8_t *p;
    size_t n;
    if (!bytes_arg(v, &p, &n)) return NULL;
    return d2i_X509(NULL, &p, (long)n);
}

/* tlsContextAddCA(context, der) → 0 | an error: a CA to trust, and (a server's) to name when
 * asking for a client certificate */
PRIMITIVE(js_tls_context_add_ca) {
    UNUSED_ARGS;
    TlsContextObject *o = context_arg(ARG(0));
    if (!o) return js_throw_type_error(ctx, "tlsContextAddCA: a context expected");
    X509 *x = x509_arg(ARG(1));
    if (!x) return error_info(ctx);
    if (!o->own_store) {
        SSL_CTX_set_cert_store(o->ctx, X509_STORE_new());
        o->own_store = true;
    }
    X509_STORE_add_cert(SSL_CTX_get_cert_store(o->ctx), x);
    SSL_CTX_add_client_CA(o->ctx, x);
    X509_free(x);
    ERR_clear_error();
    return js_int32(0);
}

/* tlsContextSetCert(context, [der, …]) → 0 | an error: the chain to send, leaf first */
PRIMITIVE(js_tls_context_set_cert) {
    UNUSED_ARGS;
    TlsContextObject *o = context_arg(ARG(0));
    if (!o || !js_is_array(ARG(1))) return js_throw_type_error(ctx, "tlsContextSetCert: a context and certificates expected");
    uint32_t n = js_array_length(js_as_object(ARG(1)));
    SSL_CTX_clear_chain_certs(o->ctx);
    for (uint32_t i = 0; i < n; i++) {
        X509 *x = x509_arg(js_get_value(ctx, ARG(1), js_index_key(i)));
        if (!x) return error_info(ctx);
        int ok = i == 0 ? SSL_CTX_use_certificate(o->ctx, x) : SSL_CTX_add1_chain_cert(o->ctx, x);
        X509_free(x);
        if (!ok) return error_info(ctx);
    }
    return js_int32(0);
}

/* A key (handle) as BoringSSL's, from its PKCS#8 or SPKI DER, or NULL for one BoringSSL can't use */
static EVP_PKEY *pkey_of(const JSKeyData *k) {
    bool private = k->type == JS_KEY_PRIVATE;
    if (!private && k->type != JS_KEY_PUBLIC) return NULL;
    JSBytesOut der = { 0 };
    if (js_key_export_der(k, private ? JS_KEY_ENC_PKCS8 : JS_KEY_ENC_SPKI, &der) != 0) {
        free(der.p);
        return NULL;
    }
    CBS cbs;
    CBS_init(&cbs, der.p, der.n);
    EVP_PKEY *pkey = private ? EVP_parse_private_key(&cbs) : EVP_parse_public_key(&cbs);
    memset(der.p, 0, der.n);
    free(der.p);
    ERR_clear_error();
    return pkey;
}

/* tlsContextSetKey(context, key handle) → 0 | 1 a key TLS can't use | 2 not the certificate's key */
PRIMITIVE(js_tls_context_set_key) {
    UNUSED_ARGS;
    TlsContextObject *o = context_arg(ARG(0));
    JSKeyData *k = js_key_data(ARG(1));
    if (!o || !k) return js_throw_type_error(ctx, "tlsContextSetKey: a context and a key expected");
    if (k->type != JS_KEY_PRIVATE) return js_int32(1);
    EVP_PKEY *pkey = pkey_of(k);
    if (!pkey) return js_int32(1);
    int ok = SSL_CTX_use_PrivateKey(o->ctx, pkey);
    EVP_PKEY_free(pkey);
    ERR_clear_error();
    if (!ok) return js_int32(2);
    return js_int32(0);
}

/* tlsContextAddCredential(context, [der, …], key handle) → 0 | 1 a key TLS can't use | 2 not the
 * certificate's key: one of a server's identities (a chain, leaf first, and its key), which
 * BoringSSL chooses among by what the client accepts, as OpenSSL does by key type */
PRIMITIVE(js_tls_context_add_credential) {
    UNUSED_ARGS;
    TlsContextObject *o = context_arg(ARG(0));
    JSKeyData *k = js_key_data(ARG(2));
    if (!o || !js_is_array(ARG(1)) || !k) return js_throw_type_error(ctx, "tlsContextAddCredential: a context, certificates and a key expected");
    uint32_t n = js_array_length(js_as_object(ARG(1)));
    if (n == 0 || n > 16) return js_throw_type_error(ctx, "tlsContextAddCredential: 1 to 16 certificates expected");
    CRYPTO_BUFFER *certs[16] = { 0 };
    int result = 0;
    for (uint32_t i = 0; i < n && result == 0; i++) {
        const uint8_t *p;
        size_t len;
        if (!bytes_arg(js_get_value(ctx, ARG(1), js_index_key(i)), &p, &len) || !(certs[i] = CRYPTO_BUFFER_new(p, len, NULL))) result = 1;
    }
    EVP_PKEY *pkey = result == 0 && k->type == JS_KEY_PRIVATE ? pkey_of(k) : NULL;
    SSL_CREDENTIAL *cred = SSL_CREDENTIAL_new_x509();
    if (result == 0 && (!pkey || !cred)) result = 1;
    if (result == 0 && !SSL_CREDENTIAL_set1_cert_chain(cred, certs, n)) result = 1;
    if (result == 0 && !SSL_CREDENTIAL_set1_private_key(cred, pkey)) result = 2;
    if (result == 0 && !SSL_CTX_add1_credential(o->ctx, cred)) result = 1;
    SSL_CREDENTIAL_free(cred);
    EVP_PKEY_free(pkey);
    for (uint32_t i = 0; i < n; i++) CRYPTO_BUFFER_free(certs[i]);
    ERR_clear_error();
    return js_int32(result);
}

/* tlsContextAllowPartialChain(context): a trusted intermediate ends a chain, as a root does
 * (allowPartialTrustChain); on the context's parameters, as its store may be the shared roots' */
PRIMITIVE(js_tls_context_allow_partial_chain) {
    UNUSED_ARGS;
    TlsContextObject *o = context_arg(ARG(0));
    if (!o) return js_throw_type_error(ctx, "tlsContextAllowPartialChain: a context expected");
    X509_VERIFY_PARAM_set_flags(SSL_CTX_get0_param(o->ctx), X509_V_FLAG_PARTIAL_CHAIN);
    return JS_UNDEFINED;
}

/* tlsContextTicketKeys(context, keys | null) → the 48 bytes the context's session tickets are
 * encrypted with (after setting them to `keys`) */
PRIMITIVE(js_tls_context_ticket_keys) {
    UNUSED_ARGS;
    TlsContextObject *o = context_arg(ARG(0));
    if (!o) return js_throw_type_error(ctx, "tlsContextTicketKeys: a context expected");
    const uint8_t *p;
    size_t n;
    if (bytes_arg(ARG(1), &p, &n)) {
        if (n != 48 || !SSL_CTX_set_tlsext_ticket_keys(o->ctx, p, n)) return js_throw_type_error(ctx, "tlsContextTicketKeys: 48 bytes expected");
    }
    uint8_t keys[48];
    SSL_CTX_get_tlsext_ticket_keys(o->ctx, keys, sizeof keys);
    return js_new_buffer_from_bytes(ctx, keys, sizeof keys);
}

/* tlsContextSetSessions(context, timeout | null, sessionIdContext | null): how long a session can
 * be resumed (seconds), and the context its id is valid in */
PRIMITIVE(js_tls_context_set_sessions) {
    UNUSED_ARGS;
    TlsContextObject *o = context_arg(ARG(0));
    if (!o) return js_throw_type_error(ctx, "tlsContextSetSessions: a context expected");
    if (js_is_number(ARG(1))) SSL_CTX_set_timeout(o->ctx, (uint32_t)js_as_number(ARG(1)));
    char *sid = string_dup(ctx, ARG(2));
    if (sid) {
        /* OpenSSL's limit, which Node passes through */
        size_t n = strlen(sid);
        SSL_CTX_set_session_id_context(o->ctx, (const uint8_t *)sid, n > SSL_MAX_SID_CTX_LENGTH ? SSL_MAX_SID_CTX_LENGTH : n);
        free(sid);
    }
    return JS_UNDEFINED;
}

/* tlsPkcs12(der, password | null) → [private key (PKCS#8 DER) | null, certificate (DER) | null,
 * [the other certificates' DER, …]] | the reason it can't be read (OpenSSL's words) */
PRIMITIVE(js_tls_pkcs12) {
    UNUSED_ARGS;
    const uint8_t *p;
    size_t n;
    if (!bytes_arg(ARG(0), &p, &n)) return js_throw_type_error(ctx, "tlsPkcs12: bytes expected");
    char *password = string_dup(ctx, ARG(1));
    PKCS12 *p12 = d2i_PKCS12(NULL, &p, (long)n);
    EVP_PKEY *pkey = NULL;
    X509 *cert = NULL;
    STACK_OF(X509) *others = NULL;
    bool ok = p12 && PKCS12_parse(p12, password, &pkey, &cert, &others);
    if (password) {
        memset(password, 0, strlen(password));
        free(password);
    }
    PKCS12_free(p12);
    if (!ok) {
        const char *reason = ERR_reason_error_string(ERR_peek_last_error());
        ERR_clear_error();
        return js_new_string_cstr(ctx, reason ? reason : "Unknown error");
    }
    JSValue parts[3] = { JS_NULL, JS_NULL, JS_NULL };
    if (pkey) {
        CBB cbb;
        uint8_t *der;
        size_t len;
        if (CBB_init(&cbb, 0) && EVP_marshal_private_key(&cbb, pkey) && CBB_finish(&cbb, &der, &len)) {
            parts[0] = js_new_buffer_from_bytes(ctx, der, len);
            OPENSSL_cleanse(der, len);
            OPENSSL_free(der);
        } else {
            CBB_cleanup(&cbb);
        }
    }
    uint8_t *der = NULL;
    int len;
    if (cert && (len = i2d_X509(cert, &der)) > 0) parts[1] = js_new_buffer_from_bytes(ctx, der, (size_t)len);
    OPENSSL_free(der);
    size_t count = others ? sk_X509_num(others) : 0;
    parts[2] = js_new_array(ctx, 0);
    for (size_t i = 0; i < count; i++) {
        der = NULL;
        if ((len = i2d_X509(sk_X509_value(others, i), &der)) > 0 &&
            js_array_append(ctx, parts[2], js_new_buffer_from_bytes(ctx, der, (size_t)len)) < 0) {
            OPENSSL_free(der);
            parts[2] = JS_EXCEPTION;
            break;
        }
        OPENSSL_free(der);
    }
    EVP_PKEY_free(pkey);
    X509_free(cert);
    sk_X509_pop_free(others, X509_free);
    ERR_clear_error();
    return js_is_exception(parts[2]) ? JS_EXCEPTION : js_new_array_from(ctx, parts, 3);
}

/* ---- Certificates (crypto.X509Certificate's checks, as OpenSSL's) ---------------------------------- */

/* x509Check(der, kind, value, flags) → the name matched (kind 0: a host, 1: an email address,
 * 2: an IP address) or undefined; flags are X509_CHECK_FLAG_*'s */
PRIMITIVE(js_x509_check) {
    UNUSED_ARGS;
    X509 *x = x509_arg(ARG(0));
    char *value = string_dup(ctx, ARG(2));
    if (!x || !value || !js_is_number(ARG(1))) {
        X509_free(x);
        free(value);
        ERR_clear_error();
        return js_throw_type_error(ctx, "x509Check: a certificate, a kind and a value expected");
    }
    unsigned flags = js_is_number(ARG(3)) ? (unsigned)js_as_number(ARG(3)) : 0;
    size_t n = strlen(value);
    char *peer = NULL;
    int r;
    switch ((int)js_as_number(ARG(1))) {
        case 0: r = X509_check_host(x, value, n, flags, &peer); break;
        case 1: r = X509_check_email(x, value, n, flags); break;
        default: r = X509_check_ip_asc(x, value, flags); break;
    }
    JSValue out = JS_UNDEFINED;
    if (r == 1) out = js_new_string_utf8(ctx, peer ? peer : value, strlen(peer ? peer : value));
    OPENSSL_free(peer);
    free(value);
    X509_free(x);
    ERR_clear_error();
    return out;
}

/* x509CheckIssued(der, issuerDer) → whether the issuer's name, key identifier and key usage fit (X509_check_issued) */
PRIMITIVE(js_x509_check_issued) {
    UNUSED_ARGS;
    X509 *x = x509_arg(ARG(0)), *issuer = x509_arg(ARG(1));
    bool ok = x && issuer && X509_check_issued(issuer, x) == X509_V_OK;
    X509_free(x);
    X509_free(issuer);
    ERR_clear_error();
    return js_bool(ok);
}

/* x509CheckKey(der, key handle) → for a public key, whether it signed the certificate; for a
 * private one, whether it is the certificate's */
PRIMITIVE(js_x509_check_key) {
    UNUSED_ARGS;
    X509 *x = x509_arg(ARG(0));
    JSKeyData *k = js_key_data(ARG(1));
    EVP_PKEY *pkey = k ? pkey_of(k) : NULL;
    bool ok = x && pkey && (k->type == JS_KEY_PRIVATE ? X509_check_private_key(x, pkey) : X509_verify(x, pkey)) == 1;
    EVP_PKEY_free(pkey);
    X509_free(x);
    ERR_clear_error();
    return js_bool(ok);
}

/* ---- Connections -------------------------------------------------------------------------------- */

typedef struct TlsConnData {
    SSL         *ssl;
    BIO         *in, *out;          /* records from the peer; records to send */
    bool         server;
    bool         established;
    uint32_t     handshakes;
    bool         in_handshake;
    SSL_SESSION *new_session;       /* the last session (or ticket) the peer gave: tlsRun reports it once */
    SSL_SESSION *offered_session;   /* a client's, to resume */
    bool         session_reported;
    uint8_t     *alpn;              /* a server's protocols, in the wire format */
    size_t       alpn_len;
    bool         alpn_strict;
    bool         keylog_on;
    JSBytesOut   keylog;            /* NSS key log lines since tlsRun last reported them */
} TlsConnData;

typedef struct TlsConnObject {
    JSObject     obj;
    JSValue      context;  /* the SecureContext the SSL was made from */
    TlsConnData *d;
} TlsConnObject;

static int on_new_session(SSL *ssl, SSL_SESSION *session) {
    TlsConnData *d = SSL_get_app_data(ssl);
    if (!d || d->server) return 0;
    SSL_SESSION_free(d->new_session);
    d->new_session = session;  /* kept: returning 1 takes the reference */
    d->session_reported = false;
    return 1;
}

/* A server's ALPN: its own preference first, as Node's SelectALPNCallback chooses; no protocol in
 * common is a fatal alert (Node's behavior), unless the server has none to offer */
static int on_alpn_select(SSL *ssl, const uint8_t **out, uint8_t *out_len, const uint8_t *in, unsigned in_len, void *arg) {
    (void)arg;
    TlsConnData *d = SSL_get_app_data(ssl);
    if (!d || !d->alpn) return SSL_TLSEXT_ERR_NOACK;
    uint8_t *selected;
    if (SSL_select_next_proto(&selected, out_len, d->alpn, (unsigned)d->alpn_len, in, in_len) == OPENSSL_NPN_NEGOTIATED) {
        *out = selected;
        return SSL_TLSEXT_ERR_OK;
    }
    return d->alpn_strict ? SSL_TLSEXT_ERR_ALERT_FATAL : SSL_TLSEXT_ERR_NOACK;
}

static void conn_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((TlsConnObject *)c)->context);
}

static void conn_finalize(JSRuntime *rt, JSCell *cell) {
    (void)rt;
    TlsConnData *d = ((TlsConnObject *)cell)->d;
    if (!d) return;
    SSL_free(d->ssl);  /* and its BIOs */
    SSL_SESSION_free(d->new_session);
    SSL_SESSION_free(d->offered_session);
    free(d->alpn);
    free(d->keylog.p);
    free(d);
}

static const JSClass conn_class = { "TLSWrap", sizeof(TlsConnObject), NULL, NULL, NULL, NULL, conn_visit, conn_finalize, NULL };

static TlsConnData *conn_arg(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &conn_class ? ((TlsConnObject *)js_as_object(v))->d : NULL;
}

/* ALPN names (strings) in the wire format: length-prefixed */
static uint8_t *alpn_wire(JSContext *ctx, JSValue names, size_t *len) {
    *len = 0;
    if (!js_is_array(names)) return NULL;
    uint32_t n = js_array_length(js_as_object(names));
    JSBytesOut o = { 0 };
    for (uint32_t i = 0; i < n; i++) {
        char *s = string_dup(ctx, js_get_value(ctx, names, js_index_key(i)));
        if (!s) continue;
        size_t l = strlen(s);
        if (l > 0 && l < 256) {
            uint8_t b = (uint8_t)l;
            out_append(&o, &b, 1);
            out_append(&o, s, l);
        }
        free(s);
    }
    *len = o.n;
    return o.p;
}

/* tlsNew(context, server, servername | null, alpn [names] | null, session | null, requestCert,
 * alpnStrict) → connection | an error. requestCert (a server's): 0 none, 1 asked for, 2 required
 * (no certificate fails the handshake, as OpenSSL's SSL_VERIFY_FAIL_IF_NO_PEER_CERT does). */
PRIMITIVE(js_tls_new) {
    UNUSED_ARGS;
    TlsContextObject *cx = context_arg(ARG(0));
    if (!cx) return js_throw_type_error(ctx, "tlsNew: a context expected");
    TlsConnData *d = calloc(1, sizeof *d);
    if (!d) js_fatal("out of memory in tls");
    d->server = js_truthy(ARG(1));
    d->ssl = SSL_new(cx->ctx);
    if (!d->ssl) {
        free(d);
        return error_info(ctx);
    }
    d->in = BIO_new(BIO_s_mem());
    d->out = BIO_new(BIO_s_mem());
    BIO_set_mem_eof_return(d->in, -1);  /* no more records yet, not the end */
    SSL_set_bio(d->ssl, d->in, d->out);
    SSL_set_app_data(d->ssl, d);
    if (d->server) {
        SSL_set_accept_state(d->ssl);
        int request = js_is_number(ARG(5)) ? (int)js_as_number(ARG(5)) : 0;
        if (request) SSL_set_verify(d->ssl, SSL_VERIFY_PEER | (request == 2 ? SSL_VERIFY_FAIL_IF_NO_PEER_CERT : 0), verify_accept);
        d->alpn = alpn_wire(ctx, ARG(3), &d->alpn_len);
        d->alpn_strict = js_truthy(ARG(6));
    } else {
        SSL_set_connect_state(d->ssl);
        SSL_set_verify(d->ssl, SSL_VERIFY_PEER, verify_accept);
        SSL_set_renegotiate_mode(d->ssl, ssl_renegotiate_freely);
        char *name = string_dup(ctx, ARG(2));
        if (name && *name) SSL_set_tlsext_host_name(d->ssl, name);
        free(name);
        size_t len;
        uint8_t *wire = alpn_wire(ctx, ARG(3), &len);
        if (wire) SSL_set_alpn_protos(d->ssl, wire, len);
        free(wire);
        const uint8_t *sp;
        size_t spn;
        if (bytes_arg(ARG(4), &sp, &spn)) {
            SSL_SESSION *s = SSL_SESSION_from_bytes(sp, spn, cx->ctx);
            if (s) SSL_set_session(d->ssl, s);
            d->offered_session = s;  /* the reference from_bytes gave */
        }
    }
    ERR_clear_error();
    TlsConnObject *o = (TlsConnObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &conn_class, JS_NULL, 0));
    js_init_slot(&o->context, ARG(0));
    o->d = d;
    return js_object_value(&o->obj);
}

enum { TLS_ESTABLISHED = 1, TLS_FAILED = 2, TLS_PEER_CLOSED = 4, TLS_NEW_SESSION = 8 };

static bool fatal(int e) {
    return e != SSL_ERROR_WANT_READ && e != SSL_ERROR_WANT_WRITE && e != SSL_ERROR_WANT_RENEGOTIATE;
}

/* tlsRun(connection, records | null, data | null) → [records out | null, data received | null,
 * bytes of `data` taken, state (1 established, 2 failed, 4 the peer's close_notify, 8 a new
 * session to report), error ([library, reason, name] | 0), handshakes finished, key log lines |
 * null]: feeds the
 * engine what it was given and runs it until it can't go on. `data` is taken once the handshake
 * is done (and not during a renegotiation); what isn't is given again later. */
PRIMITIVE(js_tls_run) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d) return js_throw_type_error(ctx, "tlsRun: a connection expected");
    const uint8_t *in = NULL, *plain = NULL;
    size_t in_n = 0, plain_n = 0, taken = 0;
    if (!js_is_null(ARG(1)) && !js_is_undefined(ARG(1)) && !bytes_arg(ARG(1), &in, &in_n))
        return js_throw_type_error(ctx, "tlsRun: bytes expected");
    if (!js_is_null(ARG(2)) && !js_is_undefined(ARG(2)) && !bytes_arg(ARG(2), &plain, &plain_n))
        return js_throw_type_error(ctx, "tlsRun: bytes expected");
    if (in_n) BIO_write(d->in, in, (int)in_n);
    JSBytesOut app = { 0 };
    int state = 0;
    JSValue err = js_int32(0);
    ERR_clear_error();
    for (;;) {
        if (SSL_in_init(d->ssl)) {
            d->in_handshake = true;
            int r = SSL_do_handshake(d->ssl);
            if (r <= 0) {
                if (fatal(SSL_get_error(d->ssl, r))) {
                    state |= TLS_FAILED;
                    err = error_info(ctx);
                }
                break;
            }
        }
        if (d->in_handshake) {
            d->in_handshake = false;
            d->established = true;
            d->handshakes++;
        }
        /* data received (this also takes post-handshake messages: tickets, a HelloRequest) */
        uint8_t buf[16384];
        bool renegotiating = false;
        for (;;) {
            int r = SSL_read(d->ssl, buf, sizeof buf);
            if (r > 0) {
                out_append(&app, buf, (size_t)r);
                continue;
            }
            int e = SSL_get_error(d->ssl, r);
            if (e == SSL_ERROR_ZERO_RETURN) {
                state |= TLS_PEER_CLOSED;
            } else if (fatal(e)) {
                state |= TLS_FAILED;
                err = error_info(ctx);
            }
            renegotiating = SSL_in_init(d->ssl);
            break;
        }
        if (state & TLS_FAILED) break;
        if (renegotiating) {
            d->in_handshake = true;
            continue;
        }
        while (plain_n > taken) {
            size_t n = plain_n - taken;
            int r = SSL_write(d->ssl, plain + taken, n > 0x40000000 ? 0x40000000 : (int)n);
            if (r <= 0) {
                if (fatal(SSL_get_error(d->ssl, r))) {
                    state |= TLS_FAILED;
                    err = error_info(ctx);
                }
                break;
            }
            taken += (size_t)r;
        }
        break;
    }
    if (d->established) state |= TLS_ESTABLISHED;
    if (d->new_session && !d->session_reported) {
        d->session_reported = true;
        state |= TLS_NEW_SESSION;
    }
    JSValue keylog = bytes_or_null(ctx, &d->keylog);
    d->keylog = (JSBytesOut){ 0 };
    JSBytesOut out = { 0 };
    const uint8_t *p;
    size_t n;
    if (BIO_mem_contents(d->out, &p, &n) && n) out_append(&out, p, n);
    BIO_reset(d->out);
    ERR_clear_error();
    JSValue items[7] = { JS_NULL, JS_NULL, js_number((double)taken), js_int32(state), err, js_number(d->handshakes), keylog };
    items[0] = bytes_or_null(ctx, &out);
    items[1] = bytes_or_null(ctx, &app);
    return js_new_array_from(ctx, items, 7);
}

/* tlsShutdown(connection) → the records to send | null: our close_notify; reading goes on until
 * the peer's (TLS's half-close, as OpenSSL's SSL_shutdown has it) */
PRIMITIVE(js_tls_shutdown) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d) return js_throw_type_error(ctx, "tlsShutdown: a connection expected");
    if (!SSL_in_init(d->ssl)) SSL_shutdown(d->ssl);
    ERR_clear_error();
    JSBytesOut out = { 0 };
    const uint8_t *p;
    size_t n;
    if (BIO_mem_contents(d->out, &p, &n) && n) out_append(&out, p, n);
    BIO_reset(d->out);
    return bytes_or_null(ctx, &out);
}

/* tlsInfo(connection) → [version, cipher [name, standard name, min version] | null, ALPN
 * protocol | false, server name | null, resumed, group name | null] */
PRIMITIVE(js_tls_info) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d) return js_throw_type_error(ctx, "tlsInfo: a connection expected");
    const SSL_CIPHER *c = SSL_get_current_cipher(d->ssl);
    JSValue cipher = JS_NULL;
    if (c) {
        uint16_t v = SSL_CIPHER_get_min_version(c);
        JSValue parts[3] = { js_new_string_cstr(ctx, SSL_CIPHER_get_name(c)), js_new_string_cstr(ctx, SSL_CIPHER_standard_name(c)),
                             js_new_string_cstr(ctx, v >= TLS1_3_VERSION ? "TLSv1.3" : v >= TLS1_2_VERSION ? "TLSv1.2" : "TLSv1.0") };
        cipher = js_new_array_from(ctx, parts, 3);
    }
    const uint8_t *alpn;
    unsigned alpn_len;
    SSL_get0_alpn_selected(d->ssl, &alpn, &alpn_len);
    const char *name = SSL_get_servername(d->ssl, TLSEXT_NAMETYPE_host_name);
    uint16_t group = SSL_get_group_id(d->ssl);
    const char *group_name = group ? SSL_get_group_name(group) : NULL;
    JSValue items[6] = {
        js_int32(SSL_version(d->ssl)), cipher,
        alpn_len ? js_new_string_utf8(ctx, (const char *)alpn, alpn_len) : JS_FALSE,
        name ? js_new_string_cstr(ctx, name) : JS_NULL,
        js_bool(SSL_session_reused(d->ssl)),
        group_name ? js_new_string_cstr(ctx, group_name) : JS_NULL,
    };
    return js_new_array_from(ctx, items, 6);
}

/* tlsPeerCerts(connection) → [der, …]: the chain the peer sent (a resumed session's too) */
PRIMITIVE(js_tls_peer_certs) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d) return js_throw_type_error(ctx, "tlsPeerCerts: a connection expected");
    const STACK_OF(CRYPTO_BUFFER) *certs = SSL_get0_peer_certificates(d->ssl);
    size_t n = certs ? sk_CRYPTO_BUFFER_num(certs) : 0;
    JSValue a = js_new_array(ctx, (uint32_t)n);
    for (size_t i = 0; i < n; i++) {
        const CRYPTO_BUFFER *b = sk_CRYPTO_BUFFER_value(certs, i);
        JSValue v = js_new_buffer_from_bytes(ctx, CRYPTO_BUFFER_data(b), CRYPTO_BUFFER_len(b));
        if (js_is_exception(v) || js_array_append(ctx, a, v) < 0) return JS_EXCEPTION;
    }
    return a;
}

/* tlsVerifyError(connection) → 0 | X509_V_ERR_* | -1 (no certificate received) */
PRIMITIVE(js_tls_verify_error) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d) return js_throw_type_error(ctx, "tlsVerifyError: a connection expected");
    const STACK_OF(CRYPTO_BUFFER) *certs = SSL_get0_peer_certificates(d->ssl);
    if (!certs || sk_CRYPTO_BUFFER_num(certs) == 0) return js_int32(-1);
    return js_int32((int32_t)SSL_get_verify_result(d->ssl));
}

/* tlsSession(connection) → the session to resume with (tlsNew's `session`): the last one the
 * peer gave (a TLS 1.3 ticket), else the connection's | undefined */
PRIMITIVE(js_tls_session) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d || !d->established) return JS_UNDEFINED;
    /* OpenSSL's, which Node returns: a TLS 1.3 session before its tickets too (it won't resume) */
    SSL_SESSION *s = d->new_session ? d->new_session : SSL_get_session(d->ssl);
    if (!s) return JS_UNDEFINED;
    uint8_t *p;
    size_t n;
    if (!SSL_SESSION_to_bytes(s, &p, &n)) {
        ERR_clear_error();
        return JS_UNDEFINED;
    }
    JSValue v = js_new_buffer_from_bytes(ctx, p, n);
    OPENSSL_free(p);
    return v;
}

/* tlsTicket(connection) → Buffer | undefined: the session ticket a client was given */
PRIMITIVE(js_tls_ticket) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d) return JS_UNDEFINED;
    /* resumed, a TLS 1.3 session is a copy without the ticket: the one offered had it */
    SSL_SESSION *s = d->new_session ? d->new_session
                   : SSL_session_reused(d->ssl) && d->offered_session ? d->offered_session : SSL_get_session(d->ssl);
    const uint8_t *p;
    size_t n;
    if (!s || !SSL_SESSION_has_ticket(s)) return JS_UNDEFINED;
    SSL_SESSION_get0_ticket(s, &p, &n);
    return js_new_buffer_from_bytes(ctx, p, n);
}

/* tlsExportKeyingMaterial(connection, length, label, context | undefined) → Buffer | null (RFC 5705) */
PRIMITIVE(js_tls_export_keying_material) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d || !js_is_number(ARG(1))) return js_throw_type_error(ctx, "tlsExportKeyingMaterial: bad arguments");
    size_t n = (size_t)js_as_number(ARG(1));
    char *label = string_dup(ctx, ARG(2));
    const uint8_t *cp = NULL;
    size_t cn = 0;
    bool has_context = bytes_arg(ARG(3), &cp, &cn);
    uint8_t *out = malloc(n ? n : 1);
    if (!out) js_fatal("out of memory in tls");
    int ok = SSL_export_keying_material(d->ssl, out, n, label ? label : "", label ? strlen(label) : 0, cp, cn, has_context);
    free(label);
    ERR_clear_error();
    JSValue r = ok ? js_new_buffer_from_bytes(ctx, out, n) : JS_NULL;
    free(out);
    return r;
}

/* tlsFinished(connection, peer) → the last Finished message's verify_data sent (or with `peer`
 * received) | undefined (TLS 1.3 has none to give) */
PRIMITIVE(js_tls_finished) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d || !d->established) return JS_UNDEFINED;
    uint8_t buf[64];
    size_t n = js_truthy(ARG(1)) ? SSL_get_peer_finished(d->ssl, buf, sizeof buf) : SSL_get_finished(d->ssl, buf, sizeof buf);
    return n ? js_new_buffer_from_bytes(ctx, buf, n < sizeof buf ? n : sizeof buf) : JS_UNDEFINED;
}

/* tlsCiphers() → [name, …]: the cipher suites BoringSSL has, OpenSSL's names (tls.getCiphers) */
PRIMITIVE(js_tls_ciphers) {
    UNUSED_ARGS;
    SSL_CTX *c = SSL_CTX_new(TLS_method());
    SSL_CTX_set_cipher_list(c, "ALL");
    STACK_OF(SSL_CIPHER) *list = SSL_CTX_get_ciphers(c);
    size_t n = sk_SSL_CIPHER_num(list);
    JSValue a = js_new_array(ctx, (uint32_t)n);
    for (size_t i = 0; i < n; i++) {
        JSValue s = js_new_string_cstr(ctx, SSL_CIPHER_get_name(sk_SSL_CIPHER_value(list, i)));
        if (js_is_exception(s) || js_array_append(ctx, a, s) < 0) {
            SSL_CTX_free(c);
            return JS_EXCEPTION;
        }
    }
    SSL_CTX_free(c);
    return a;
}

/* tlsSetNoRenegotiation(connection): a server's requests to renegotiate are refused (BoringSSL
 * renegotiates only as a client, when a server asks; it never starts one) */
static void on_keylog(const SSL *ssl, const char *line) {
    TlsConnData *d = SSL_get_app_data(ssl);
    if (!d || !d->keylog_on) return;
    out_append(&d->keylog, line, strlen(line));
    out_append(&d->keylog, "\n", 1);
}

/* tlsEnableKeylog(connection): its key log lines come with tlsRun's results (the 'keylog' event) */
PRIMITIVE(js_tls_enable_keylog) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (!d) return JS_UNDEFINED;
    d->keylog_on = true;
    /* the context's: BoringSSL forms the lines only for a context that has a callback */
    SSL_CTX_set_keylog_callback(SSL_get_SSL_CTX(d->ssl), on_keylog);
    return JS_UNDEFINED;
}

PRIMITIVE(js_tls_set_no_renegotiation) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (d && !d->server) SSL_set_renegotiate_mode(d->ssl, ssl_renegotiate_never);
    return JS_UNDEFINED;
}

/* tlsSetMaxSendFragment(connection, size): the largest record's plaintext (512 to 16384) */
PRIMITIVE(js_tls_set_max_send_fragment) {
    UNUSED_ARGS;
    TlsConnData *d = conn_arg(ARG(0));
    if (d && js_is_number(ARG(1))) SSL_set_max_send_fragment(d->ssl, (size_t)js_as_number(ARG(1)));
    return JS_UNDEFINED;
}
