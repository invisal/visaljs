/* Host primitives for node:dgram: UDP handles on libuv, the calls Node's UDPWrap makes. The
 * prelude's internal/udp.js is Node's UDP binding over them, and dgram.js Node's own. Handles are
 * numbered; each has one JS callback (a root), called as cb(event, …) from the loop:
 *
 *   UDP_MESSAGE  cb(0, bytes, address, family, port): a datagram (a Uint8Array); or cb(0, -errno)
 *   UDP_SENT     cb(1, status, bytes): the oldest pending send finished (in order)
 *   UDP_CLOSE    cb(2): the handle is closed and its id free
 *
 *   udpOpen(cb) → id
 *   udpOpenFd(id, fd), udpFd(id) → fd | -errno
 *   udpBind(id, ip, port, flags), udpConnect(id, ip, port), udpDisconnect(id) → 0 | -errno
 *        flags: libuv's (UV_UDP_IPV6ONLY 1, UV_UDP_REUSEADDR 4, UV_UDP_REUSEPORT 64)
 *   udpSend(id, [bytes, …], ip | null, port) → length + 1 (sent now) | 0 (a UDP_SENT follows) | -errno
 *   udpRecvStart(id), udpRecvStop(id) → 0 | -errno
 *   udpAddress(id, peer) → [address, family, port] | -errno
 *   udpSetBroadcast(id, on), udpSetTTL(id, ttl), udpSetMulticastTTL(id, ttl), udpSetMulticastLoopback(id, on),
 *   udpSetMulticastInterface(id, ip), udpMembership(id, group, iface | null, join),
 *   udpSourceMembership(id, source, group, iface | null, join) → 0 | -errno
 *   udpBufferSize(id, size, recv) → size | -errno   (size 0 reads it)
 *   udpSendQueue(id, count) → bytes | requests waiting to go out
 *   udpClose(id), udpRef(id, ref), udpHasRef(id) → bool */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers: pthread_rwlock_t, struct addrinfo */
#include <stdlib.h>
#include <string.h>

#include "js_buffer.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_gc.h"
#include "js_node.h"
#include "js_ops.h"
#include "js_uv.h"
#include "jscontext.h"
#include "jsstring.h"

enum { UDP_MESSAGE, UDP_SENT, UDP_CLOSE };

typedef struct UdpHandle {
    uv_udp_t udp;
    int      id;
    bool     closing;
    JSValue  cb;  /* a root */
} UdpHandle;

static UdpHandle **handles;
static size_t nhandles;

static void emit(UdpHandle *h, uint32_t argc, JSValue *args) {
    if (js_is_callable(h->cb)) (void)js_uv_call(h->cb, argc, args, NULL);
}

static UdpHandle *open_handle(int32_t id) {
    UdpHandle *h = id >= 0 && (size_t)id < nhandles ? handles[id] : NULL;
    return h && !h->closing ? h : NULL;
}

static UdpHandle *handle_arg(uint32_t argc, const JSValue *argv) {
    return argc > 0 && js_is_int32(argv[0]) ? open_handle(js_as_int32(argv[0])) : NULL;
}

static size_t string_arg(JSContext *ctx, JSValue v, char *buf, size_t size) {
    size_t n = js_is_string(v) ? js_view_to_utf8(js_string_view(ctx, v), buf, size - 1) : 0;
    buf[n] = '\0';
    return n;
}

static int sockaddr_arg(JSContext *ctx, JSValue ip, JSValue port, struct sockaddr_storage *addr) {
    char host[64];
    string_arg(ctx, ip, host, sizeof host);
    int p = js_is_int32(port) ? js_as_int32(port) : 0;
    return strchr(host, ':') ? uv_ip6_addr(host, p, (struct sockaddr_in6 *)addr) : uv_ip4_addr(host, p, (struct sockaddr_in *)addr);
}

static int32_t int_arg(uint32_t argc, const JSValue *argv, uint32_t i) {
    return argc > i && js_is_number(argv[i]) ? (int32_t)js_as_number(argv[i]) : 0;
}

/* [address, family, port] of a socket address */
static JSValue address_value(JSContext *ctx, const struct sockaddr *sa) {
    char ip[64] = "";
    int port = 0;
    const char *family = "IPv4";
    if (sa->sa_family == AF_INET6) {
        const struct sockaddr_in6 *a = (const struct sockaddr_in6 *)sa;
        uv_ip6_name(a, ip, sizeof ip);
        port = ntohs(a->sin6_port);
        family = "IPv6";
    } else {
        const struct sockaddr_in *a = (const struct sockaddr_in *)sa;
        uv_ip4_name(a, ip, sizeof ip);
        port = ntohs(a->sin_port);
    }
    JSValue out = js_new_array(ctx, 3);
    if (js_array_append(ctx, out, js_new_string_cstr(ctx, ip)) < 0 || js_array_append(ctx, out, js_new_string_cstr(ctx, family)) < 0 ||
        js_array_append(ctx, out, js_int32(port)) < 0)
        js_fatal("out of memory in dgram");
    return out;
}

#define HOST_FN(name) JSValue name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED (void)ctx, (void)callee, (void)this_val, (void)new_target

/* ---- Handles ----------------------------------------------------------------------------------- */

HOST_FN(js_host_udp_open) {
    UNUSED;
    UdpHandle *h = calloc(1, sizeof *h);
    if (!h) js_fatal("out of memory in dgram");
    uv_udp_init(js_uv_loop(ctx), &h->udp);
    size_t id = 0;
    while (id < nhandles && handles[id]) id++;
    if (id == nhandles) {
        size_t n = nhandles ? nhandles * 2 : 8;
        UdpHandle **v = realloc(handles, n * sizeof *v);
        if (!v) js_fatal("out of memory in dgram");
        memset(v + nhandles, 0, (n - nhandles) * sizeof *v);
        handles = v;
        nhandles = n;
    }
    handles[id] = h;
    h->id = (int)id;
    h->cb = argc > 0 ? argv[0] : JS_UNDEFINED;
    js_add_root(ctx->rt, &h->cb);
    return js_int32(h->id);
}

static void on_closed(uv_handle_t *uh) {
    UdpHandle *h = (UdpHandle *)uh;
    handles[h->id] = NULL;
    JSValue args[1] = { js_int32(UDP_CLOSE) };
    emit(h, 1, args);
    js_remove_root(js_uv_context()->rt, &h->cb);
    free(h);
}

HOST_FN(js_host_udp_close) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (h) {
        h->closing = true;
        uv_close((uv_handle_t *)&h->udp, on_closed);
    }
    return JS_UNDEFINED;
}

HOST_FN(js_host_udp_open_fd) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h || argc < 2 || !js_is_int32(argv[1])) return js_int32(UV_EBADF);
    return js_int32(uv_udp_open(&h->udp, (uv_os_sock_t)js_as_int32(argv[1])));
}

HOST_FN(js_host_udp_fd) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
#ifdef _WIN32
    return js_int32(-1);
#else
    uv_os_fd_t fd;
    int r = uv_fileno((uv_handle_t *)&h->udp, &fd);
    return js_int32(r < 0 ? r : fd);
#endif
}

HOST_FN(js_host_udp_ref) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (h && argc > 1) {
        if (js_truthy(argv[1])) uv_ref((uv_handle_t *)&h->udp);
        else uv_unref((uv_handle_t *)&h->udp);
    }
    return JS_UNDEFINED;
}

HOST_FN(js_host_udp_has_ref) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    return js_bool(h && uv_has_ref((uv_handle_t *)&h->udp));
}

/* ---- Binding and connecting -------------------------------------------------------------------- */

HOST_FN(js_host_udp_bind) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h || argc < 2) return js_int32(UV_EBADF);
    struct sockaddr_storage addr;
    int r = sockaddr_arg(ctx, argv[1], argc > 2 ? argv[2] : JS_UNDEFINED, &addr);
    if (r < 0) return js_int32(r);
    return js_int32(uv_udp_bind(&h->udp, (const struct sockaddr *)&addr, (unsigned)int_arg(argc, argv, 3)));
}

HOST_FN(js_host_udp_connect) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h || argc < 2) return js_int32(UV_EBADF);
    struct sockaddr_storage addr;
    int r = sockaddr_arg(ctx, argv[1], argc > 2 ? argv[2] : JS_UNDEFINED, &addr);
    if (r < 0) return js_int32(r);
    return js_int32(uv_udp_connect(&h->udp, (const struct sockaddr *)&addr));
}

HOST_FN(js_host_udp_disconnect) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    return js_int32(h ? uv_udp_connect(&h->udp, NULL) : UV_EBADF);
}

HOST_FN(js_host_udp_address) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    struct sockaddr_storage addr;
    int len = sizeof addr;
    int r = argc > 1 && js_truthy(argv[1]) ? uv_udp_getpeername(&h->udp, (struct sockaddr *)&addr, &len)
                                           : uv_udp_getsockname(&h->udp, (struct sockaddr *)&addr, &len);
    return r < 0 ? js_int32(r) : address_value(ctx, (const struct sockaddr *)&addr);
}

/* ---- Sending ----------------------------------------------------------------------------------- */

typedef struct SendReq {
    uv_udp_send_t req;
    size_t        length;
    char          data[];
} SendReq;

static void on_sent(uv_udp_send_t *req, int status) {
    UdpHandle *h = (UdpHandle *)req->handle;
    SendReq *s = (SendReq *)req;
    JSValue args[3] = { js_int32(UDP_SENT), js_int32(status), js_number((double)s->length) };
    free(s);
    emit(h, 3, args);
}

/* udpSend(id, chunks, ip | null, port): as Node's UDPWrap::DoSend, tried at once (length + 1 when it
 * all went), else queued with a copy of the bytes */
HOST_FN(js_host_udp_send) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h || argc < 2 || !js_is_object(argv[1])) return js_int32(UV_EBADF);
    struct sockaddr_storage addr;
    const struct sockaddr *to = NULL;
    if (argc > 2 && js_is_string(argv[2])) {
        int r = sockaddr_arg(ctx, argv[2], argc > 3 ? argv[3] : JS_UNDEFINED, &addr);
        if (r < 0) return js_int32(r);
        to = (const struct sockaddr *)&addr;
    }
    uint32_t count = js_array_length(js_as_object(argv[1]));
    uv_buf_t small[8];
    uv_buf_t *bufs = count <= 8 ? small : malloc(count * sizeof *bufs);
    if (!bufs) js_fatal("out of memory in dgram");
    size_t total = 0;
    for (uint32_t i = 0; i < count; i++) {
        JSValue chunk = js_get_index(ctx, argv[1], js_int32((int32_t)i));
        uint8_t *p;
        size_t n;
        if (!js_buffer_source_bytes(chunk, &p, &n)) {
            if (bufs != small) free(bufs);
            return js_throw_type_error(ctx, "udpSend: bytes expected");
        }
        bufs[i] = uv_buf_init((char *)p, (unsigned)n);
        total += n;
    }
    int r = uv_udp_try_send(&h->udp, bufs, count, to);
    if (r >= 0 && (size_t)r == total) {
        if (bufs != small) free(bufs);
        return js_number((double)total + 1);
    }
    if (r < 0 && r != UV_EAGAIN && r != UV_ENOSYS) {
        if (bufs != small) free(bufs);
        return js_int32(r);
    }
    /* a datagram goes whole or not at all: a partial r doesn't happen, queue all of it */
    SendReq *s = malloc(sizeof *s + (total ? total : 1));
    if (!s) js_fatal("out of memory in dgram");
    s->length = total;
    size_t off = 0;
    for (uint32_t i = 0; i < count; i++) {
        memcpy(s->data + off, bufs[i].base, bufs[i].len);
        off += bufs[i].len;
    }
    if (bufs != small) free(bufs);
    uv_buf_t one = uv_buf_init(s->data, (unsigned)total);
    r = uv_udp_send(&s->req, &h->udp, &one, 1, to, on_sent);
    if (r < 0) {
        free(s);
        return js_int32(r);
    }
    return js_int32(0);
}

HOST_FN(js_host_udp_send_queue) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(0);
    return js_number((double)(argc > 1 && js_truthy(argv[1]) ? uv_udp_get_send_queue_count(&h->udp) : uv_udp_get_send_queue_size(&h->udp)));
}

/* ---- Receiving --------------------------------------------------------------------------------- */

static void on_alloc(uv_handle_t *uh, size_t suggested, uv_buf_t *buf) {
    (void)uh;
    buf->base = malloc(suggested);
    buf->len = buf->base ? suggested : 0;
}

static void on_recv(uv_udp_t *u, ssize_t n, const uv_buf_t *buf, const struct sockaddr *addr, unsigned flags) {
    (void)flags;
    UdpHandle *h = (UdpHandle *)u;
    if (n == 0 && addr == NULL) {  /* nothing more to read for now */
        free(buf->base);
        return;
    }
    JSContext *ctx = js_uv_context();
    if (n < 0) {
        free(buf->base);
        JSValue args[2] = { js_int32(UDP_MESSAGE), js_int32((int32_t)n) };
        emit(h, 2, args);
        return;
    }
    JSValue chunk = js_new_uint8_array(ctx, (size_t)n);
    if (js_is_exception(chunk)) js_fatal("out of memory in dgram");
    uint8_t *data;
    size_t len;
    js_buffer_source_bytes(chunk, &data, &len);
    memcpy(data, buf->base, (size_t)n);
    free(buf->base);
    JSValue args[3] = { js_int32(UDP_MESSAGE), chunk, address_value(ctx, addr) };
    emit(h, 3, args);
}

HOST_FN(js_host_udp_recv_start) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    int r = uv_udp_recv_start(&h->udp, on_alloc, on_recv);
    return js_int32(r == UV_EALREADY ? 0 : r);  /* as Node's: starting twice is fine */
}

HOST_FN(js_host_udp_recv_stop) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    return js_int32(h ? uv_udp_recv_stop(&h->udp) : UV_EBADF);
}

/* ---- Options ----------------------------------------------------------------------------------- */

HOST_FN(js_host_udp_set_broadcast) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    return js_int32(h ? uv_udp_set_broadcast(&h->udp, int_arg(argc, argv, 1)) : UV_EBADF);
}

HOST_FN(js_host_udp_set_ttl) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    return js_int32(h ? uv_udp_set_ttl(&h->udp, int_arg(argc, argv, 1)) : UV_EBADF);
}

HOST_FN(js_host_udp_set_multicast_ttl) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    return js_int32(h ? uv_udp_set_multicast_ttl(&h->udp, int_arg(argc, argv, 1)) : UV_EBADF);
}

HOST_FN(js_host_udp_set_multicast_loopback) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    return js_int32(h ? uv_udp_set_multicast_loop(&h->udp, int_arg(argc, argv, 1)) : UV_EBADF);
}

HOST_FN(js_host_udp_set_multicast_interface) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    char iface[64];
    string_arg(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, iface, sizeof iface);
    return js_int32(uv_udp_set_multicast_interface(&h->udp, iface));
}

HOST_FN(js_host_udp_membership) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    char group[64], iface[64];
    string_arg(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, group, sizeof group);
    bool has_iface = argc > 2 && js_is_string(argv[2]);
    if (has_iface) string_arg(ctx, argv[2], iface, sizeof iface);
    return js_int32(uv_udp_set_membership(&h->udp, group, has_iface ? iface : NULL,
                                          argc > 3 && js_truthy(argv[3]) ? UV_JOIN_GROUP : UV_LEAVE_GROUP));
}

HOST_FN(js_host_udp_source_membership) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    char source[64], group[64], iface[64];
    string_arg(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, source, sizeof source);
    string_arg(ctx, argc > 2 ? argv[2] : JS_UNDEFINED, group, sizeof group);
    bool has_iface = argc > 3 && js_is_string(argv[3]);
    if (has_iface) string_arg(ctx, argv[3], iface, sizeof iface);
    return js_int32(uv_udp_set_source_membership(&h->udp, group, has_iface ? iface : NULL, source,
                                                 argc > 4 && js_truthy(argv[4]) ? UV_JOIN_GROUP : UV_LEAVE_GROUP));
}

/* udpBufferSize(id, size, recv): the kernel's buffer size, set when size isn't 0 (Linux reports it
 * doubled, as Node shows it) */
HOST_FN(js_host_udp_buffer_size) {
    UNUSED;
    UdpHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    int size = int_arg(argc, argv, 1);
    int r = argc > 2 && js_truthy(argv[2]) ? uv_recv_buffer_size((uv_handle_t *)&h->udp, &size)
                                           : uv_send_buffer_size((uv_handle_t *)&h->udp, &size);
    return js_int32(r < 0 ? r : size);
}
