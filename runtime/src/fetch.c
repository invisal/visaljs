/* Request and Response (Fetch §5.4, §5.5), the fetch component, as Node's
 * (undici's): their headers (the headers component), their bodies (the Body mixin, §5.3) and
 * Node's errors and inspection. A body made from bytes (a string, a buffer source, a Blob,
 * URLSearchParams) keeps them: text(), json(), arrayBuffer(), bytes() and blob() read them
 * directly, and `body` makes a ReadableStream of them only when asked. A ReadableStream body is
 * read through the streams component. fetch() itself is node:http's client\n * (node/prelude/internal/fetch.js), through the js_host_fetch_* primitives at the end. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
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

/* A failure's -1, after the call that threw (the throwers' results must be used). */
static int fail(JSValue thrown) {
    (void)thrown;
    return -1;
}

/* undici's TypeError for a URL that doesn't parse: "Failed to parse URL from …", its cause
 * new URL's error (ERR_INVALID_URL). */
static JSValue throw_unparsable(JSContext *ctx, JSValue input) {
    JSValue cause = js_new_error(ctx, JS_TYPE_ERROR, js_new_string_cstr(ctx, "Invalid URL"));
    js_define_data(ctx, js_as_object(cause), js_atom_from_cstr(ctx, "code"), js_new_string_cstr(ctx, "ERR_INVALID_URL"), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(cause), js_atom_from_cstr(ctx, "input"), input, JS_PROP_DEFAULT);
    JSValue message = js_concat(ctx, js_new_string_cstr(ctx, "Failed to parse URL from "), input);
    if (js_is_exception(message)) return message;
    JSValue e = js_new_error(ctx, JS_TYPE_ERROR, message);
    js_define_data(ctx, js_as_object(e), JS_ATOM(cause), cause, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return js_throw(ctx, e);
}

/* Whether a serialized URL has a username or password: an '@' in its authority. */
static bool has_credentials(JSContext *ctx, JSValue href) {
    JSStrView v = js_string_view(ctx, href);
    uint32_t i = 0;
    while (i < v.length && js_view_at(v, i) != ':') i++;
    if (i + 2 >= v.length || js_view_at(v, i + 1) != '/' || js_view_at(v, i + 2) != '/') return false;
    for (i += 3; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c == '@') return true;
        if (c == '/' || c == '?' || c == '#') return false;
    }
    return false;
}

/* ---- Bodies (§5.3) -------------------------------------------------------------------------- */

typedef struct Body {
    JSValue bytes;    /* a Uint8Array of the body's bytes, or undefined (none, or a stream body) */
    JSValue stream;   /* the ReadableStream, once made (or given); undefined until then */
    uint8_t has_body;
    uint8_t used;     /* consumed directly from `bytes` */
} Body;

typedef struct RequestObject {
    JSObject obj;
    Body     body;
    JSValue  method, url, headers, signal;
    uint8_t  redirect;  /* 0 follow, 1 error, 2 manual */
    uint8_t  keepalive;
} RequestObject;

typedef struct ResponseObject {
    JSObject obj;
    Body     body;
    JSValue  status_text, headers, url;
    uint16_t status;
    uint8_t  type;      /* 0 default, 1 error, 2 basic… */
    uint8_t  redirected;
} ResponseObject;

static void body_visit(Body *b, JSTracer *trc) {
    js_trace_value(trc, b->bytes);
    js_trace_value(trc, b->stream);
}
static void request_visit(JSCell *c, JSTracer *trc) {
    RequestObject *r = (RequestObject *)c;
    body_visit(&r->body, trc);
    js_trace_value(trc, r->method);
    js_trace_value(trc, r->url);
    js_trace_value(trc, r->headers);
    js_trace_value(trc, r->signal);
}
static void response_visit(JSCell *c, JSTracer *trc) {
    ResponseObject *r = (ResponseObject *)c;
    body_visit(&r->body, trc);
    js_trace_value(trc, r->status_text);
    js_trace_value(trc, r->headers);
    js_trace_value(trc, r->url);
}

static const JSClass request_class = { "Request", sizeof(RequestObject), NULL, NULL, NULL, NULL, request_visit, NULL, NULL };
static const JSClass response_class = { "Response", sizeof(ResponseObject), NULL, NULL, NULL, NULL, response_visit, NULL, NULL };

static RequestObject *as_request(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &request_class ? (RequestObject *)js_as_object(v) : NULL;
}
static ResponseObject *as_response(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &response_class ? (ResponseObject *)js_as_object(v) : NULL;
}

static void init_body(Body *b) {
    b->bytes = JS_UNDEFINED;
    b->stream = JS_UNDEFINED;
    b->has_body = 0;
    b->used = 0;
}

static JSValue u8_of(JSContext *ctx, const uint8_t *p, size_t n) {
    JSValue u8 = js_new_uint8_array(ctx, n);
    if (js_is_exception(u8) || !n) return u8;
    uint8_t *data;
    size_t len;
    js_buffer_source_bytes(u8, &data, &len);
    memcpy(data, p, n);
    return u8;
}

static bool class_named(JSValue v, const char *name) {
    return js_is_object(v) && strcmp(js_as_object(v)->shape->cls->name, name) == 0;
}

/* FormData (node/prelude/internal/form_data.js, linked into programs that name it) registers
 * its body's serializer and formData()'s parser here (fetchFormDataHooks); until then a FormData
 * is an ordinary object to a body, and formData() rejects. */
static JSValue form_data_serialize, form_data_parse;  /* EMPTY (zero) until set: not callable */

/* Extract a body (§5.3 "extract"): its bytes or stream, and the Content-Type it implies (EMPTY
 * for none). 0, or -1. */
static int extract(JSContext *ctx, JSCell *owner, Body *b, JSValue init, JSValue *content_type) {
    *content_type = JS_EMPTY;
    b->has_body = 1;
    uint8_t *p;
    size_t n;
    if (js_is_readable_stream(init)) {
        if (js_readable_stream_locked(init) || js_readable_stream_disturbed(init))
            return fail(js_throw_type_error(ctx, "Response body object should not be disturbed or locked"));
        js_store(ctx, owner, &b->stream, init);
        return 0;
    }
    JSValue bytes;
    if (js_is_blob(init)) {
        const uint8_t *data;
        size_t size;
        JSValue type;
        js_blob_bytes(init, &data, &size, &type);
        bytes = u8_of(ctx, data, size);
        if (js_string_length(type)) *content_type = type;
    } else if (js_buffer_source_bytes(init, &p, &n)) {
        bytes = u8_of(ctx, p, n);
    } else {
        if (js_is_object(init) && js_is_callable(form_data_serialize)) {
            /* a FormData: [the multipart body as a Blob, its Content-Type], else undefined */
            JSValue parts = js_call(ctx, form_data_serialize, JS_UNDEFINED, 1, &init);
            if (js_is_exception(parts)) return -1;
            if (js_is_array(parts)) {
                JSValue blob = js_get_index(ctx, parts, js_int32(0)), type = js_get_index(ctx, parts, js_int32(1));
                if (js_is_exception(blob) || js_is_exception(type)) return -1;
                if (js_is_blob(blob)) {
                    const uint8_t *data;
                    size_t size;
                    JSValue blob_type;
                    js_blob_bytes(blob, &data, &size, &blob_type);
                    bytes = u8_of(ctx, data, size);
                    if (js_is_exception(bytes)) return -1;
                    js_store(ctx, owner, &b->bytes, bytes);
                    *content_type = type;
                    return 0;
                }
            }
        }
        bool params = class_named(init, "URLSearchParams");
        JSValue s = js_to_string(ctx, init);
        if (js_is_exception(s)) return -1;
        JSStrView v = js_string_view(ctx, s);
        size_t len = js_view_to_utf8(v, NULL, 0);
        bytes = js_new_uint8_array(ctx, len);
        if (js_is_exception(bytes)) return -1;
        js_buffer_source_bytes(bytes, &p, &n);
        js_view_to_utf8(v, (char *)p, len);
        *content_type = js_new_string_cstr(ctx, params ? "application/x-www-form-urlencoded;charset=UTF-8" : "text/plain;charset=UTF-8");
    }
    if (js_is_exception(bytes)) return -1;
    js_store(ctx, owner, &b->bytes, bytes);
    return 0;
}

static bool body_used(const Body *b) {
    return b->used || (!js_is_undefined(b->stream) && js_readable_stream_disturbed(b->stream));
}

/* The body's stream (null for none): made from the bytes the first time it is asked for. */
static JSValue body_stream(JSContext *ctx, JSCell *owner, Body *b) {
    if (!b->has_body) return JS_NULL;
    if (js_is_undefined(b->stream)) {
        JSValue s = js_readable_stream_of_bytes(ctx, b->used ? JS_UNDEFINED : b->bytes);
        if (js_is_exception(s)) return s;
        js_store(ctx, owner, &b->stream, s);
        js_store(ctx, owner, &b->bytes, JS_UNDEFINED);
    }
    return b->stream;
}

static JSValue rejected(JSContext *ctx, JSValue reason) {
    JSValue p = js_new_promise(ctx);
    js_promise_reject_internal(ctx, p, reason);
    return p;
}

static JSValue settled(JSContext *ctx, JSValue v) {
    JSValue p = js_new_promise(ctx);
    if (js_is_exception(v)) js_promise_reject_internal(ctx, p, js_take_exception(ctx));
    else js_promise_resolve_internal(ctx, p, v);
    return p;
}

enum { AS_TEXT, AS_JSON, AS_ARRAY_BUFFER, AS_BYTES, AS_BLOB };

/* The body's bytes (a Uint8Array) as what a consumer asked for. */
static JSValue package(JSContext *ctx, JSValue bytes, int kind, JSValue mime) {
    uint8_t *p;
    size_t n;
    js_buffer_source_bytes(bytes, &p, &n);
    switch (kind) {
    case AS_TEXT: return js_decode_utf8_bytes(ctx, p, n);
    case AS_JSON: {
        JSValue s = js_decode_utf8_bytes(ctx, p, n);
        return js_is_exception(s) ? s : js_json_parse(ctx, s);
    }
    case AS_ARRAY_BUFFER: {
        JSValue ab = js_new_array_buffer(ctx, n);
        if (!js_is_exception(ab) && n) memcpy(js_as_array_buffer(ab)->data, p, n);
        return ab;
    }
    case AS_BYTES: return bytes;
    default: return js_new_blob(ctx, p, n, js_is_string(mime) ? mime : js_empty_string());
    }
}

/* A stream body's consumption: the closure's data is [kind, mime]. */
BUILTIN(consume_read) {
    (void)this_val, (void)new_target;
    JSValue data = js_closure_data(callee);
    JSValue kind = js_get_elem(ctx, data, js_int32(0)), mime = js_get_elem(ctx, data, js_int32(1));
    return package(ctx, ARG(0), (int)js_as_number(kind), mime);
}

static JSValue unusable(JSContext *ctx) {
    return js_new_error(ctx, JS_TYPE_ERROR, js_new_string_cstr(ctx, "Body is unusable: Body has already been read"));
}

/* Consume body (§5.3): a promise of the bytes as `kind`. */
static JSValue consume(JSContext *ctx, JSCell *owner, Body *b, JSValue headers, int kind) {
    if (body_used(b) || (!js_is_undefined(b->stream) && js_readable_stream_locked(b->stream))) return rejected(ctx, unusable(ctx));
    JSValue mime = JS_UNDEFINED;
    if (kind == AS_BLOB) {
        mime = js_headers_get(ctx, headers, "content-type");
        if (js_is_exception(mime)) return rejected(ctx, js_take_exception(ctx));
    }
    if (!b->has_body) return settled(ctx, package(ctx, js_new_uint8_array(ctx, 0), kind, mime));
    if (js_is_undefined(b->stream)) {
        b->used = 1;
        JSValue bytes = b->bytes;
        js_store(ctx, owner, &b->bytes, JS_UNDEFINED);
        return settled(ctx, package(ctx, bytes, kind, mime));
    }
    JSValue all = js_readable_stream_read_all(ctx, b->stream);
    JSValue items[2] = { js_int32(kind), mime };
    JSValue derived = js_new_promise(ctx);
    js_promise_then_internal(ctx, all, js_new_closure_native(ctx, consume_read, 1, js_new_array_from(ctx, items, 2)), JS_UNDEFINED, derived);
    return derived;
}

/* Clone a body (§5.3): bytes are shared (they never change), a stream is teed. 0, or -1. */
static int clone_body(JSContext *ctx, JSCell *from_owner, Body *from, JSCell *to_owner, Body *to) {
    to->has_body = from->has_body;
    if (!from->has_body) return 0;
    if (js_is_undefined(from->stream)) {
        js_store(ctx, to_owner, &to->bytes, from->bytes);
        return 0;
    }
    JSValue pair = js_readable_stream_tee(ctx, from->stream);
    if (js_is_exception(pair)) return -1;
    js_store(ctx, from_owner, &from->stream, js_get_elem(ctx, pair, js_int32(0)));
    js_store(ctx, to_owner, &to->stream, js_get_elem(ctx, pair, js_int32(1)));
    return 0;
}

/* ---- Request (§5.4) ------------------------------------------------------------------------- */

static bool token_char(uint32_t c) {
    if ((c | 32) >= 'a' && (c | 32) <= 'z') return true;
    if (c >= '0' && c <= '9') return true;
    return c < 0x80 && c && strchr("!#$%&'*+-.^_`|~", (int)c);
}

/* A method as Fetch normalizes it: DELETE, GET, HEAD, OPTIONS, POST and PUT uppercased. */
static JSValue normalize_method(JSContext *ctx, JSValue m) {
    char s[64];
    JSStrView v = js_string_view(ctx, m);
    char msg[160];
    bool ok = v.length > 0;
    for (uint32_t i = 0; i < v.length && ok; i++) ok = token_char(js_view_at(v, i));
    s[js_view_to_utf8(v, s, sizeof s - 1)] = '\0';
    if (!ok) {
        snprintf(msg, sizeof msg, "'%s' is not a valid HTTP method.", s);
        return js_throw_type_error(ctx, "%s", msg);
    }
    char upper[64];
    size_t n = strlen(s);
    for (size_t i = 0; i <= n; i++) upper[i] = (char)(s[i] >= 'a' && s[i] <= 'z' ? s[i] - 32 : s[i]);
    if (!strcmp(upper, "CONNECT") || !strcmp(upper, "TRACE") || !strcmp(upper, "TRACK"))
        return js_throw_type_error(ctx, "'%s' HTTP method is unsupported.", s);
    static const char *const normal[] = { "DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT" };
    for (size_t i = 0; i < JS_COUNTOF(normal); i++)
        if (!strcmp(upper, normal[i])) return js_new_string_cstr(ctx, normal[i]);
    return m;
}

static bool method_is(JSContext *ctx, JSValue m, const char *name) {
    char s[16];
    JSStrView v = js_string_view(ctx, m);
    if (v.length >= sizeof s) return false;
    s[js_view_to_utf8(v, s, sizeof s - 1)] = '\0';
    return strcmp(s, name) == 0;
}

static JSValue get_option(JSContext *ctx, JSValue init, const char *name) {
    return js_is_object(init) ? js_get_value(ctx, init, js_atom_from_cstr(ctx, name)) : JS_UNDEFINED;
}

/* new Request(input, init) */
BUILTIN(request_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "_Request");
    if (argc < 1) return js_throw_type_error(ctx, "Request constructor: 1 argument required, but 0 found.");
    JSValue input = argv[0], init = ARG(1);
    if (!js_is_nullish(init) && !js_is_object(init))
        return js_throw_type_error(ctx, "Request constructor: Expected init (\"Argument 2\") to be an instance of RequestInit.");
    RequestObject *src = as_request(input);
    JSValue url, method = js_new_string_cstr(ctx, "GET"), headers_init = JS_UNDEFINED, signal = JS_UNDEFINED;
    if (src) {
        url = src->url;
        method = src->method;
        headers_init = src->headers;
        signal = src->signal;
    } else {
        JSValue s = js_to_string(ctx, input);
        if (js_is_exception(s)) return s;
        JSValue u = js_parse_url_href(ctx, s);
        if (js_is_exception(u)) return u;
        if (js_is_undefined(u)) return throw_unparsable(ctx, s);
        if (has_credentials(ctx, u)) {
            JSValue message = js_concat(ctx, js_new_string_cstr(ctx, "Request cannot be constructed from a URL that includes credentials: "), u);
            if (js_is_exception(message)) return message;
            return js_throw(ctx, js_new_error(ctx, JS_TYPE_ERROR, message));
        }
        url = u;
    }
    JSValue m = get_option(ctx, init, "method");
    if (js_is_exception(m)) return m;
    if (!js_is_undefined(m)) {
        JSValue ms = js_to_string(ctx, m);
        if (js_is_exception(ms)) return ms;
        method = normalize_method(ctx, ms);
        if (js_is_exception(method)) return method;
    }
    JSValue h = get_option(ctx, init, "headers");
    if (js_is_exception(h)) return h;
    if (!js_is_undefined(h)) headers_init = h;
    JSValue sig = get_option(ctx, init, "signal");
    if (js_is_exception(sig)) return sig;
    if (!js_is_undefined(sig)) {
        if (!js_is_null(sig) && !js_is_abort_signal(sig))
            return js_throw_type_error(ctx, "Failed to construct 'Request': member signal is not of type AbortSignal.");
        signal = sig;
    }
    JSValue body = get_option(ctx, init, "body");
    if (js_is_exception(body)) return body;
    bool given_body = !js_is_nullish(body);
    if (given_body && (method_is(ctx, method, "GET") || method_is(ctx, method, "HEAD")))
        return js_throw_type_error(ctx, "Request with GET/HEAD method cannot have body.");
    if (given_body && js_is_readable_stream(body)) {
        JSValue duplex = get_option(ctx, init, "duplex");
        if (js_is_exception(duplex)) return duplex;
        if (js_is_undefined(duplex)) return js_throw_type_error(ctx, "RequestInit: duplex option is required when sending a body.");
    }
    JSValue redirect = get_option(ctx, init, "redirect");
    if (js_is_exception(redirect)) return redirect;
    JSValue keepalive = get_option(ctx, init, "keepalive");
    if (js_is_exception(keepalive)) return keepalive;

    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_REQUEST_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    RequestObject *r = (RequestObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &request_class, proto, 4));
    init_body(&r->body);
    js_init_slot(&r->method, method);
    js_init_slot(&r->url, url);
    js_init_slot(&r->headers, JS_UNDEFINED);
    js_init_slot(&r->signal, JS_UNDEFINED);
    r->redirect = 0;
    r->keepalive = js_truthy(keepalive);
    if (js_is_string(redirect)) r->redirect = method_is(ctx, redirect, "error") ? 1 : method_is(ctx, redirect, "manual") ? 2 : 0;
    JSValue rv = js_object_value(&r->obj);
    JSValue headers = js_new_headers_from(ctx, headers_init);
    if (js_is_exception(headers)) return headers;
    js_store(ctx, &r->obj.cell, &r->headers, headers);
    /* the request's signal follows the given one (Fetch: "follow"), as undici's does */
    JSValue own = js_is_abort_signal(signal) ? js_abort_signal_follow(ctx, signal) : js_new_abort_signal(ctx);
    if (js_is_exception(own)) return own;
    js_store(ctx, &r->obj.cell, &r->signal, own);
    if (given_body) {
        JSValue type;
        if (extract(ctx, &r->obj.cell, &r->body, body, &type) < 0) return JS_EXCEPTION;
        if (!js_is_empty(type)) {
            JSValue has = js_headers_get(ctx, headers, "content-type");
            if (js_is_exception(has)) return has;
            if (js_is_null(has) && js_headers_append(ctx, headers, js_new_string_cstr(ctx, "content-type"), type) < 0) return JS_EXCEPTION;
        }
    } else if (src && src->body.has_body) {  /* the input request's body moves to this one */
        if (body_used(&src->body)) return js_throw_type_error(ctx, "Cannot construct a Request with a Request object that has already been used.");
        r->body = src->body;
        js_write_barrier(ctx, &r->obj.cell, &r->body.bytes, r->body.bytes);
        js_write_barrier(ctx, &r->obj.cell, &r->body.stream, r->body.stream);
        init_body(&src->body);
        src->body.used = 1;
        src->body.has_body = 1;
    }
    return rv;
}

#define THIS_REQUEST()                       \
    RequestObject *r = as_request(this_val); \
    if (!r) return js_throw_invalid_this(ctx, "Request")

#define REQUEST_GETTER(fn, ...) \
    BUILTIN(fn) {               \
        UNUSED_ARGS;            \
        THIS_REQUEST();         \
        return (__VA_ARGS__);   \
    }
REQUEST_GETTER(request_method, r->method)
REQUEST_GETTER(request_url, r->url)
REQUEST_GETTER(request_headers, r->headers)
REQUEST_GETTER(request_signal, r->signal)
REQUEST_GETTER(request_destination, (void)r, js_empty_string())
REQUEST_GETTER(request_referrer, (void)r, js_new_string_cstr(ctx, "about:client"))
REQUEST_GETTER(request_referrer_policy, (void)r, js_empty_string())
REQUEST_GETTER(request_mode, (void)r, js_new_string_cstr(ctx, "cors"))
REQUEST_GETTER(request_credentials, (void)r, js_new_string_cstr(ctx, "same-origin"))
REQUEST_GETTER(request_cache, (void)r, js_new_string_cstr(ctx, "default"))
REQUEST_GETTER(request_redirect, js_new_string_cstr(ctx, r->redirect == 1 ? "error" : r->redirect == 2 ? "manual" : "follow"))
REQUEST_GETTER(request_integrity, (void)r, js_empty_string())
REQUEST_GETTER(request_keepalive, js_bool(r->keepalive))
REQUEST_GETTER(request_false, (void)r, JS_FALSE)
REQUEST_GETTER(request_duplex, (void)r, js_new_string_cstr(ctx, "half"))
REQUEST_GETTER(request_body, body_stream(ctx, &r->obj.cell, &r->body))
REQUEST_GETTER(request_body_used, js_bool(body_used(&r->body)))

BUILTIN(request_clone) {
    UNUSED_ARGS;
    THIS_REQUEST();
    if (body_used(&r->body)) return js_throw_type_error(ctx, "Request.clone: Body has already been consumed.");
    JSValue headers = js_new_headers_from(ctx, r->headers);
    if (js_is_exception(headers)) return headers;
    RequestObject *c = (RequestObject *)js_alloc_object(ctx, JS_CELL_OBJECT,
        js_shape_root(ctx, &request_class, ctx->intrinsics[JS_INTRINSIC_REQUEST_PROTOTYPE], 4));
    init_body(&c->body);
    js_init_slot(&c->method, r->method);
    js_init_slot(&c->url, r->url);
    js_init_slot(&c->headers, headers);
    js_init_slot(&c->signal, JS_UNDEFINED);
    c->redirect = r->redirect;
    c->keepalive = r->keepalive;
    JSValue cv = js_object_value(&c->obj);
    JSValue signal = js_abort_signal_follow(ctx, r->signal);
    if (js_is_exception(signal)) return signal;
    js_store(ctx, &c->obj.cell, &c->signal, signal);
    return clone_body(ctx, &r->obj.cell, &r->body, &c->obj.cell, &c->body) < 0 ? JS_EXCEPTION : cv;
}

static JSValue request_consume(JSContext *ctx, JSValue this_val, int kind) {
    RequestObject *r = as_request(this_val);
    if (!r) {
        JSValue e = js_throw_invalid_this(ctx, "Request");
        (void)e;
        return rejected(ctx, js_take_exception(ctx));
    }
    return consume(ctx, &r->obj.cell, &r->body, r->headers, kind);
}

#define CONSUMER(fn, consumer, kind)                 \
    BUILTIN(fn) {                                    \
        UNUSED_ARGS;                                 \
        return consumer(ctx, this_val, kind);        \
    }
CONSUMER(request_text, request_consume, AS_TEXT)
CONSUMER(request_json, request_consume, AS_JSON)
CONSUMER(request_array_buffer, request_consume, AS_ARRAY_BUFFER)
CONSUMER(request_bytes, request_consume, AS_BYTES)
CONSUMER(request_blob, request_consume, AS_BLOB)

/* formData(): the body's bytes, parsed by FormData's module as the Content-Type says */
static JSValue form_data(JSContext *ctx, JSCell *owner, Body *b, JSValue headers) {
    if (!js_is_callable(form_data_parse)) {
        JSValue e = js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_VISALJS_UNSUPPORTED", "formData() (named only at run time)");
        (void)e;
        return rejected(ctx, js_take_exception(ctx));
    }
    JSValue type = js_headers_get(ctx, headers, "content-type");
    if (js_is_exception(type)) return rejected(ctx, js_take_exception(ctx));
    JSValue args[2] = { consume(ctx, owner, b, headers, AS_BYTES), type };
    JSValue parsed = js_call(ctx, form_data_parse, JS_UNDEFINED, 2, args);
    return js_is_exception(parsed) ? rejected(ctx, js_take_exception(ctx)) : parsed;
}

BUILTIN(request_form_data) {
    UNUSED_ARGS;
    RequestObject *r = as_request(this_val);
    if (!r) {
        JSValue e = js_throw_invalid_this(ctx, "Request");
        (void)e;
        return rejected(ctx, js_take_exception(ctx));
    }
    return form_data(ctx, &r->obj.cell, &r->body, r->headers);
}

static void field(JSContext *ctx, JSValue o, const char *name, JSValue v) {
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, name), v, JS_PROP_DEFAULT);
}

BUILTIN(request_inspect) {
    UNUSED_ARGS;
    THIS_REQUEST();
    JSValue o = js_new_object(ctx);
    field(ctx, o, "method", r->method);
    field(ctx, o, "url", r->url);
    field(ctx, o, "headers", r->headers);
    field(ctx, o, "destination", js_empty_string());
    field(ctx, o, "referrer", js_new_string_cstr(ctx, "about:client"));
    field(ctx, o, "referrerPolicy", js_empty_string());
    field(ctx, o, "mode", js_new_string_cstr(ctx, "cors"));
    field(ctx, o, "credentials", js_new_string_cstr(ctx, "same-origin"));
    field(ctx, o, "cache", js_new_string_cstr(ctx, "default"));
    field(ctx, o, "redirect", js_new_string_cstr(ctx, r->redirect == 1 ? "error" : r->redirect == 2 ? "manual" : "follow"));
    field(ctx, o, "integrity", js_empty_string());
    field(ctx, o, "keepalive", js_bool(r->keepalive));
    field(ctx, o, "isReloadNavigation", JS_FALSE);
    field(ctx, o, "isHistoryNavigation", JS_FALSE);
    field(ctx, o, "signal", r->signal);
    return js_inspect_as(ctx, this_val, "Request", o, ARG(0), ARG(1));
}

/* ---- Response (§5.5) ------------------------------------------------------------------------ */

static ResponseObject *alloc_response(JSContext *ctx, JSValue proto) {
    ResponseObject *r = (ResponseObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &response_class, proto, 4));
    init_body(&r->body);
    js_init_slot(&r->status_text, js_empty_string());
    js_init_slot(&r->headers, JS_UNDEFINED);
    js_init_slot(&r->url, js_empty_string());
    r->status = 200;
    r->type = 0;
    r->redirected = 0;
    return r;
}

static bool null_body_status(double s) { return s == 101 || s == 103 || s == 204 || s == 205 || s == 304; }

/* Initialize a response (§5.5): status, statusText, headers, then the body. 0, or -1. */
static int initialize(JSContext *ctx, ResponseObject *r, JSValue init, JSValue body, bool has_body) {
    double status = 200;
    JSValue st = get_option(ctx, init, "status");
    if (js_is_exception(st)) return -1;
    if (!js_is_undefined(st) && js_to_number(ctx, &status, st) < 0) return -1;
    status = isfinite(status) ? trunc(status) : 0;
    if (status < 200 || status > 599)
        return fail(js_throw_range_error(ctx, "init[\"status\"] must be in the range of 200 to 599, inclusive."));
    JSValue text = get_option(ctx, init, "statusText");
    if (js_is_exception(text)) return -1;
    if (!js_is_undefined(text)) {
        text = js_to_string(ctx, text);
        if (js_is_exception(text)) return -1;
        JSStrView v = js_string_view(ctx, text);
        for (uint32_t i = 0; i < v.length; i++) {
            uint32_t c = js_view_at(v, i);
            if (c == '\r' || c == '\n' || c > 255) return fail(js_throw_type_error(ctx, "Invalid statusText"));
        }
        js_store(ctx, &r->obj.cell, &r->status_text, text);
    }
    r->status = (uint16_t)status;
    JSValue h = get_option(ctx, init, "headers");
    if (js_is_exception(h)) return -1;
    JSValue headers = js_new_headers_from(ctx, h);
    if (js_is_exception(headers)) return -1;
    js_store(ctx, &r->obj.cell, &r->headers, headers);
    if (has_body) {
        if (null_body_status(status)) return fail(js_throw_type_error(ctx, "Response constructor: Invalid response status code %d", (int)status));
        JSValue type;
        if (extract(ctx, &r->obj.cell, &r->body, body, &type) < 0) return -1;
        if (!js_is_empty(type)) {
            JSValue has = js_headers_get(ctx, headers, "content-type");
            if (js_is_exception(has)) return -1;
            if (js_is_null(has) && js_headers_append(ctx, headers, js_new_string_cstr(ctx, "content-type"), type) < 0) return -1;
        }
    }
    return 0;
}

/* new Response(body = null, init) */
BUILTIN(response_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "_Response");
    JSValue init = ARG(1);
    if (!js_is_nullish(init) && !js_is_object(init))
        return js_throw_type_error(ctx, "Response constructor: Expected init (\"Argument 2\") to be an instance of ResponseInit.");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_RESPONSE_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    ResponseObject *r = alloc_response(ctx, proto);
    JSValue rv = js_object_value(&r->obj);
    return initialize(ctx, r, init, ARG(0), !js_is_nullish(ARG(0))) < 0 ? JS_EXCEPTION : rv;
}

/* Response.error() */
BUILTIN(response_error) {
    UNUSED_ARGS;
    ResponseObject *r = alloc_response(ctx, ctx->intrinsics[JS_INTRINSIC_RESPONSE_PROTOTYPE]);
    JSValue rv = js_object_value(&r->obj);
    r->status = 0;
    r->type = 1;
    JSValue headers = js_new_headers_from(ctx, JS_UNDEFINED);
    if (js_is_exception(headers)) return headers;
    js_headers_set_guard(headers, JS_HEADERS_IMMUTABLE);
    js_store(ctx, &r->obj.cell, &r->headers, headers);
    return rv;
}

/* Response.json(data, init) */
BUILTIN(response_json_static) {
    UNUSED_ARGS;
    JSValue s = js_json_stringify(ctx, ARG(0), JS_UNDEFINED, JS_UNDEFINED, NULL);
    if (js_is_exception(s)) return s;
    if (js_is_undefined(s)) return js_throw_type_error(ctx, "Value is not JSON serializable");
    ResponseObject *r = alloc_response(ctx, ctx->intrinsics[JS_INTRINSIC_RESPONSE_PROTOTYPE]);
    JSValue rv = js_object_value(&r->obj);
    if (initialize(ctx, r, ARG(1), s, true) < 0) return JS_EXCEPTION;
    /* extract gave text/plain: JSON's type replaces it unless the init set one */
    JSValue h = get_option(ctx, ARG(1), "headers");
    JSValue given = JS_NULL;
    if (!js_is_nullish(h)) {
        JSValue probe = js_new_headers_from(ctx, h);
        if (js_is_exception(probe)) return probe;
        given = js_headers_get(ctx, probe, "content-type");
    }
    if (js_is_null(given)) {
        JSValue fresh = js_new_headers_from(ctx, h);
        if (js_is_exception(fresh)) return fresh;
        if (js_headers_append(ctx, fresh, js_new_string_cstr(ctx, "content-type"), js_new_string_cstr(ctx, "application/json")) < 0) return JS_EXCEPTION;
        js_store(ctx, &r->obj.cell, &r->headers, fresh);
    }
    return rv;
}

/* Response.redirect(url, status = 302) */
BUILTIN(response_redirect) {
    UNUSED_ARGS;
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    JSValue url = js_parse_url_href(ctx, s);
    if (js_is_exception(url)) return url;
    if (js_is_undefined(url)) return throw_unparsable(ctx, s);
    double status = 302;
    if (!js_is_undefined(ARG(1)) && js_to_number(ctx, &status, ARG(1)) < 0) return JS_EXCEPTION;
    if (status != 301 && status != 302 && status != 303 && status != 307 && status != 308)
        return js_throw_range_error(ctx, "Invalid status code %g", status);
    ResponseObject *r = alloc_response(ctx, ctx->intrinsics[JS_INTRINSIC_RESPONSE_PROTOTYPE]);
    JSValue rv = js_object_value(&r->obj);
    r->status = (uint16_t)status;
    JSValue headers = js_new_headers_from(ctx, JS_UNDEFINED);
    if (js_is_exception(headers)) return headers;
    if (js_headers_append(ctx, headers, js_new_string_cstr(ctx, "location"), url) < 0) return JS_EXCEPTION;
    js_headers_set_guard(headers, JS_HEADERS_IMMUTABLE);
    js_store(ctx, &r->obj.cell, &r->headers, headers);
    return rv;
}

#define THIS_RESPONSE()                        \
    ResponseObject *r = as_response(this_val); \
    if (!r) return js_throw_invalid_this(ctx, "Response")

#define RESPONSE_GETTER(fn, expr) \
    BUILTIN(fn) {                 \
        UNUSED_ARGS;              \
        THIS_RESPONSE();          \
        return (expr);            \
    }
static const char *const TYPES[] = { "default", "error", "basic", "cors", "opaque", "opaqueredirect" };
RESPONSE_GETTER(response_type, js_new_string_cstr(ctx, TYPES[r->type]))
RESPONSE_GETTER(response_url, r->url)
RESPONSE_GETTER(response_redirected, js_bool(r->redirected))
RESPONSE_GETTER(response_status, js_int32(r->status))
RESPONSE_GETTER(response_ok, js_bool(r->status >= 200 && r->status <= 299))
RESPONSE_GETTER(response_status_text, r->status_text)
RESPONSE_GETTER(response_headers, r->headers)
RESPONSE_GETTER(response_body, body_stream(ctx, &r->obj.cell, &r->body))
RESPONSE_GETTER(response_body_used, js_bool(body_used(&r->body)))

BUILTIN(response_clone) {
    UNUSED_ARGS;
    THIS_RESPONSE();
    if (body_used(&r->body)) return js_throw_type_error(ctx, "Response.clone: Body has already been consumed.");
    JSValue headers = js_new_headers_from(ctx, r->headers);
    if (js_is_exception(headers)) return headers;
    ResponseObject *c = alloc_response(ctx, ctx->intrinsics[JS_INTRINSIC_RESPONSE_PROTOTYPE]);
    JSValue cv = js_object_value(&c->obj);
    c->status = r->status;
    c->type = r->type;
    c->redirected = r->redirected;
    js_store(ctx, &c->obj.cell, &c->status_text, r->status_text);
    js_store(ctx, &c->obj.cell, &c->url, r->url);
    js_store(ctx, &c->obj.cell, &c->headers, headers);
    return clone_body(ctx, &r->obj.cell, &r->body, &c->obj.cell, &c->body) < 0 ? JS_EXCEPTION : cv;
}

static JSValue response_consume(JSContext *ctx, JSValue this_val, int kind) {
    ResponseObject *r = as_response(this_val);
    if (!r) {
        JSValue e = js_throw_invalid_this(ctx, "Response");
        (void)e;
        return rejected(ctx, js_take_exception(ctx));
    }
    return consume(ctx, &r->obj.cell, &r->body, r->headers, kind);
}

BUILTIN(response_form_data) {
    UNUSED_ARGS;
    ResponseObject *r = as_response(this_val);
    if (!r) {
        JSValue e = js_throw_invalid_this(ctx, "Response");
        (void)e;
        return rejected(ctx, js_take_exception(ctx));
    }
    return form_data(ctx, &r->obj.cell, &r->body, r->headers);
}
CONSUMER(response_text, response_consume, AS_TEXT)
CONSUMER(response_json, response_consume, AS_JSON)
CONSUMER(response_array_buffer, response_consume, AS_ARRAY_BUFFER)
CONSUMER(response_bytes, response_consume, AS_BYTES)
CONSUMER(response_blob, response_consume, AS_BLOB)

BUILTIN(response_inspect) {
    UNUSED_ARGS;
    THIS_RESPONSE();
    JSValue o = js_new_object(ctx);
    field(ctx, o, "status", js_int32(r->status));
    field(ctx, o, "statusText", r->status_text);
    field(ctx, o, "headers", r->headers);
    JSValue body = body_stream(ctx, &r->obj.cell, &r->body);
    if (js_is_exception(body)) return body;
    field(ctx, o, "body", body);
    field(ctx, o, "bodyUsed", js_bool(body_used(&r->body)));
    field(ctx, o, "ok", js_bool(r->status >= 200 && r->status <= 299));
    field(ctx, o, "redirected", js_bool(r->redirected));
    field(ctx, o, "type", js_new_string_cstr(ctx, TYPES[r->type]));
    field(ctx, o, "url", r->url);
    return js_inspect_as(ctx, this_val, "Response", o, ARG(0), ARG(1));
}

/* ---- Realm ---------------------------------------------------------------------------------- */

static const JSBuiltin request_proto[] = {
    WEBIDL_ATTRIBUTE("method", request_method, NULL),
    WEBIDL_ATTRIBUTE("url", request_url, NULL),
    WEBIDL_ATTRIBUTE("headers", request_headers, NULL),
    WEBIDL_ATTRIBUTE("destination", request_destination, NULL),
    WEBIDL_ATTRIBUTE("referrer", request_referrer, NULL),
    WEBIDL_ATTRIBUTE("referrerPolicy", request_referrer_policy, NULL),
    WEBIDL_ATTRIBUTE("mode", request_mode, NULL),
    WEBIDL_ATTRIBUTE("credentials", request_credentials, NULL),
    WEBIDL_ATTRIBUTE("cache", request_cache, NULL),
    WEBIDL_ATTRIBUTE("redirect", request_redirect, NULL),
    WEBIDL_ATTRIBUTE("integrity", request_integrity, NULL),
    WEBIDL_ATTRIBUTE("keepalive", request_keepalive, NULL),
    WEBIDL_ATTRIBUTE("isReloadNavigation", request_false, NULL),
    WEBIDL_ATTRIBUTE("isHistoryNavigation", request_false, NULL),
    WEBIDL_ATTRIBUTE("signal", request_signal, NULL),
    WEBIDL_ATTRIBUTE("body", request_body, NULL),
    WEBIDL_ATTRIBUTE("bodyUsed", request_body_used, NULL),
    WEBIDL_ATTRIBUTE("duplex", request_duplex, NULL),
    WEBIDL_OPERATION("clone", request_clone, 0),
    WEBIDL_OPERATION("blob", request_blob, 0),
    WEBIDL_OPERATION("arrayBuffer", request_array_buffer, 0),
    WEBIDL_OPERATION("text", request_text, 0),
    WEBIDL_OPERATION("json", request_json, 0),
    WEBIDL_OPERATION("formData", request_form_data, 0),
    WEBIDL_OPERATION("bytes", request_bytes, 0),
};

static const JSBuiltin response_statics[] = {
    WEBIDL_OPERATION("error", response_error, 0),
    WEBIDL_OPERATION("json", response_json_static, 1),
    WEBIDL_OPERATION("redirect", response_redirect, 1),
};

static const JSBuiltin response_proto[] = {
    WEBIDL_ATTRIBUTE("type", response_type, NULL),
    WEBIDL_ATTRIBUTE("url", response_url, NULL),
    WEBIDL_ATTRIBUTE("redirected", response_redirected, NULL),
    WEBIDL_ATTRIBUTE("status", response_status, NULL),
    WEBIDL_ATTRIBUTE("ok", response_ok, NULL),
    WEBIDL_ATTRIBUTE("statusText", response_status_text, NULL),
    WEBIDL_ATTRIBUTE("headers", response_headers, NULL),
    WEBIDL_ATTRIBUTE("body", response_body, NULL),
    WEBIDL_ATTRIBUTE("bodyUsed", response_body_used, NULL),
    WEBIDL_OPERATION("clone", response_clone, 0),
    WEBIDL_OPERATION("blob", response_blob, 0),
    WEBIDL_OPERATION("arrayBuffer", response_array_buffer, 0),
    WEBIDL_OPERATION("text", response_text, 0),
    WEBIDL_OPERATION("json", response_json, 0),
    WEBIDL_OPERATION("formData", response_form_data, 0),
    WEBIDL_OPERATION("bytes", response_bytes, 0),
};

/* ---- fetch() (node/prelude/internal/fetch.js) ---------------------------------------------- */

/* fetchHeaderList(headers): a Headers' entries as sent, [name, value, …] in the order they were
 * added, with the names' case kept. */
JSValue js_host_fetch_header_list(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    JSValue headers = ARG(0);
    if (!js_is_headers(headers)) return js_throw_type_error(ctx, "fetchHeaderList: not a Headers");
    uint32_t n = js_headers_count(headers);
    JSValue list = js_new_array(ctx, n * 2);
    if (js_is_exception(list)) return list;
    for (uint32_t i = 0; i < n; i++) {
        JSValue lower, name, value;
        js_headers_at(headers, i, &lower, &name, &value);
        if (js_array_append(ctx, list, name) < 0 || js_array_append(ctx, list, value) < 0) return JS_EXCEPTION;
    }
    return list;
}

/* fetchRequestBody(request): the body a fetch sends, taken from the request (it is then used):
 * its bytes (a Uint8Array, sent with a Content-Length), its ReadableStream (sent chunked), or
 * null. */
JSValue js_host_fetch_request_body(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    RequestObject *r = as_request(ARG(0));
    if (!r) return js_throw_invalid_this(ctx, "Request");
    Body *b = &r->body;
    if (!b->has_body) return JS_NULL;
    if (body_used(b)) return js_throw_type_error(ctx, "Body is unusable: Body has already been read");
    if (!js_is_undefined(b->stream)) return b->stream;
    b->used = 1;
    return js_is_undefined(b->bytes) ? js_new_uint8_array(ctx, 0) : b->bytes;
}

/* fetchResponse(status, statusText, headers, body, url, redirected): a fetched response, its
 * headers (a Headers) made immutable and its body a ReadableStream or null. */
JSValue js_host_fetch_response(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    double status;
    if (js_to_number(ctx, &status, ARG(0)) < 0) return JS_EXCEPTION;
    if (!js_is_headers(ARG(2))) return js_throw_type_error(ctx, "fetchResponse: not a Headers");
    ResponseObject *r = alloc_response(ctx, ctx->intrinsics[JS_INTRINSIC_RESPONSE_PROTOTYPE]);
    JSValue rv = js_object_value(&r->obj);
    r->status = (uint16_t)status;
    r->type = 2;
    r->redirected = js_truthy(ARG(5));
    if (js_is_string(ARG(1))) js_store(ctx, &r->obj.cell, &r->status_text, ARG(1));
    js_headers_set_guard(ARG(2), JS_HEADERS_IMMUTABLE);
    js_store(ctx, &r->obj.cell, &r->headers, ARG(2));
    if (js_is_string(ARG(4))) js_store(ctx, &r->obj.cell, &r->url, ARG(4));
    if (js_is_readable_stream(ARG(3))) {
        r->body.has_body = 1;
        js_store(ctx, &r->obj.cell, &r->body.stream, ARG(3));
    }
    return rv;
}

/* fetchFormDataHooks(serialize, parse): FormData's module's body serializer and formData() parser */
JSValue js_host_fetch_form_data_hooks(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    static bool rooted;
    if (!rooted) {
        js_add_root(ctx->rt, &form_data_serialize);
        js_add_root(ctx->rt, &form_data_parse);
        rooted = true;
    }
    form_data_serialize = ARG(0);
    form_data_parse = ARG(1);
    return JS_UNDEFINED;
}

static void install_fetch(JSContext *ctx, JSObject *global) {
    JSValue object_proto = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];
    js_define_web_class(ctx, global, "Request", request_ctor, 1, object_proto, JS_INTRINSIC_REQUEST_PROTOTYPE);
    JSValue qp = ctx->intrinsics[JS_INTRINSIC_REQUEST_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(qp), request_proto, JS_COUNTOF(request_proto));
    js_define_inspect(ctx, qp, request_inspect, "Request");
    /* undici leaves this behind on Request.prototype (an enumerable, read-only undefined) */
    js_define_data(ctx, js_as_object(qp), js_atom_from_cstr(ctx, "attribute"), JS_UNDEFINED, JS_PROP_ENUMERABLE);

    JSValue response = js_define_web_class(ctx, global, "Response", response_ctor, 0, object_proto, JS_INTRINSIC_RESPONSE_PROTOTYPE);
    js_define_builtins(ctx, js_as_object(response), response_statics, JS_COUNTOF(response_statics));
    JSValue rp = ctx->intrinsics[JS_INTRINSIC_RESPONSE_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(rp), response_proto, JS_COUNTOF(response_proto));
    js_define_inspect(ctx, rp, response_inspect, "Response");
}

const JSComponent js_component_fetch = { "fetch", install_fetch };
