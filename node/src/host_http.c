/* Host primitives for node:http: llhttp (Node's parser) on node:net's
 * sockets, for a server's requests and a client's responses. As in Node, a connection is a
 * net.Socket, but its bytes go to the parser in C, not through JS: host_net.c's hook hands them
 * over. The prelude's http.js builds Node's objects from what the parser finds; C does the
 * per-byte work: parsing and writing. Connections are numbered by their net handle's id.
 *
 *   httpParsers(onHead, onBody, onComplete, onUpgrade, onError) → parsers id (a server's, a client's)
 *     onHead(conn, method | status, url | statusMessage, headers [k, v, …], major, minor, keepAlive, upgrade)
 *                              → 0, or 1 when the message has no body (a response to HEAD), or 2
 *                              to take the socket after the head (an upgrade, CONNECT): the parser
 *                              lets go of it, and onUpgrade(conn, head) follows with the bytes
 *                              after the head; an upgrade not taken parses on
 *     onBody(conn, chunk)      a Uint8Array (the prelude makes it a Buffer)
 *     onComplete(conn, trailers)   the message's end; its trailers [k, v, …], or undefined
 *     onError(conn, code, reason)  a parse error ("HPE_INVALID_METHOD", …); parsing stops
 *   httpAttach(conn, parsers, response, maxHeaderSize) → 0 | -errno   the socket's bytes go to a
 *                              request (or with `response`, a response) parser from now on
 *   httpDetach(conn)           the socket's bytes go to JS again
 *   httpExpired(parsers, headersTimeout, requestTimeout) → [conn, …]: the connections whose
 *                              request (or its head) has taken longer, as Node's connectionsList
 *   httpWrite(conn, data)      a string (written as UTF-8) or a Uint8Array, corked: what a callback
 *                              writes goes out in one write when it (and its microtasks) returns
 *   httpFlush(conn)            sends the corked output now (before the socket is ended)
 *   httpDate() → the Date header's value
 * A socket whose bytes aren't its handle's (a TLS socket's are decrypted in JS, a Duplex has no
 * handle) is a fed connection, with a negative id: JS gives its parser the bytes, and its output
 * goes to a JS writer (which the TLS socket encrypts).
 *   httpFedOpen(writer) → conn     writer(bytes) gets what the connection's output flushes
 *   httpFeed(conn, bytes | null) → whether the parser took them (null: the end of the input)
 *   httpFedClose(conn)             the connection is done with (its socket closed)
 * The loop is host_loop.c's; the sockets are host_net.c's. */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers: pthread_rwlock_t, struct addrinfo */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "js_atoms.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_gc.h"
#include "js_node.h"
#include "js_ops.h"
#include "js_uv.h"
#include "jscontext.h"
#include "jsstring.h"
#include "llhttp.h"

static void flush_pending(void);
typedef struct Conn Conn;
static void flush_conn(Conn *c);

/* ---- Parsers and connections ------------------------------------------------------------- */

typedef struct Parsers {
    JSValue on_request, on_body, on_complete, on_upgrade, on_error;  /* roots */
} Parsers;

typedef struct Buf {
    char  *v;
    size_t n, cap;
} Buf;

struct Conn {
    llhttp_t parser;
    Parsers *parsers;
    int      id;         /* the net handle's */
    bool     response;   /* a client's: it parses responses */
    bool     detached;   /* upgraded, or a parse error: the parser doesn't read any more */
    bool     executing;  /* llhttp is running on it: it can't be freed yet */
    bool     released;   /* let go of while executing: freed when llhttp returns */
    bool     detach_after;  /* detached when llhttp is done with the read (httpDetach's afterRead) */
    bool     upgrading;  /* JS took the upgrade the head asked for */
    bool     active;     /* a message is under way (or the connection is new): timeouts count */
    bool     head_done;  /* its head is complete: what follows are its body and trailers */
    bool     overflow;   /* its head is over max_header bytes */
    uint64_t begin_ms;   /* when the message began (the loop's time) */
    size_t   header_bytes, max_header;
    Buf      url, field, value;  /* url: a response's status message */
    JSValue  headers;    /* the head's or the trailers' [k, v, …] being parsed (a root) */
    bool     in_value;
    bool     queued;     /* in `pending`: `out` goes out at the next flush */
    Buf      out;        /* written but not sent: corked, as Node corks a response */
};

/* A fed connection: its writer, and the parser it has now (a new one per kept-alive request). */
typedef struct Fed {
    JSValue writer;  /* a root */
    Conn   *conn;
} Fed;

static Parsers **parsers;
static size_t nparsers;
static Conn **conns;   /* by net handle id */
static size_t nconns;
static Fed **feds;     /* fed connections: id -(k + 1) is feds[k] */
static size_t nfeds;
static int *pending;   /* ids of connections with corked output */
static size_t npending, pending_cap;
static llhttp_settings_t settings;

static JSContext *ctx_(void) { return js_uv_context(); }

/* Room for n more bytes (and the NUL). */
static void buf_reserve(Buf *b, size_t n) {
    if (b->n + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 64;
        while (cap < b->n + n + 1) cap *= 2;
        char *v = realloc(b->v, cap);
        if (!v) js_fatal("out of memory in http");
        b->v = v;
        b->cap = cap;
    }
}

static void buf_append(Buf *b, const char *s, size_t n) {
    buf_reserve(b, n);
    memcpy(b->v + b->n, s, n);
    b->n += n;
    b->v[b->n] = '\0';
}

/* Header bytes as a string: Latin-1, as Node reads them. */
static JSValue latin1(JSContext *ctx, const Buf *b) { return js_new_string_latin1(ctx, (const uint8_t *)(b->v ? b->v : ""), (uint32_t)b->n); }

static JSValue bytes_value(JSContext *ctx, const char *at, size_t n) {
    JSValue chunk = js_new_uint8_array(ctx, n);
    if (js_is_exception(chunk)) js_fatal("out of memory in http");
    uint8_t *data;
    size_t len;
    js_buffer_source_bytes(chunk, &data, &len);
    if (n) memcpy(data, at, n);
    return chunk;
}

static void push_header(Conn *c) {
    JSContext *ctx = ctx_();
    if (js_is_undefined(c->headers)) c->headers = js_new_array(ctx, 0);  /* the first trailer */
    JSValue k = latin1(ctx, &c->field), v = latin1(ctx, &c->value);
    if (js_array_push(ctx, js_as_object(c->headers), k) < 0 || js_array_push(ctx, js_as_object(c->headers), v) < 0) js_fatal("out of memory in http");
    c->field.n = c->value.n = 0;
    c->in_value = false;
}

static int on_message_begin(llhttp_t *p) {
    Conn *c = p->data;
    if (c->detached) return -1;  /* let go of by an earlier callback */
    c->url.n = c->field.n = c->value.n = 0;
    c->in_value = false;
    c->headers = js_new_array(ctx_(), 0);
    c->active = true;
    c->head_done = false;
    c->header_bytes = 0;
    c->begin_ms = uv_now(js_uv_loop(ctx_()));
    return 0;
}

/* Node's maxHeaderSize: the head's bytes so far (the URL and the header lines) */
static int count_head(Conn *c, size_t n) {
    if (c->head_done) return 0;
    c->header_bytes += n;
    if (c->max_header && c->header_bytes > c->max_header) {
        c->overflow = true;
        return -1;
    }
    return 0;
}

static int on_url(llhttp_t *p, const char *at, size_t n) {
    Conn *c = p->data;
    buf_append(&c->url, at, n);
    return count_head(c, n);
}

static int on_header_field(llhttp_t *p, const char *at, size_t n) {
    Conn *c = p->data;
    if (c->in_value) push_header(c);
    buf_append(&c->field, at, n);
    return count_head(c, n);
}

static int on_header_value(llhttp_t *p, const char *at, size_t n) {
    Conn *c = p->data;
    c->in_value = true;
    buf_append(&c->value, at, n);
    return count_head(c, n);
}

/* The head: JS makes the request (or response); it says whether the message has a body (1:
 * none) and whether it takes the socket (2: llhttp pauses after the head). */
static int on_headers_complete(llhttp_t *p) {
    Conn *c = p->data;
    if (c->detached) return -1;  /* let go of by an earlier callback */
    JSContext *ctx = ctx_();
    if (c->in_value || c->field.n) push_header(c);
    c->head_done = true;
    JSValue first = c->response ? js_int32(llhttp_get_status_code(p))
                                : js_new_string_cstr(ctx, llhttp_method_name((llhttp_method_t)llhttp_get_method(p)));
    JSValue args[8] = {
        js_int32(c->id), first, latin1(ctx, &c->url), c->headers, js_int32(llhttp_get_http_major(p)), js_int32(llhttp_get_http_minor(p)),
        js_bool(llhttp_should_keep_alive(p)), js_bool(p->upgrade),
    };
    c->headers = JS_UNDEFINED;
    JSValue r = JS_UNDEFINED;
    if (!js_uv_call(c->parsers->on_request, 8, args, &r)) return -1;
    int skip = js_is_int32(r) ? js_as_int32(r) : 0;
    if (skip == 2) c->upgrading = true;
    return skip == 1 || skip == 2 ? skip : 0;
}

static int on_body(llhttp_t *p, const char *at, size_t n) {
    Conn *c = p->data;
    if (c->detached) return -1;  /* let go of by an earlier callback */
    JSValue args[2] = { js_int32(c->id), bytes_value(ctx_(), at, n) };
    return js_uv_call(c->parsers->on_body, 2, args, NULL) ? 0 : -1;
}

static int on_message_complete(llhttp_t *p) {
    Conn *c = p->data;
    if (c->detached) return -1;  /* let go of by an earlier callback */
    if (c->in_value || c->field.n) push_header(c);  /* the last trailer */
    c->active = false;
    JSValue args[2] = { js_int32(c->id), c->headers };
    c->headers = JS_UNDEFINED;
    return js_uv_call(c->parsers->on_complete, 2, args, NULL) ? 0 : -1;
}

static Fed *fed_of(int id) {
    if (id >= 0) return NULL;
    size_t k = (size_t)(-(id + 1));
    return k < nfeds ? feds[k] : NULL;
}

static Conn *conn_of(int id) {
    if (id < 0) {
        Fed *f = fed_of(id);
        return f ? f->conn : NULL;
    }
    return (size_t)id < nconns ? conns[id] : NULL;
}

/* the parse error, with Node's bytesParsed and rawPacket: how far into the read llhttp got, and
 * the read (none for a message cut short at the end of the stream) */
static void parse_error(Conn *c, llhttp_errno_t e, const char *bytes, size_t n) {
    c->detached = true;
    c->active = false;
    JSContext *ctx = ctx_();
    const char *code = c->overflow ? "HPE_HEADER_OVERFLOW" : llhttp_errno_name(e);
    const char *reason = c->overflow ? "Header overflow" : llhttp_get_error_reason(&c->parser);
    const char *pos = bytes ? llhttp_get_error_pos(&c->parser) : NULL;
    int32_t parsed = pos && pos >= bytes && pos <= bytes + n ? (int32_t)(pos - bytes) : 0;
    JSValue args[5] = { js_int32(c->id), js_new_string_cstr(ctx, code), js_new_string_cstr(ctx, reason ? reason : ""), js_int32(parsed),
                        bytes ? bytes_value(ctx, bytes, n) : JS_UNDEFINED };
    (void)js_uv_call(c->parsers->on_error, 5, args, NULL);
}

static void free_conn(Conn *c) {
    js_remove_root(ctx_()->rt, &c->headers);
    free(c->url.v), free(c->field.v), free(c->value.v), free(c->out.v);
    free(c);
}

/* The connection's parser is done with (detached, replaced, or the socket closed): freed now, or
 * when llhttp returns if a callback let go of it (a client frees its parser in the response's
 * last callback, and starts the next request in a microtask). */
static void release_conn(Conn *c) {
    Fed *f = fed_of(c->id);
    if (f) {
        if (f->conn == c) f->conn = NULL;
    } else if (conns[c->id] == c) {
        conns[c->id] = NULL;
    }
    c->detached = true;
    if (c->executing) c->released = true;
    else free_conn(c);
}

/* The socket's bytes go to JS again: the corked output first, then the parser let go of. */
static void detach_conn(Conn *c) {
    if (c->queued) flush_conn(c);
    if (c->id >= 0) js_net_hook(c->id, NULL, NULL);
    release_conn(c);
}

/* llhttp is done with a read: a parser let go of meanwhile is freed, or detached if asked to be. */
static void read_done(Conn *c) {
    c->executing = false;
    if (c->released) {
        free_conn(c);
    } else if (c->detach_after) {
        c->detach_after = false;
        detach_conn(c);
    }
}

/* A connection's bytes: parsed while attached; EOF and errors go on to JS (the socket's 'end'
 * and 'error'). False when the parser doesn't take them. */
static bool parse_input(Conn *c, ssize_t n, const char *bytes) {
    if (c->detached) return false;
    c->executing = true;
    if (n < 0) {
        if (n == UV_EOF) {
            /* a request cut short is the server's parse error; a client's response cut short shows
             * as its 'aborted', when the socket closes (as Node's socketOnEnd ignores finish()) */
            llhttp_errno_t e = llhttp_finish(&c->parser);
            if (e != HPE_OK && !c->detached && !c->response) parse_error(c, e, NULL, 0);
        }
        read_done(c);
        return false;
    }
    const char *at = bytes, *end = bytes + n;
    while (at < end && !c->detached) {
        llhttp_errno_t e = llhttp_execute(&c->parser, at, (size_t)(end - at));
        if (e == HPE_OK || c->detached) break;  /* released or upgraded by a callback: stop here */
        if (e != HPE_PAUSED_UPGRADE) {
            parse_error(c, e, bytes, (size_t)n);  /* nothing runs once a callback failed in JS: the loop is ending */
            break;
        }
        const char *pos = llhttp_get_error_pos(&c->parser);
        if (!c->upgrading) {  /* an upgrade JS didn't take: the request was an ordinary one */
            llhttp_resume_after_upgrade(&c->parser);
            at = pos;
            continue;
        }
        /* the socket is JS's from here: what it reads next goes to its stream, as in Node */
        c->detached = true;
        JSValue args[2] = { js_int32(c->id), bytes_value(ctx_(), pos, (size_t)(end - pos)) };
        (void)js_uv_call(c->parsers->on_upgrade, 2, args, NULL);
        break;
    }
    read_done(c);
    return true;
}

/* A socket's bytes, before JS sees them. */
/* a socket's read, parsed in C: its callbacks (a body and its end) run before the microtasks and
 * nextTicks do, as in Node, where one read is one callback scope */
static bool hook_read(void *data, ssize_t n, const char *bytes) {
    js_uv_nest(1);
    bool ok = parse_input(data, n, bytes);
    js_uv_nest(-1);
    return js_uv_drain() && ok;
}

static void hook_close(void *data) { release_conn(data); }

static const JSNetHook http_hook = { hook_read, hook_close };

/* httpParsers(onHead, onBody, onComplete, onUpgrade, onError) → id */
JSValue js_host_http_parsers(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    if (argc < 5) return js_throw_type_error(ctx, "httpParsers: 5 arguments expected");
    if (!settings.on_message_begin) {
        llhttp_settings_init(&settings);
        settings.on_message_begin = on_message_begin;
        settings.on_url = on_url;
        settings.on_status = on_url;  /* a response's status message, where a request's URL goes */
        settings.on_header_field = on_header_field;
        settings.on_header_value = on_header_value;
        settings.on_headers_complete = on_headers_complete;
        settings.on_body = on_body;
        settings.on_message_complete = on_message_complete;
        (void)js_uv_loop(ctx);
        js_uv_set_flush(flush_pending);
    }
    Parsers *p = malloc(sizeof *p);
    if (!p) js_fatal("out of memory in http");
    p->on_request = argv[0], p->on_body = argv[1], p->on_complete = argv[2], p->on_upgrade = argv[3], p->on_error = argv[4];
    js_add_root(ctx->rt, &p->on_request), js_add_root(ctx->rt, &p->on_body), js_add_root(ctx->rt, &p->on_complete);
    js_add_root(ctx->rt, &p->on_upgrade), js_add_root(ctx->rt, &p->on_error);
    Parsers **v = realloc(parsers, (nparsers + 1) * sizeof *v);
    if (!v) js_fatal("out of memory in http");
    parsers = v;
    parsers[nparsers] = p;
    return js_int32((int32_t)nparsers++);
}

/* httpAttach(conn, parsers, response, maxHeaderSize) → 0 | -errno: a new parser for the socket */
JSValue js_host_http_attach(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    if (argc < 2 || !js_is_int32(argv[0]) || !js_is_int32(argv[1])) return js_throw_type_error(ctx, "httpAttach: (conn, parsers) expected");
    int id = js_as_int32(argv[0]);
    int32_t pi = js_as_int32(argv[1]);
    Fed *f = fed_of(id);
    if (pi < 0 || (size_t)pi >= nparsers || (id < 0 ? !f : !js_net_stream(id))) return js_int32(UV_EBADF);
    if (f) {
        if (f->conn) release_conn(f->conn);
    } else if ((size_t)id >= nconns) {
        size_t n = nconns ? nconns : 64;
        while (n <= (size_t)id) n *= 2;
        Conn **v = realloc(conns, n * sizeof *v);
        if (!v) js_fatal("out of memory in http");
        memset(v + nconns, 0, (n - nconns) * sizeof *v);
        conns = v;
        nconns = n;
    }
    if (!f && conns[id]) release_conn(conns[id]);  /* a kept-alive socket's next request: a fresh parser */
    Conn *c = calloc(1, sizeof *c);
    if (!c) js_fatal("out of memory in http");
    c->id = id;
    c->parsers = parsers[pi];
    c->response = argc > 2 && js_truthy(argv[2]);
    c->max_header = argc > 3 && js_is_int32(argv[3]) && js_as_int32(argv[3]) > 0 ? (size_t)js_as_int32(argv[3]) : 0;
    c->headers = JS_UNDEFINED;
    c->active = true;  /* a new connection's first request is timed from now */
    c->begin_ms = uv_now(js_uv_loop(ctx));
    js_add_root(ctx->rt, &c->headers);
    llhttp_init(&c->parser, c->response ? HTTP_RESPONSE : HTTP_REQUEST, &settings);
    c->parser.data = c;
    if (f) {
        f->conn = c;  /* its bytes come from httpFeed */
    } else {
        conns[id] = c;
        js_net_hook(id, &http_hook, c);
    }
    return js_int32(0);
}

/* httpDetach(conn, afterRead): the socket's bytes go to JS again (its corked output goes first);
 * with afterRead, from a parser callback, once llhttp is done with the read, as Node's client frees
 * its parser after the read (what follows a response in it is still parsed) */
JSValue js_host_http_detach(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    Conn *c = argc > 0 && js_is_int32(argv[0]) ? conn_of(js_as_int32(argv[0])) : NULL;
    if (!c) return JS_UNDEFINED;
    if (argc > 1 && js_truthy(argv[1]) && c->executing) c->detach_after = true;
    else detach_conn(c);
    return JS_UNDEFINED;
}

/* httpExpired(parsers, headersTimeout, requestTimeout) → the connections over time, as Node's
 * ConnectionsList::Expired: a head not complete within headersTimeout, or a request not
 * complete within requestTimeout, from its start (or the connection's); 0 turns one off */
JSValue js_host_http_expired(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    if (argc < 3 || !js_is_int32(argv[0])) return js_throw_type_error(ctx, "httpExpired: (parsers, headersTimeout, requestTimeout) expected");
    int32_t pi = js_as_int32(argv[0]);
    double headers_timeout = 0, request_timeout = 0;
    if (js_to_number(ctx, &headers_timeout, argv[1]) < 0 || js_to_number(ctx, &request_timeout, argv[2]) < 0) return JS_EXCEPTION;
    JSValue list = js_new_array(ctx, 0);
    if (pi < 0 || (size_t)pi >= nparsers) return list;
    uint64_t now = uv_now(js_uv_loop(ctx));
    for (size_t i = 0; i < nconns + nfeds; i++) {
        Conn *c = i < nconns ? conns[i] : feds[i - nconns] ? feds[i - nconns]->conn : NULL;
        if (!c || c->parsers != parsers[pi] || !c->active || c->detached) continue;
        uint64_t age = now - c->begin_ms;
        if ((!c->head_done && headers_timeout > 0 && (double)age > headers_timeout) || (request_timeout > 0 && (double)age > request_timeout)) {
            c->active = false;
            if (js_array_push(ctx, js_as_object(list), js_int32(c->id)) < 0) return JS_EXCEPTION;
        }
    }
    return list;
}

/* ---- Writing ----------------------------------------------------------------------------- */

typedef struct WriteReq {
    uv_write_t req;
    char      *data;
} WriteReq;

static void on_written(uv_write_t *req, int status) {
    (void)status;  /* a failed write shows as the socket's read error, or its close */
    WriteReq *w = (WriteReq *)req;
    free(w->data);
    free(w);
}

/* Sends a connection's corked output as one write. */
static void flush_conn(Conn *c) {
    c->queued = false;
    Fed *f = fed_of(c->id);
    if (f) {  /* to its writer: the connection may be gone when it returns */
        if (c->out.n == 0) return;
        JSValue bytes = bytes_value(ctx_(), c->out.v, c->out.n);
        c->out.n = 0;
        JSValue writer = f->writer;
        (void)js_uv_call(writer, 1, &bytes, NULL);
        return;
    }
    uv_stream_t *s = js_net_stream(c->id);
    if (!s || c->out.n == 0) {
        c->out.n = 0;
        return;
    }
    WriteReq *w = malloc(sizeof *w);
    if (!w) js_fatal("out of memory in http");
    w->data = c->out.v;  /* the buffer goes with the write; the connection starts a new one */
    uv_buf_t b = uv_buf_init(c->out.v, (unsigned)c->out.n);
    c->out = (Buf){ 0 };
    if (uv_write(&w->req, s, &b, 1, on_written) < 0) {
        free(w->data);
        free(w);
    }
}

/* Taken over before it runs: a fed connection's writer runs JS, which may write (and flush) more. */
static void flush_pending(void) {
    while (npending > 0) {
        int *ids = pending;
        size_t n = npending;
        pending = NULL;
        npending = pending_cap = 0;
        for (size_t i = 0; i < n; i++) {
            Conn *c = conn_of(ids[i]);
            if (c && c->queued) flush_conn(c);
        }
        free(ids);
    }
}

/* httpWrite(conn, data, latin1): corked until the current callback (and its microtasks) returns; a
 * string as UTF-8, or with latin1 a byte a character (its low byte), as Node writes a head */
JSValue js_host_http_write(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    Conn *c = argc > 0 && js_is_int32(argv[0]) ? conn_of(js_as_int32(argv[0])) : NULL;
    if (!c || argc < 2 || (c->id >= 0 && !js_net_stream(c->id))) return JS_FALSE;
    if (js_is_string(argv[1]) && argc > 2 && js_truthy(argv[2])) {
        JSStrView v = js_string_view(ctx, argv[1]);
        if (v.length == 0) return JS_TRUE;
        buf_reserve(&c->out, v.length);
        if (v.latin1) memcpy(c->out.v + c->out.n, v.chars, v.length);
        else for (uint32_t i = 0; i < v.length; i++) c->out.v[c->out.n + i] = (char)(js_view_at(v, i) & 0xff);
        c->out.n += v.length;
    } else if (js_is_string(argv[1])) {
        JSStrView v = js_string_view(ctx, argv[1]);
        size_t n = js_view_to_utf8(v, NULL, 0);
        if (n == 0) return JS_TRUE;
        buf_reserve(&c->out, n);
        js_view_to_utf8(v, c->out.v + c->out.n, n);
        c->out.n += n;
    } else {
        uint8_t *bytes;
        size_t n;
        if (!js_buffer_source_bytes(argv[1], &bytes, &n)) return js_throw_type_error(ctx, "httpWrite: a string or bytes expected");
        if (n == 0) return JS_TRUE;
        buf_append(&c->out, (const char *)bytes, n);
    }
    if (!c->queued) {
        if (npending == pending_cap) {
            pending_cap = pending_cap ? pending_cap * 2 : 64;
            int *p = realloc(pending, pending_cap * sizeof *p);
            if (!p) js_fatal("out of memory in http");
            pending = p;
        }
        pending[npending++] = c->id;
        c->queued = true;
    }
    return JS_TRUE;
}

/* httpFlush(conn): the corked output goes out now, ahead of what the socket writes next */
JSValue js_host_http_flush(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    Conn *c = argc > 0 && js_is_int32(argv[0]) ? conn_of(js_as_int32(argv[0])) : NULL;
    if (c && c->queued) flush_conn(c);
    return JS_UNDEFINED;
}

/* ---- Fed connections --------------------------------------------------------------------- */

/* httpFedOpen(writer) → conn: a connection whose bytes JS feeds */
JSValue js_host_http_fed_open(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    if (argc < 1 || !js_is_callable(argv[0])) return js_throw_type_error(ctx, "httpFedOpen: a writer expected");
    size_t k = 0;
    while (k < nfeds && feds[k]) k++;
    if (k == nfeds) {
        size_t n = nfeds ? nfeds * 2 : 16;
        Fed **v = realloc(feds, n * sizeof *v);
        if (!v) js_fatal("out of memory in http");
        memset(v + nfeds, 0, (n - nfeds) * sizeof *v);
        feds = v;
        nfeds = n;
    }
    Fed *f = calloc(1, sizeof *f);  /* by itself: its writer is a root at a fixed address */
    if (!f) js_fatal("out of memory in http");
    f->writer = argv[0];
    js_add_root(ctx->rt, &f->writer);
    feds[k] = f;
    return js_int32(-(int32_t)k - 1);
}

/* httpFeed(conn, bytes | null) → whether the parser took them; null: the input ended */
JSValue js_host_http_feed(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    Conn *c = argc > 0 && js_is_int32(argv[0]) && js_as_int32(argv[0]) < 0 ? conn_of(js_as_int32(argv[0])) : NULL;
    if (!c) return JS_FALSE;
    /* called from JS: the parser's callbacks run in it, so no microtask or nextTick runs between
     * two of them (a body and its end come in the same turn, as in Node) */
    if (argc < 2 || js_is_null(argv[1]) || js_is_undefined(argv[1])) {
        js_uv_nest(1);
        bool ok = parse_input(c, UV_EOF, NULL);
        js_uv_nest(-1);
        return js_bool(ok);
    }
    uint8_t *bytes;
    size_t n;
    if (!js_buffer_source_bytes(argv[1], &bytes, &n)) return js_throw_type_error(ctx, "httpFeed: bytes expected");
    if (n == 0) return JS_TRUE;
    js_uv_nest(1);
    bool ok = parse_input(c, (ssize_t)n, (const char *)bytes);
    js_uv_nest(-1);
    return js_bool(ok);
}

/* httpFedClose(conn): its parser and writer go */
JSValue js_host_http_fed_close(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    int id = argc > 0 && js_is_int32(argv[0]) ? js_as_int32(argv[0]) : 0;
    Fed *f = fed_of(id);
    if (!f) return JS_UNDEFINED;
    if (f->conn) release_conn(f->conn);
    feds[-(id + 1)] = NULL;
    js_remove_root(ctx->rt, &f->writer);
    free(f);
    return JS_UNDEFINED;
}

/* httpDate(): the Date header's value, IMF-fixdate, formatted once per second (as Node caches it) */
JSValue js_host_http_date(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    static time_t cached_at = -1;
    static char text[32];
    time_t now = time(NULL);
    if (now != cached_at) {
        static const char *const DAYS[] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
        static const char *const MONTHS[] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
        struct tm tm;
        gmtime_r(&now, &tm);
        snprintf(text, sizeof text, "%s, %02d %s %04d %02d:%02d:%02d GMT", DAYS[tm.tm_wday], tm.tm_mday, MONTHS[tm.tm_mon], tm.tm_year + 1900,
                 tm.tm_hour, tm.tm_min, tm.tm_sec);
        cached_at = now;
    }
    return js_new_string_latin1(ctx, (const uint8_t *)text, (uint32_t)strlen(text));
}
