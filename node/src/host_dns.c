/* Host primitives for dns.Resolver: c-ares channels on libuv's loop, as Node's cares_wrap drives
 * them (a poll handle for each socket c-ares opens, a timer while any is open). The prelude's
 * internal/dns_resolver.js is Node's lib/internal/dns over them. A query's answer comes back as
 * the bytes of the DNS message; dnsParse reads it with c-ares's parsers, as Node's do.
 *
 *   dnsChannel(timeoutMs, tries, maxTimeoutMs) → channel (a c-ares channel, freed with it)
 *   dnsQuery(channel, name, type, cb) → 0 | ARES_*: cb(status, answer | null)
 *   dnsReverse(channel, ip, cb) → 0 | -EINVAL: cb(status, [name, …] | null)
 *   dnsParse(answer, kind) → [status, records, ttls | undefined, cname]   (kind: a DNS type; 0x10000 + A: a CNAME
 *        or A; 0x10000 + SOA: ANY's SOA, none no error)
 *   dnsGetServers(channel) → [[ip, port], …]
 *   dnsSetServers(channel, [[family, ip, port], …]) → 0 | ARES_* | DNS_ESETSRVPENDING (queries pending)
 *   dnsSetLocalAddress(channel, ip4 | null, ip6 | null)
 *   dnsCancel(channel)
 *   dnsStrerror(status) → its message
 *
 * The callbacks are called from the loop, never inside a primitive (ares_cancel and ares_destroy
 * finish queries at once): finished queries wait for a zero timer, as Node's wait for an immediate. */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers: pthread_rwlock_t, struct addrinfo */
#include <stdlib.h>
#include <string.h>

#include <ares.h>

#include "js_buffer.h"
#include "js_exception.h"
#include "js_gc.h"
#include "js_node.h"
#include "js_object.h"
#include "js_ops.h"
#include "js_uv.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

#define HOST_FN(name) JSValue name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED (void)ctx, (void)callee, (void)this_val, (void)new_target
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

/* Node's: setServers while queries are pending */
#define DNS_ESETSRVPENDING (-1000)
#define KIND_CNAME_OR_A 0x10000
#define KIND_SOA_IN_ANY 0x10006

typedef struct Channel Channel;

/* a socket c-ares opened, polled */
typedef struct Task {
    uv_poll_t    poll;
    Channel     *channel;
    ares_socket_t sock;
    struct Task *next;
} Task;

/* the loop and runtime are the channel's: c-ares opens sockets inside a primitive too, where
 * js_uv_context() is null (it is set only while the loop runs callbacks) */
struct Channel {
    uv_loop_t      *loop;
    JSRuntime      *rt;
    ares_channel_t *ares;
    uv_timer_t     *timer;     /* while c-ares has sockets: its timeouts */
    Task           *tasks;
    int             timeout;
    int             active;    /* queries pending: the channel's object is a root while there are */
    JSValue         self;
};

typedef struct ChannelObject {
    JSObject obj;
    Channel *c;
} ChannelObject;

/* a query: its callback, and once finished its result, waiting to be delivered */
typedef struct Query {
    Channel      *channel;
    JSValue       cb;        /* a root */
    int           status;
    uint8_t      *answer;    /* malloc'd */
    size_t        answer_len;
    char        **names;     /* a reverse lookup's: NULL-terminated, malloc'd */
    struct Query *next;
} Query;

static Query *finished, **finished_tail = &finished;
static uv_timer_t deliver_timer;
static bool deliver_inited;

/* ---- the loop ------------------------------------------------------------------------------- */

static void on_ares_timeout(uv_timer_t *t) {
    Channel *c = t->data;
    ares_process_fd(c->ares, ARES_SOCKET_BAD, ARES_SOCKET_BAD);
}

static void on_poll(uv_poll_t *p, int status, int events) {
    Task *task = (Task *)p;
    Channel *c = task->channel;
    if (c->timer) uv_timer_again(c->timer);
    /* an error: as readable and writable, so c-ares finds it */
    if (status < 0) ares_process_fd(c->ares, task->sock, task->sock);
    else ares_process_fd(c->ares, events & UV_READABLE ? task->sock : ARES_SOCKET_BAD, events & UV_WRITABLE ? task->sock : ARES_SOCKET_BAD);
}

static void free_handle(uv_handle_t *h) { free(h); }

static void start_timer(Channel *c) {
    if (!c->timer) {
        c->timer = malloc(sizeof *c->timer);
        if (!c->timer) js_fatal("out of memory in dns");
        uv_timer_init(c->loop, c->timer);
        c->timer->data = c;
    } else if (uv_is_active((uv_handle_t *)c->timer)) {
        return;
    }
    /* c-ares's timeouts are checked at least once a second (Node's) */
    int timeout = c->timeout <= 0 || c->timeout > 1000 ? 1000 : c->timeout;
    uv_timer_start(c->timer, on_ares_timeout, timeout, timeout);
}

static void close_timer(Channel *c) {
    if (!c->timer) return;
    uv_close((uv_handle_t *)c->timer, free_handle);
    c->timer = NULL;
}

/* c-ares opened, changed or closed a socket */
static void on_sock_state(void *data, ares_socket_t sock, int read, int write) {
    Channel *c = data;
    Task **at = &c->tasks;
    while (*at && (*at)->sock != sock) at = &(*at)->next;
    Task *task = *at;
    if (read || write) {
        if (!task) {
            start_timer(c);
            task = calloc(1, sizeof *task);
            if (!task) js_fatal("out of memory in dns");
            task->channel = c;
            task->sock = sock;
            /* if this fails, the query times out */
            if (uv_poll_init_socket(c->loop, &task->poll, sock) < 0) {
                free(task);
                return;
            }
            task->next = c->tasks;
            c->tasks = task;
        }
        uv_poll_start(&task->poll, (read ? UV_READABLE : 0) | (write ? UV_WRITABLE : 0), on_poll);
    } else if (task) {
        *at = task->next;
        uv_close((uv_handle_t *)&task->poll, free_handle);
        if (!c->tasks) close_timer(c);
    }
}

/* ---- finished queries ----------------------------------------------------------------------- */

static void query_done(Channel *c) {
    if (--c->active == 0) js_remove_root(c->rt, &c->self);
}

static void on_deliver(uv_timer_t *t) {
    (void)t;
    JSContext *ctx = js_uv_context();
    Query *q = finished;
    finished = NULL;
    finished_tail = &finished;
    while (q) {
        Query *next = q->next;
        JSValue args[2] = { js_int32(q->status), JS_NULL };
        if (q->answer) {
            args[1] = js_new_buffer_from_bytes(ctx, q->answer, q->answer_len);
        } else if (q->names) {
            args[1] = js_new_array(ctx, 0);
            for (char **n = q->names; *n; n++) {
                if (js_array_append(ctx, args[1], js_new_string_cstr(ctx, *n)) < 0) js_fatal("out of memory in dns");
            }
        }
        JSValue cb = q->cb;
        js_remove_root(ctx->rt, &q->cb);
        free(q->answer);
        if (q->names) {
            for (char **n = q->names; *n; n++) free(*n);
            free(q->names);
        }
        free(q);
        (void)js_uv_call(cb, 2, args, NULL);
        q = next;
    }
}

static void finish(Query *q, int status) {
    q->status = status;
    query_done(q->channel);
    q->next = NULL;
    *finished_tail = q;
    finished_tail = &q->next;
    if (!deliver_inited) {
        uv_timer_init(q->channel->loop, &deliver_timer);
        uv_unref((uv_handle_t *)&deliver_timer);
        deliver_inited = true;
    }
    /* a zero timer: the next turn of the loop, which it keeps alive till then */
    uv_ref((uv_handle_t *)&deliver_timer);
    uv_timer_start(&deliver_timer, on_deliver, 0, 0);
}

static void on_answer(void *arg, ares_status_t status, size_t timeouts, const ares_dns_record_t *dnsrec) {
    (void)timeouts;
    Query *q = arg;
    if (status == ARES_SUCCESS && ares_dns_write(dnsrec, &q->answer, &q->answer_len) != ARES_SUCCESS) status = ARES_ENOMEM;
    finish(q, (int)status);
}

static void on_host(void *arg, int status, int timeouts, struct hostent *host) {
    (void)timeouts;
    Query *q = arg;
    if (status == ARES_SUCCESS && host) {
        size_t n = 0;
        while (host->h_aliases[n]) n++;
        q->names = calloc(n + 1, sizeof *q->names);
        if (!q->names) js_fatal("out of memory in dns");
        for (size_t i = 0; i < n; i++) {
            q->names[i] = strdup(host->h_aliases[i]);
            if (!q->names[i]) js_fatal("out of memory in dns");
        }
    }
    finish(q, status);
}

/* ---- channels ------------------------------------------------------------------------------- */

static void channel_finalize(JSRuntime *rt, JSCell *cell) {
    (void)rt;
    Channel *c = ((ChannelObject *)cell)->c;
    if (!c) return;
    /* no query is pending (they keep the object): this closes the sockets, through on_sock_state */
    ares_destroy(c->ares);
    close_timer(c);
    free(c);
}

static const JSClass channel_class = { "ChannelWrap", sizeof(ChannelObject), NULL, NULL, NULL, NULL, NULL, channel_finalize, NULL };

static Channel *channel_arg(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &channel_class ? ((ChannelObject *)js_as_object(v))->c : NULL;
}

/* Node's ChannelWrap::Setup: responses not checked (NOCHECKRESP), nothing cached */
HOST_FN(js_host_dns_channel) {
    UNUSED;
    static bool library_inited;
    if (!library_inited) {
        int r = ares_library_init(ARES_LIB_INIT_ALL);
        if (r != ARES_SUCCESS) return js_throw_type_error(ctx, ares_strerror(r));
        library_inited = true;
    }
    Channel *c = calloc(1, sizeof *c);
    if (!c) js_fatal("out of memory in dns");
    c->loop = js_uv_loop(ctx);
    c->rt = ctx->rt;
    c->timeout = js_is_number(ARG(0)) ? (int)js_as_number(ARG(0)) : -1;
    struct ares_options options = { 0 };
    options.flags = ARES_FLAG_NOCHECKRESP;
    options.sock_state_cb = on_sock_state;
    options.sock_state_cb_data = c;
    options.timeout = c->timeout;
    options.tries = js_is_number(ARG(1)) ? (int)js_as_number(ARG(1)) : 4;
    options.qcache_max_ttl = 0;
    int optmask = ARES_OPT_FLAGS | ARES_OPT_TIMEOUTMS | ARES_OPT_SOCK_STATE_CB | ARES_OPT_TRIES | ARES_OPT_QUERY_CACHE;
    int max_timeout = js_is_number(ARG(2)) ? (int)js_as_number(ARG(2)) : 0;
    if (max_timeout > 0) {
        options.maxtimeout = max_timeout;
        optmask |= ARES_OPT_MAXTIMEOUTMS;
    }
    int r = ares_init_options(&c->ares, &options, optmask);
    if (r != ARES_SUCCESS) {
        free(c);
        return js_throw_type_error(ctx, ares_strerror(r));
    }
    ChannelObject *o = (ChannelObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &channel_class, JS_NULL, 0));
    o->c = c;
    c->self = js_object_value(&o->obj);
    return c->self;
}

static Query *new_query(JSContext *ctx, Channel *c, JSValue cb) {
    Query *q = calloc(1, sizeof *q);
    if (!q) js_fatal("out of memory in dns");
    q->channel = c;
    q->cb = cb;
    js_add_root(ctx->rt, &q->cb);
    if (c->active++ == 0) js_add_root(ctx->rt, &c->self);
    return q;
}

static char *string_dup(JSContext *ctx, JSValue v) {
    if (!js_is_string(v)) return NULL;
    JSStrView view = js_string_view(ctx, v);
    size_t n = js_view_to_utf8(view, NULL, 0);
    char *s = malloc(n + 1);
    if (!s) js_fatal("out of memory in dns");
    js_view_to_utf8(view, s, n);
    s[n] = '\0';
    return s;
}

/* dnsQuery(channel, name, type, cb): the name as Node gives it, ASCII already (domainToASCII) */
HOST_FN(js_host_dns_query) {
    UNUSED;
    Channel *c = channel_arg(ARG(0));
    char *name = string_dup(ctx, ARG(1));
    if (!c || !name || !js_is_number(ARG(2))) {
        free(name);
        return js_throw_type_error(ctx, "dnsQuery: (channel, name, type, cb) expected");
    }
    Query *q = new_query(ctx, c, ARG(3));
    ares_query_dnsrec(c->ares, name, ARES_CLASS_IN, (ares_dns_rec_type_t)js_as_number(ARG(2)), on_answer, q, NULL);
    free(name);
    return js_int32(0);
}

HOST_FN(js_host_dns_reverse) {
    UNUSED;
    Channel *c = channel_arg(ARG(0));
    char ip[64];
    size_t n = js_is_string(ARG(1)) ? js_view_to_utf8(js_string_view(ctx, ARG(1)), ip, sizeof ip - 1) : 0;
    ip[n] = '\0';
    if (!c) return js_throw_type_error(ctx, "dnsReverse: (channel, ip, cb) expected");
    unsigned char addr[16];
    int family, length;
    if (uv_inet_pton(AF_INET, ip, addr) == 0) family = AF_INET, length = 4;
    else if (uv_inet_pton(AF_INET6, ip, addr) == 0) family = AF_INET6, length = 16;
    else return js_int32(UV_EINVAL);
    Query *q = new_query(ctx, c, ARG(2));
    ares_gethostbyaddr(c->ares, addr, length, family, on_host, q);
    return js_int32(0);
}

HOST_FN(js_host_dns_cancel) {
    UNUSED;
    Channel *c = channel_arg(ARG(0));
    if (c) ares_cancel(c->ares);
    return JS_UNDEFINED;
}

HOST_FN(js_host_dns_get_servers) {
    UNUSED;
    Channel *c = channel_arg(ARG(0));
    if (!c) return js_throw_type_error(ctx, "dnsGetServers: a channel expected");
    struct ares_addr_port_node *servers = NULL;
    ares_get_servers_ports(c->ares, &servers);
    JSValue out = js_new_array(ctx, 0);
    for (struct ares_addr_port_node *s = servers; s; s = s->next) {
        char ip[64] = "";
        uv_inet_ntop(s->family, &s->addr, ip, sizeof ip);
        JSValue items[2] = { js_new_string_cstr(ctx, ip), js_int32(s->udp_port) };
        if (js_array_append(ctx, out, js_new_array_from(ctx, items, 2)) < 0) js_fatal("out of memory in dns");
    }
    ares_free_data(servers);
    return out;
}

HOST_FN(js_host_dns_set_servers) {
    UNUSED;
    Channel *c = channel_arg(ARG(0));
    if (!c || !js_is_array(ARG(1))) return js_throw_type_error(ctx, "dnsSetServers: (channel, servers) expected");
    if (c->active) return js_int32(DNS_ESETSRVPENDING);
    uint32_t n = js_array_length(js_as_object(ARG(1)));
    if (n == 0) return js_int32(ares_set_servers(c->ares, NULL));
    struct ares_addr_port_node *servers = calloc(n, sizeof *servers);
    if (!servers) js_fatal("out of memory in dns");
    int err = 0;
    for (uint32_t i = 0; i < n && err == 0; i++) {
        JSValue e = js_get_value(ctx, ARG(1), js_index_key(i));
        JSValue family = js_get_value(ctx, e, js_index_key(0)), ipv = js_get_value(ctx, e, js_index_key(1)), port = js_get_value(ctx, e, js_index_key(2));
        char ip[64];
        size_t len = js_is_string(ipv) ? js_view_to_utf8(js_string_view(ctx, ipv), ip, sizeof ip - 1) : 0;
        ip[len] = '\0';
        struct ares_addr_port_node *s = &servers[i];
        s->udp_port = s->tcp_port = js_is_number(port) ? (int)js_as_number(port) : 53;
        s->family = js_is_number(family) && js_as_number(family) == 6 ? AF_INET6 : AF_INET;
        err = uv_inet_pton(s->family, ip, &s->addr);
        if (i > 0) servers[i - 1].next = s;
    }
    int r = err ? ARES_EBADSTR : ares_set_servers_ports(c->ares, servers);
    free(servers);
    return js_int32(r);
}

/* dnsSetLocalAddress(channel, ip4 | null, ip6 | null): the addresses queries are sent from (null: any) */
HOST_FN(js_host_dns_set_local_address) {
    UNUSED;
    Channel *c = channel_arg(ARG(0));
    if (!c) return js_throw_type_error(ctx, "dnsSetLocalAddress: a channel expected");
    char ip[64];
    unsigned char addr[16] = { 0 };
    size_t n = js_is_string(ARG(1)) ? js_view_to_utf8(js_string_view(ctx, ARG(1)), ip, sizeof ip - 1) : 0;
    ip[n] = '\0';
    ares_set_local_ip4(c->ares, n && uv_inet_pton(AF_INET, ip, addr) == 0 ? ((unsigned)addr[0] << 24 | addr[1] << 16 | addr[2] << 8 | addr[3]) : 0);
    memset(addr, 0, sizeof addr);
    n = js_is_string(ARG(2)) ? js_view_to_utf8(js_string_view(ctx, ARG(2)), ip, sizeof ip - 1) : 0;
    ip[n] = '\0';
    if (n) uv_inet_pton(AF_INET6, ip, addr);
    ares_set_local_ip6(c->ares, addr);
    return JS_UNDEFINED;
}

HOST_FN(js_host_dns_strerror) {
    UNUSED;
    int code = js_is_number(ARG(0)) ? (int)js_as_number(ARG(0)) : 0;
    return js_new_string_cstr(ctx, code == DNS_ESETSRVPENDING ? "There are pending queries." : ares_strerror(code));
}

/* ---- answers, as Node's parsers read them ---------------------------------------------------- */

static void append(JSContext *ctx, JSValue list, JSValue v) {
    if (js_array_append(ctx, list, v) < 0) js_fatal("out of memory in dns");
}

static JSValue array_of(JSContext *ctx, JSValue *items, uint32_t n) {
    return js_new_array_from(ctx, items, n);
}

static JSValue str(JSContext *ctx, const void *s) {
    return js_new_string_cstr(ctx, s ? (const char *)s : "");
}

/* the answers' count (Node's GetAnswerCountForTTLBuffer): the TTL buffer's size */
static int answer_count(const uint8_t *buf, size_t len) {
    if (len <= 7) return 256;
    int n = buf[6] << 8 | buf[7];
    return n == 0 ? 1 : n;
}

/* A, AAAA, CNAME, NS, PTR (Node's ParseGeneralReply), into records and ttls */
static int general(JSContext *ctx, const uint8_t *buf, int len, int kind, JSValue records, JSValue ttls, bool *cname) {
    struct hostent *host = NULL;
    int n = answer_count(buf, (size_t)len), status;
    int type = kind == KIND_CNAME_OR_A ? ARES_REC_TYPE_A : kind;
    void *addrttls = NULL;
    if (type == ARES_REC_TYPE_A || type == ARES_REC_TYPE_AAAA) {
        addrttls = calloc((size_t)n, type == ARES_REC_TYPE_A ? sizeof(struct ares_addrttl) : sizeof(struct ares_addr6ttl));
        if (!addrttls) js_fatal("out of memory in dns");
    }
    switch (type) {
        case ARES_REC_TYPE_A:
        case ARES_REC_TYPE_CNAME: status = ares_parse_a_reply(buf, len, &host, type == ARES_REC_TYPE_A ? addrttls : NULL, type == ARES_REC_TYPE_A ? &n : NULL); break;
        case ARES_REC_TYPE_AAAA: status = ares_parse_aaaa_reply(buf, len, &host, addrttls, &n); break;
        case ARES_REC_TYPE_NS: status = ares_parse_ns_reply(buf, len, &host); break;
        default: status = ares_parse_ptr_reply(buf, len, NULL, 0, AF_INET, &host); break;
    }
    if (status == ARES_SUCCESS) {
        /* a CNAME, or for CNAME-or-A one that has a name and an alias: the name */
        if (type == ARES_REC_TYPE_CNAME || (kind == KIND_CNAME_OR_A && host->h_name && host->h_aliases[0])) {
            *cname = true;
            append(ctx, records, str(ctx, host->h_name));
        } else if (type == ARES_REC_TYPE_NS || type == ARES_REC_TYPE_PTR) {
            for (char **a = host->h_aliases; *a; a++) append(ctx, records, str(ctx, *a));
        } else {
            char ip[64];
            for (char **a = host->h_addr_list; *a; a++) {
                uv_inet_ntop(host->h_addrtype, *a, ip, sizeof ip);
                append(ctx, records, str(ctx, ip));
            }
            for (int i = 0; i < n; i++) {
                int ttl = type == ARES_REC_TYPE_A ? ((struct ares_addrttl *)addrttls)[i].ttl : ((struct ares_addr6ttl *)addrttls)[i].ttl;
                append(ctx, ttls, js_number((double)(unsigned)ttl));
            }
        }
        ares_free_hostent(host);
    }
    free(addrttls);
    return status;
}

static int mx(JSContext *ctx, const uint8_t *buf, int len, JSValue records) {
    struct ares_mx_reply *start;
    int status = ares_parse_mx_reply(buf, len, &start);
    if (status != ARES_SUCCESS) return status;
    for (struct ares_mx_reply *r = start; r; r = r->next) {
        JSValue items[2] = { js_int32(r->priority), str(ctx, r->host) };
        append(ctx, records, array_of(ctx, items, 2));
    }
    ares_free_data(start);
    return status;
}

/* each record's strings (a record may be several) */
static int txt(JSContext *ctx, const uint8_t *buf, int len, JSValue records) {
    struct ares_txt_ext *start;
    int status = ares_parse_txt_reply_ext(buf, len, &start);
    if (status != ARES_SUCCESS) return status;
    JSValue chunks = JS_UNDEFINED;
    for (struct ares_txt_ext *r = start; r; r = r->next) {
        if (r->record_start || js_is_undefined(chunks)) {
            chunks = js_new_array(ctx, 0);
            append(ctx, records, chunks);
        }
        append(ctx, chunks, js_new_string_latin1(ctx, (const uint8_t *)r->txt, r->length));
    }
    ares_free_data(start);
    return status;
}

static int srv(JSContext *ctx, const uint8_t *buf, int len, JSValue records) {
    struct ares_srv_reply *start;
    int status = ares_parse_srv_reply(buf, len, &start);
    if (status != ARES_SUCCESS) return status;
    for (struct ares_srv_reply *r = start; r; r = r->next) {
        JSValue items[4] = { str(ctx, r->host), js_int32(r->port), js_int32(r->priority), js_int32(r->weight) };
        append(ctx, records, array_of(ctx, items, 4));
    }
    ares_free_data(start);
    return status;
}

static int naptr(JSContext *ctx, const uint8_t *buf, int len, JSValue records) {
    struct ares_naptr_reply *start;
    int status = ares_parse_naptr_reply(buf, len, &start);
    if (status != ARES_SUCCESS) return status;
    for (struct ares_naptr_reply *r = start; r; r = r->next) {
        JSValue items[6] = { str(ctx, r->flags), str(ctx, r->service), str(ctx, r->regexp), str(ctx, r->replacement), js_int32(r->order),
                             js_int32(r->preference) };
        append(ctx, records, array_of(ctx, items, 6));
    }
    ares_free_data(start);
    return status;
}

static int soa(JSContext *ctx, const uint8_t *buf, int len, JSValue records) {
    struct ares_soa_reply *r;
    int status = ares_parse_soa_reply(buf, len, &r);
    if (status != ARES_SUCCESS) return status;
    JSValue items[7] = { str(ctx, r->nsname), str(ctx, r->hostmaster), js_number(r->serial), js_number(r->refresh), js_number(r->retry),
                         js_number(r->expire), js_number(r->minttl) };
    append(ctx, records, array_of(ctx, items, 7));
    ares_free_data(r);
    return status;
}

/* ANY's SOA (Node's ParseSoaReply): the answer's last SOA, none being no error */
static int soa_any(JSContext *ctx, const uint8_t *buf, int len, JSValue records) {
    ares_dns_record_t *rec = NULL;
    if (ares_dns_parse(buf, (size_t)len, 0, &rec) != ARES_SUCCESS) {
        ares_dns_record_destroy(rec);
        return ARES_EBADRESP;
    }
    const ares_dns_rr_t *found = NULL;
    size_t n = ares_dns_record_rr_cnt(rec, ARES_SECTION_ANSWER);
    for (size_t i = 0; i < n; i++) {
        const ares_dns_rr_t *rr = ares_dns_record_rr_get(rec, ARES_SECTION_ANSWER, i);
        if (ares_dns_rr_get_type(rr) == ARES_REC_TYPE_SOA) found = rr;
    }
    if (found) {
        JSValue items[7] = { str(ctx, ares_dns_rr_get_str(found, ARES_RR_SOA_MNAME)), str(ctx, ares_dns_rr_get_str(found, ARES_RR_SOA_RNAME)),
                             js_number(ares_dns_rr_get_u32(found, ARES_RR_SOA_SERIAL)), js_number(ares_dns_rr_get_u32(found, ARES_RR_SOA_REFRESH)),
                             js_number(ares_dns_rr_get_u32(found, ARES_RR_SOA_RETRY)), js_number(ares_dns_rr_get_u32(found, ARES_RR_SOA_EXPIRE)),
                             js_number(ares_dns_rr_get_u32(found, ARES_RR_SOA_MINIMUM)) };
        append(ctx, records, array_of(ctx, items, 7));
    }
    ares_dns_record_destroy(rec);
    return ARES_SUCCESS;
}

static int caa(JSContext *ctx, const uint8_t *buf, int len, JSValue records) {
    struct ares_caa_reply *start;
    int status = ares_parse_caa_reply(buf, len, &start);
    if (status != ARES_SUCCESS) return status;
    for (struct ares_caa_reply *r = start; r; r = r->next) {
        JSValue items[3] = { js_int32(r->critical), js_new_string_latin1(ctx, (const uint8_t *)r->property, r->plength),
                             js_new_string_latin1(ctx, (const uint8_t *)r->value, r->length) };
        append(ctx, records, array_of(ctx, items, 3));
    }
    ares_free_data(start);
    return status;
}

/* TLSA, from the parsed message (c-ares has no legacy parser for it), as Node's */
static int tlsa(JSContext *ctx, const uint8_t *buf, int len, JSValue records) {
    ares_dns_record_t *rec = NULL;
    int status = ares_dns_parse(buf, (size_t)len, 0, &rec);
    if (status != ARES_SUCCESS) {
        ares_dns_record_destroy(rec);
        return status;
    }
    size_t n = ares_dns_record_rr_cnt(rec, ARES_SECTION_ANSWER);
    for (size_t i = 0; i < n; i++) {
        const ares_dns_rr_t *rr = ares_dns_record_rr_get(rec, ARES_SECTION_ANSWER, i);
        if (ares_dns_rr_get_type(rr) != ARES_REC_TYPE_TLSA) continue;
        size_t data_len;
        const unsigned char *data = ares_dns_rr_get_bin(rr, ARES_RR_TLSA_DATA, &data_len);
        if (!data || data_len == 0) continue;
        JSValue items[4] = { js_int32(ares_dns_rr_get_u8(rr, ARES_RR_TLSA_CERT_USAGE)), js_int32(ares_dns_rr_get_u8(rr, ARES_RR_TLSA_SELECTOR)),
                             js_int32(ares_dns_rr_get_u8(rr, ARES_RR_TLSA_MATCH)), js_new_buffer_from_bytes(ctx, data, data_len) };
        append(ctx, records, array_of(ctx, items, 4));
    }
    ares_dns_record_destroy(rec);
    return ARES_SUCCESS;
}

HOST_FN(js_host_dns_parse) {
    UNUSED;
    uint8_t *buf;
    size_t len;
    if (!js_buffer_source_bytes(ARG(0), &buf, &len) || !js_is_number(ARG(1))) return js_throw_type_error(ctx, "dnsParse: (answer, kind) expected");
    int kind = (int)js_as_number(ARG(1));
    JSValue records = js_new_array(ctx, 0), ttls = js_new_array(ctx, 0);
    bool cname = false;
    int status;
    switch (kind) {
        case ARES_REC_TYPE_MX: status = mx(ctx, buf, (int)len, records); break;
        case ARES_REC_TYPE_TXT: status = txt(ctx, buf, (int)len, records); break;
        case ARES_REC_TYPE_SRV: status = srv(ctx, buf, (int)len, records); break;
        case ARES_REC_TYPE_NAPTR: status = naptr(ctx, buf, (int)len, records); break;
        case ARES_REC_TYPE_SOA: status = soa(ctx, buf, (int)len, records); break;
        case KIND_SOA_IN_ANY: status = soa_any(ctx, buf, (int)len, records); break;
        case ARES_REC_TYPE_CAA: status = caa(ctx, buf, (int)len, records); break;
        case ARES_REC_TYPE_TLSA: status = tlsa(ctx, buf, (int)len, records); break;
        default: status = general(ctx, buf, (int)len, kind, records, ttls, &cname); break;
    }
    JSValue items[4] = { js_int32(status), records, ttls, js_bool(cname) };
    return js_new_array_from(ctx, items, 4);
}
