/* Host primitives for node:net and dns.lookup: TCP and pipe (Unix domain socket) handles on
 * libuv, and getaddrinfo. The prelude's net.js builds Node's Server and Socket over them, with
 * the calls Node's own TCPWrap and PipeWrap make: open a handle, then bind and listen, or
 * connect. Handles are numbered; each has one JS callback (a root), called as cb(event, value)
 * from the loop:
 *
 *   NET_CONNECTION  a server accepted a connection: value is its handle id, or -errno
 *   NET_READ        bytes arrived (a Uint8Array), or -errno (UV_EOF at the end)
 *   NET_CONNECT     netConnect finished: 0 or -errno
 *   NET_WRITE       a pending write finished (in order): 0 or -errno
 *   NET_SHUTDOWN    netShutdown finished: 0 or -errno
 *   NET_CLOSE       the handle is closed (netClose or netReset) and its id free
 *
 *   netOpen(pipe, cb) → id                     a TCP handle, or with `pipe` a pipe's
 *   netOpenFd(id, fd) → 0 | -errno, netFd(id) → fd | -errno              netGuessHandle(fd) → "TCP" | "PIPE" | "TTY" | …
 *   netBind(id, ip | path, port, flags), netListen(id, backlog) → 0 | -errno   flags: 1 ipv6Only, 2 reusePort
 *   netChmod(id, mode) → 0 | -errno            a listening pipe's: 1 readable, 2 writable by all
 *   netConnect(id, ip | path, port) → 0 | -errno (a NET_CONNECT follows)
 *   netCallback(id, cb)                         an accepted handle's
 *   netReadStart(id), netReadStop(id) → 0 | -errno
 *   netWrite(id, bytes) → 0 written, 1 pending (a NET_WRITE follows) | -errno
 *   netShutdown(id), netClose(id), netReset(id) → 0 | -errno, netRef(id, ref)
 *   netAddress(id, peer) → [address, family, port] | path | -errno
 *   netNoDelay(id, on), netKeepAlive(id, on, seconds) → 0 | -errno
 *   netTypeOfService(id, tos) → 0 | -errno, and with tos -1 the socket's → tos | -errno
 *   ttyOpen(fd, cb) → id | -errno               a terminal's handle (node:tty's ReadStream), read as
 *                                                a stream; it answers the pipe-only calls as a pipe
 *   ttySetRawMode(id, raw) → 0 | -errno
 *   dnsLookup(host, family, cb) → cb(errno, code, [[address, family], …]) */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers: pthread_rwlock_t, struct addrinfo */
#ifdef __APPLE__
#define _DARWIN_C_SOURCE  /* IP_TOS, which _POSIX_C_SOURCE hides on macOS */
#endif
#include <errno.h>
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

enum { NET_CONNECTION, NET_READ, NET_CONNECT, NET_WRITE, NET_SHUTDOWN, NET_CLOSE };

typedef struct NetHandle {
    union {
        uv_handle_t handle;
        uv_stream_t stream;
        uv_tcp_t    tcp;
        uv_pipe_t   pipe;
        uv_tty_t    tty;
    } u;
    int     id;
    bool    is_pipe;  /* a pipe's, or a terminal's (it has no address, nor TCP's options) */
    bool    is_tty;
    const JSNetHook *hook;  /* node:http's parser, which reads before JS */
    void   *hook_data;
    bool    closing;
    JSValue cb;  /* a root */
} NetHandle;

static NetHandle **handles;
static size_t nhandles;

static void emit(NetHandle *h, int event, JSValue value) {
    if (!js_is_callable(h->cb)) return;
    JSValue args[2] = { js_int32(event), value };
    (void)js_uv_call(h->cb, 2, args, NULL);
}

/* An initialized handle, numbered, with its callback. */
static NetHandle *add_handle(JSContext *ctx, NetHandle *h, JSValue cb) {
    size_t id = 0;
    while (id < nhandles && handles[id]) id++;
    if (id == nhandles) {
        size_t n = nhandles ? nhandles * 2 : 16;
        NetHandle **v = realloc(handles, n * sizeof *v);
        if (!v) js_fatal("out of memory in net");
        memset(v + nhandles, 0, (n - nhandles) * sizeof *v);
        handles = v;
        nhandles = n;
    }
    handles[id] = h;
    h->id = (int)id;
    h->cb = cb;
    js_add_root(ctx->rt, &h->cb);
    return h;
}

static NetHandle *new_handle(JSContext *ctx, bool is_pipe, JSValue cb) {
    NetHandle *h = calloc(1, sizeof *h);
    if (!h) js_fatal("out of memory in net");
    h->is_pipe = is_pipe;
    if (is_pipe) uv_pipe_init(js_uv_loop(ctx), &h->u.pipe, 0);
    else uv_tcp_init(js_uv_loop(ctx), &h->u.tcp);
    return add_handle(ctx, h, cb);
}

static void on_closed(uv_handle_t *uh) {
    NetHandle *h = (NetHandle *)uh;
    handles[h->id] = NULL;
    if (h->hook) h->hook->close(h->hook_data);
    emit(h, NET_CLOSE, JS_UNDEFINED);
    js_remove_root(js_uv_context()->rt, &h->cb);
    free(h);
}

static void close_handle(NetHandle *h) {
    if (h->closing) return;
    h->closing = true;
    uv_close(&h->u.handle, on_closed);
}

static NetHandle *open_handle(int32_t id) {
    NetHandle *h = id >= 0 && (size_t)id < nhandles ? handles[id] : NULL;
    return h && !h->closing ? h : NULL;
}

uv_stream_t *js_net_stream(int id) {
    NetHandle *h = open_handle(id);
    return h ? &h->u.stream : NULL;
}

bool js_net_hook(int id, const JSNetHook *hook, void *data) {
    /* a hook is set on an open socket, but taken off a closing one too: its close calls the hook,
     * whose data (node:http's parser) may be freed by then */
    NetHandle *h = hook ? open_handle(id) : (id >= 0 && (size_t)id < nhandles ? handles[id] : NULL);
    if (!h) return false;
    h->hook = hook;
    h->hook_data = data;
    return true;
}

static NetHandle *handle_arg(uint32_t argc, const JSValue *argv) {
    return argc > 0 && js_is_int32(argv[0]) ? open_handle(js_as_int32(argv[0])) : NULL;
}

/* A string argument as UTF-8 in buf. */
static size_t string_arg(JSContext *ctx, JSValue v, char *buf, size_t size) {
    size_t n = js_is_string(v) ? js_view_to_utf8(js_string_view(ctx, v), buf, size - 1) : 0;
    buf[n] = '\0';
    return n;
}

/* An IP address and port; -errno for an address that isn't one. */
static int sockaddr_arg(JSContext *ctx, JSValue ip, JSValue port, struct sockaddr_storage *addr) {
    char host[64];
    string_arg(ctx, ip, host, sizeof host);
    int p = js_is_int32(port) ? js_as_int32(port) : 0;
    return strchr(host, ':') ? uv_ip6_addr(host, p, (struct sockaddr_in6 *)addr) : uv_ip4_addr(host, p, (struct sockaddr_in *)addr);
}

#define HOST_FN(name) JSValue name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED (void)ctx, (void)callee, (void)this_val, (void)new_target

/* ---- Handles, servers, connecting --------------------------------------------------------- */

#define PATH_MAX_LEN 4096

/* netOpen(pipe, cb) → id */
HOST_FN(js_host_net_open) {
    UNUSED;
    return js_int32(new_handle(ctx, argc > 0 && js_truthy(argv[0]), argc > 1 ? argv[1] : JS_UNDEFINED)->id);
}

/* netGuessHandle(fd) → what the descriptor is: "TCP", "PIPE", "TTY", "UDP", "FILE" or "UNKNOWN" */
HOST_FN(js_host_net_guess_handle) {
    UNUSED;
    int fd = argc > 0 && js_is_int32(argv[0]) ? js_as_int32(argv[0]) : -1;
    const char *type = "UNKNOWN";
    if (fd >= 0) {
        switch (uv_guess_handle(fd)) {
        case UV_TCP: type = "TCP"; break;
        case UV_NAMED_PIPE: type = "PIPE"; break;
        case UV_TTY: type = "TTY"; break;
        case UV_UDP: type = "UDP"; break;
        case UV_FILE: type = "FILE"; break;
        default: break;
        }
    }
    return js_new_string_cstr(ctx, type);
}

/* netOpenFd(id, fd): the handle takes over an open descriptor */
HOST_FN(js_host_net_open_fd) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h || argc < 2 || !js_is_int32(argv[1])) return js_int32(UV_EBADF);
    int fd = js_as_int32(argv[1]);
    return js_int32(h->is_pipe ? uv_pipe_open(&h->u.pipe, fd) : uv_tcp_open(&h->u.tcp, (uv_os_sock_t)fd));
}

/* netFd(id) → the handle's descriptor | -errno (-1 for a Windows socket's, as Node's) */
HOST_FN(js_host_net_fd) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
#ifdef _WIN32
    return js_int32(-1);
#else
    uv_os_fd_t fd;
    int r = uv_fileno((uv_handle_t *)&h->u.stream, &fd);
    return js_int32(r < 0 ? r : fd);
#endif
}

/* netBind(id, ip, port, flags 1 ipv6Only | 2 reusePort), or a pipe's netBind(id, path) */
HOST_FN(js_host_net_bind) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h || argc < 2) return js_int32(UV_EBADF);
    if (h->is_pipe) {
        char path[PATH_MAX_LEN];
        size_t n = string_arg(ctx, argv[1], path, sizeof path);  /* a Linux abstract path starts with a NUL */
        return js_int32(uv_pipe_bind2(&h->u.pipe, path, n, UV_PIPE_NO_TRUNCATE));
    }
    struct sockaddr_storage addr;
    int r = sockaddr_arg(ctx, argv[1], argc > 2 ? argv[2] : JS_UNDEFINED, &addr);
    if (r < 0) return js_int32(r);
    int flags = argc > 3 && js_is_int32(argv[3]) ? js_as_int32(argv[3]) : 0;
    return js_int32(uv_tcp_bind(&h->u.tcp, (const struct sockaddr *)&addr, (flags & 1 ? UV_TCP_IPV6ONLY : 0) | (flags & 2 ? UV_TCP_REUSEPORT : 0)));
}

/* netChmod(id, mode 1 readable | 2 writable): who may connect to a listening pipe */
HOST_FN(js_host_net_chmod) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h || !h->is_pipe) return js_int32(UV_EBADF);
    int mode = argc > 1 && js_is_int32(argv[1]) ? js_as_int32(argv[1]) : 0;
    return js_int32(uv_pipe_chmod(&h->u.pipe, (mode & 1 ? UV_READABLE : 0) | (mode & 2 ? UV_WRITABLE : 0)));
}

static void on_connection(uv_stream_t *listener, int status) {
    NetHandle *srv = (NetHandle *)listener;
    if (status < 0) {
        emit(srv, NET_CONNECTION, js_int32(status));
        return;
    }
    NetHandle *c = new_handle(js_uv_context(), srv->is_pipe, JS_UNDEFINED);
    int r = uv_accept(listener, &c->u.stream);
    if (r < 0) {
        close_handle(c);
        emit(srv, NET_CONNECTION, js_int32(r));
        return;
    }
    emit(srv, NET_CONNECTION, js_int32(c->id));
}

/* netListen(id, backlog) */
HOST_FN(js_host_net_listen) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    return js_int32(uv_listen(&h->u.stream, argc > 1 && js_is_int32(argv[1]) ? js_as_int32(argv[1]) : 511, on_connection));
}

static void on_connect(uv_connect_t *req, int status) {
    NetHandle *h = (NetHandle *)req->handle;
    free(req);
    emit(h, NET_CONNECT, js_int32(status));
}

/* netConnect(id, ip, port), or a pipe's netConnect(id, path) */
HOST_FN(js_host_net_connect) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h || argc < 2) return js_int32(UV_EBADF);
    uv_connect_t *req = malloc(sizeof *req);
    if (!req) js_fatal("out of memory in net");
    int r;
    if (h->is_pipe) {
        char path[PATH_MAX_LEN];
        size_t n = string_arg(ctx, argv[1], path, sizeof path);
        r = uv_pipe_connect2(req, &h->u.pipe, path, n, UV_PIPE_NO_TRUNCATE, on_connect);
    } else {
        struct sockaddr_storage addr;
        r = sockaddr_arg(ctx, argv[1], argc > 2 ? argv[2] : JS_UNDEFINED, &addr);
        if (r == 0) r = uv_tcp_connect(req, &h->u.tcp, (const struct sockaddr *)&addr, on_connect);
    }
    if (r < 0) free(req);
    return js_int32(r);
}

/* netCallback(id, cb): an accepted connection's callback */
HOST_FN(js_host_net_callback) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (h && argc > 1) h->cb = argv[1];
    return JS_UNDEFINED;
}

static void on_alloc(uv_handle_t *uh, size_t suggested, uv_buf_t *buf) {
    (void)uh;
    buf->base = malloc(suggested);
    buf->len = buf->base ? suggested : 0;
}

static void on_read(uv_stream_t *s, ssize_t n, const uv_buf_t *buf) {
    NetHandle *h = (NetHandle *)s;
    if (n != 0 && h->hook && h->hook->read(h->hook_data, n, buf->base)) {
        free(buf->base);
        return;
    }
    if (n > 0) {
        JSValue chunk = js_new_uint8_array(js_uv_context(), (size_t)n);
        if (js_is_exception(chunk)) js_fatal("out of memory in net");
        uint8_t *data;
        size_t len;
        js_buffer_source_bytes(chunk, &data, &len);
        memcpy(data, buf->base, (size_t)n);
        free(buf->base);
        emit(h, NET_READ, chunk);
        return;
    }
    free(buf->base);
    if (n < 0) {
        uv_read_stop(s);
        emit(h, NET_READ, js_int32((int32_t)n));
    }
}

HOST_FN(js_host_net_read_start) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    return js_int32(h ? uv_read_start(&h->u.stream, on_alloc, on_read) : UV_EBADF);
}

HOST_FN(js_host_net_read_stop) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    return js_int32(h ? uv_read_stop(&h->u.stream) : UV_EBADF);
}

typedef struct WriteReq {
    uv_write_t req;
    char       data[];
} WriteReq;

static void on_written(uv_write_t *req, int status) {
    NetHandle *h = (NetHandle *)req->handle;
    free(req);
    emit(h, NET_WRITE, js_int32(status));
}

/* netWrite(id, bytes) → 0 (all written now), 1 (the rest is queued: a NET_WRITE follows) | -errno.
 * Like Node's writeBuffer: a write that completes at once calls back synchronously. */
HOST_FN(js_host_net_write) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    uint8_t *bytes;
    size_t n;
    if (argc < 2 || !js_buffer_source_bytes(argv[1], &bytes, &n)) return js_throw_type_error(ctx, "netWrite: bytes expected");
    uv_buf_t b = uv_buf_init((char *)bytes, (unsigned)n);
    int r = n ? uv_try_write(&h->u.stream, &b, 1) : 0;
    if (r == (int)n) return js_int32(0);
    if (r < 0 && r != UV_EAGAIN && r != UV_ENOSYS) return js_int32(r);
    size_t done = r > 0 ? (size_t)r : 0;
    WriteReq *w = malloc(sizeof *w + (n - done));
    if (!w) js_fatal("out of memory in net");
    memcpy(w->data, bytes + done, n - done);  /* the bytes may be collected before the write ends */
    b = uv_buf_init(w->data, (unsigned)(n - done));
    r = uv_write(&w->req, &h->u.stream, &b, 1, on_written);
    if (r < 0) {
        free(w);
        return js_int32(r);
    }
    return js_int32(1);
}

static void on_shutdown(uv_shutdown_t *req, int status) {
    NetHandle *h = (NetHandle *)req->handle;
    free(req);
    emit(h, NET_SHUTDOWN, js_int32(status));
}

/* netShutdown(id) → 0 (a NET_SHUTDOWN follows, after the pending writes) | -errno */
HOST_FN(js_host_net_shutdown) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    uv_shutdown_t *req = malloc(sizeof *req);
    if (!req) js_fatal("out of memory in net");
    int r = uv_shutdown(req, &h->u.stream, on_shutdown);
    if (r < 0) free(req);
    return js_int32(r);
}

/* netClose(id): pending writes fail with ECANCELED, then NET_CLOSE */
HOST_FN(js_host_net_close) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (h) close_handle(h);
    return JS_UNDEFINED;
}

/* netReset(id): closes with a TCP RST instead of a FIN; NET_CLOSE follows */
HOST_FN(js_host_net_reset) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    if (h->is_pipe) return js_int32(UV_EINVAL);
    int r = uv_tcp_close_reset(&h->u.tcp, on_closed);
    if (r == 0) h->closing = true;
    return js_int32(r);
}

/* netRef(id, ref): an unref'd handle doesn't keep the program running */
HOST_FN(js_host_net_ref) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (h && argc > 1) {
        if (js_truthy(argv[1])) uv_ref(&h->u.handle);
        else uv_unref(&h->u.handle);
    }
    return JS_UNDEFINED;
}

/* An address as [address, family, port]. */
static JSValue address_array(JSContext *ctx, const struct sockaddr_storage *addr) {
    char name[64] = "";
    int port;
    const char *family;
    if (addr->ss_family == AF_INET6) {
        uv_ip6_name((const struct sockaddr_in6 *)addr, name, sizeof name);
        port = ntohs(((const struct sockaddr_in6 *)addr)->sin6_port);
        family = "IPv6";
    } else {
        uv_ip4_name((const struct sockaddr_in *)addr, name, sizeof name);
        port = ntohs(((const struct sockaddr_in *)addr)->sin_port);
        family = "IPv4";
    }
    JSValue items[3] = { js_new_string_cstr(ctx, name), js_new_string_cstr(ctx, family), js_int32(port) };
    return js_new_array_from(ctx, items, 3);
}

/* netAddress(id, peer) → [address, family, port] | -errno: the local end, or with `peer` the remote
 * one; a pipe's path */
HOST_FN(js_host_net_address) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    bool peer = argc > 1 && js_truthy(argv[1]);
    if (h->is_tty) return js_int32(UV_ENOTSOCK);
    if (h->is_pipe) {
        char path[PATH_MAX_LEN];
        size_t n = sizeof path;
        int r = peer ? uv_pipe_getpeername(&h->u.pipe, path, &n) : uv_pipe_getsockname(&h->u.pipe, path, &n);
        return r < 0 ? js_int32(r) : js_new_string_utf8(ctx, path, n);
    }
    struct sockaddr_storage addr;
    int len = sizeof addr;
    int r = peer ? uv_tcp_getpeername(&h->u.tcp, (struct sockaddr *)&addr, &len)
                                           : uv_tcp_getsockname(&h->u.tcp, (struct sockaddr *)&addr, &len);
    return r < 0 ? js_int32(r) : address_array(ctx, &addr);
}

HOST_FN(js_host_net_no_delay) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (h && h->is_pipe) return js_int32(0);
    return js_int32(h ? uv_tcp_nodelay(&h->u.tcp, argc > 1 && js_truthy(argv[1])) : UV_EBADF);
}

HOST_FN(js_host_net_keep_alive) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h) return js_int32(UV_EBADF);
    if (h->is_pipe) return js_int32(0);
    unsigned delay = argc > 2 && js_is_int32(argv[2]) && js_as_int32(argv[2]) > 0 ? (unsigned)js_as_int32(argv[2]) : 0;
    return js_int32(uv_tcp_keepalive(&h->u.tcp, argc > 1 && js_truthy(argv[1]), delay));
}

/* netTypeOfService(id, tos): IP_TOS, or IPV6_TCLASS on an IPv6 socket, as Node's TCPWrap sets
 * and reads it; with tos -1, the socket's */
HOST_FN(js_host_net_type_of_service) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h || h->is_pipe) return js_int32(h ? UV_EINVAL : UV_EBADF);
    int tos = argc > 1 && js_is_int32(argv[1]) ? js_as_int32(argv[1]) : -1;
    uv_os_fd_t fd;
    int err = uv_fileno((uv_handle_t *)&h->u.tcp, &fd);
    if (err) return js_int32(err);
    struct sockaddr_storage storage;
    int len = sizeof storage;
    err = uv_tcp_getsockname(&h->u.tcp, (struct sockaddr *)&storage, &len);
    if (err) return js_int32(err);
    int level, option;
    if (storage.ss_family == AF_INET) {
        level = IPPROTO_IP;
        option = IP_TOS;
    } else if (storage.ss_family == AF_INET6) {
#ifdef IPV6_TCLASS
        level = IPPROTO_IPV6;
        option = IPV6_TCLASS;
#else
        return js_int32(UV_ENOTSUP);
#endif
    } else {
        return js_int32(UV_EINVAL);
    }
#ifdef _WIN32
    if (tos >= 0) {
        return js_int32(setsockopt((SOCKET)fd, level, option, (const char *)&tos, sizeof tos) == 0
                            ? 0 : uv_translate_sys_error(WSAGetLastError()));
    }
    int got = 0, got_len = sizeof got;
    if (getsockopt((SOCKET)fd, level, option, (char *)&got, &got_len) != 0) return js_int32(uv_translate_sys_error(WSAGetLastError()));
#else
    if (tos >= 0) return js_int32(setsockopt(fd, level, option, &tos, sizeof tos) == 0 ? 0 : uv_translate_sys_error(errno));
    int got = 0;
    socklen_t got_len = sizeof got;
    if (getsockopt(fd, level, option, &got, &got_len) != 0) return js_int32(uv_translate_sys_error(errno));
#endif
    return js_int32(got);
}

/* ---- Terminals ----------------------------------------------------------------------------- */

static bool raw_mode_set;

static void reset_tty_mode(void) {
    uv_tty_reset_mode();
}

/* ttyOpen(fd, cb) → id | -errno: a terminal's handle, read like a pipe's */
HOST_FN(js_host_tty_open) {
    UNUSED;
    if (argc < 1 || !js_is_int32(argv[0])) return js_int32(UV_EBADF);
    NetHandle *h = calloc(1, sizeof *h);
    if (!h) js_fatal("out of memory in net");
    int r = uv_tty_init(js_uv_loop(ctx), &h->u.tty, js_as_int32(argv[0]), 0);
    if (r < 0) {
        free(h);
        return js_int32(r);
    }
    h->is_pipe = true;
    h->is_tty = true;
    return js_int32(add_handle(ctx, h, argc > 1 ? argv[1] : JS_UNDEFINED)->id);
}

/* ttySetRawMode(id, raw) → 0 | -errno: keys as they're typed, unechoed; the terminal's mode is
 * restored at exit, as Node's is */
HOST_FN(js_host_tty_set_raw_mode) {
    UNUSED;
    NetHandle *h = handle_arg(argc, argv);
    if (!h || !h->is_tty) return js_int32(UV_EBADF);
    if (!raw_mode_set) {
        raw_mode_set = true;
        atexit(reset_tty_mode);
    }
    return js_int32(uv_tty_set_mode(&h->u.tty, argc > 1 && js_truthy(argv[1]) ? UV_TTY_MODE_RAW : UV_TTY_MODE_NORMAL));
}

/* ---- dns.lookup ---------------------------------------------------------------------------- */

typedef struct Lookup {
    uv_getaddrinfo_t req;
    JSValue          cb;  /* a root */
} Lookup;

static void on_lookup(uv_getaddrinfo_t *req, int status, struct addrinfo *res) {
    Lookup *l = (Lookup *)req;
    JSContext *ctx = js_uv_context();
    JSValue list = js_new_array(ctx, 0);
    for (struct addrinfo *a = res; status == 0 && a; a = a->ai_next) {
        if (a->ai_family != AF_INET && a->ai_family != AF_INET6) continue;
        char name[64] = "";
        if (a->ai_family == AF_INET6) uv_ip6_name((const struct sockaddr_in6 *)a->ai_addr, name, sizeof name);
        else uv_ip4_name((const struct sockaddr_in *)a->ai_addr, name, sizeof name);
        JSValue items[2] = { js_new_string_cstr(ctx, name), js_int32(a->ai_family == AF_INET6 ? 6 : 4) };
        if (js_array_push(ctx, js_as_object(list), js_new_array_from(ctx, items, 2)) < 0) js_fatal("out of memory in dns");
    }
    uv_freeaddrinfo(res);
    JSValue args[3] = { js_int32(status), status ? js_new_string_cstr(ctx, uv_err_name(status)) : JS_NULL, list };
    JSValue cb = l->cb;
    js_remove_root(ctx->rt, &l->cb);
    free(l);
    (void)js_uv_call(cb, 3, args, NULL);
}

/* dnsLookup(host, family 0 | 4 | 6, cb) → 0 | -errno; cb(errno, code, [[address, family], …]) */
HOST_FN(js_host_dns_lookup) {
    UNUSED;
    if (argc < 3 || !js_is_string(argv[0])) return js_throw_type_error(ctx, "dnsLookup: (host, family, cb) expected");
    char *host = js_host_path_arg(ctx, argc, argv, 0);
    if (!host) return JS_EXCEPTION;
    int family = js_is_int32(argv[1]) ? js_as_int32(argv[1]) : 0;
    struct addrinfo hints = { 0 };
    hints.ai_family = family == 4 ? AF_INET : family == 6 ? AF_INET6 : AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    Lookup *l = malloc(sizeof *l);
    if (!l) js_fatal("out of memory in dns");
    l->cb = argv[2];
    js_add_root(ctx->rt, &l->cb);
    int r = uv_getaddrinfo(js_uv_loop(ctx), &l->req, on_lookup, host, NULL, &hints);
    free(host);
    if (r < 0) {
        js_remove_root(ctx->rt, &l->cb);
        free(l);
    }
    return js_int32(r);
}

/* ---- dns.lookupService --------------------------------------------------------------------- */

typedef struct NameInfo {
    uv_getnameinfo_t req;
    JSValue          cb;  /* a root */
} NameInfo;

static void on_nameinfo(uv_getnameinfo_t *req, int status, const char *hostname, const char *service) {
    NameInfo *n = (NameInfo *)req;
    JSContext *ctx = js_uv_context();
    JSValue args[3] = { js_int32(status), JS_NULL, JS_NULL };
    if (status == 0) {
        args[1] = js_new_string_cstr(ctx, hostname);
        args[2] = js_new_string_cstr(ctx, service);
    }
    JSValue cb = n->cb;
    js_remove_root(ctx->rt, &n->cb);
    free(n);
    (void)js_uv_call(cb, 3, args, NULL);
}

/* dnsLookupService(ip, port, cb) → 0 | -errno; cb(errno, hostname | null, service | null): getnameinfo, a
 * name required (NI_NAMEREQD), as Node's */
HOST_FN(js_host_dns_lookup_service) {
    UNUSED;
    if (argc < 3 || !js_is_string(argv[0]) || !js_is_number(argv[1])) return js_throw_type_error(ctx, "dnsLookupService: (ip, port, cb) expected");
    char ip[64];
    size_t len = js_view_to_utf8(js_string_view(ctx, argv[0]), ip, sizeof ip - 1);
    ip[len] = '\0';
    int port = (int)js_as_number(argv[1]);
    struct sockaddr_storage addr;
    if (uv_ip4_addr(ip, port, (struct sockaddr_in *)&addr) != 0 && uv_ip6_addr(ip, port, (struct sockaddr_in6 *)&addr) != 0) return js_int32(UV_EINVAL);
    NameInfo *n = malloc(sizeof *n);
    if (!n) js_fatal("out of memory in dns");
    n->cb = argv[2];
    js_add_root(ctx->rt, &n->cb);
    int r = uv_getnameinfo(js_uv_loop(ctx), &n->req, on_nameinfo, (const struct sockaddr *)&addr, NI_NAMEREQD);
    if (r < 0) {
        js_remove_root(ctx->rt, &n->cb);
        free(n);
    }
    return js_int32(r);
}

