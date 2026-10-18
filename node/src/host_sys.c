/* Host primitives shared by the prelude modules: error names and messages for
 * -errno results, as libuv words them (Node's err.code and message). The working directory
 * (cwd) is the runtime's, for process.cwd(). */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers (the UV_E* codes): pthread_rwlock_t */
#include "js_node.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <uv.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

#include "js_exception.h"
#include "js_jobs.h"
#include "jscontext.h"
#include "js_ops.h"
#include "jsstring.h"
#include "js_uv.h"

/* Each error by its C errno and its libuv code: the same number on POSIX, but on Windows libuv
 * has codes of its own (UV_ECONNREFUSED is -4078) while the C library's errno has the C values. */
#define E(name, message) { name, -UV_##name, #name, message }
static const struct { int code, uv; const char *name, *message; } ERRORS[] = {
    E(EPERM, "operation not permitted"),
    E(ESRCH, "no such process"),
    E(ENOENT, "no such file or directory"),
    E(EIO, "i/o error"),
    E(EBADF, "bad file descriptor"),
    E(EACCES, "permission denied"),
    E(EBUSY, "resource busy or locked"),
    E(EEXIST, "file already exists"),
    E(ENOTDIR, "not a directory"),
    E(EISDIR, "illegal operation on a directory"),
    E(EINVAL, "invalid argument"),
    E(EMFILE, "too many open files"),
    E(EFBIG, "file too large"),
    E(ENOSPC, "no space left on device"),
    E(EROFS, "read-only file system"),
    E(ENAMETOOLONG, "name too long"),
    E(ENOTEMPTY, "directory not empty"),
    E(ELOOP, "too many symbolic links encountered"),
    E(EADDRINUSE, "address already in use"),
    E(EADDRNOTAVAIL, "address not available"),
    E(ECONNRESET, "connection reset by peer"),
    E(ECONNREFUSED, "connection refused"),
    E(EPIPE, "broken pipe"),
    E(EAFNOSUPPORT, "address family not supported"),
    E(ENOTCONN, "socket is not connected"),
    E(ECONNABORTED, "software caused connection abort"),
    E(ETIMEDOUT, "connection timed out"),
    E(ENETUNREACH, "network is unreachable"),
    E(EHOSTUNREACH, "host is unreachable"),
    E(ECANCELED, "operation canceled"),
    E(ENOBUFS, "no buffer space available"),
    E(EAGAIN, "resource temporarily unavailable"),
    E(ENFILE, "file table overflow"),
    E(ENOSYS, "function not implemented"),
    E(ENOMEM, "not enough memory"),
    E(E2BIG, "argument list too long"),
    E(EFAULT, "bad address in system call argument"),
    E(EINTR, "interrupted system call"),
    E(EMSGSIZE, "message too long"),
    E(ENOTSOCK, "socket operation on non-socket"),
    E(ENOTSUP, "operation not supported on socket"),
    E(EOVERFLOW, "value too large for defined data type"),
    E(EPROTO, "protocol error"),
    E(ERANGE, "result too large"),
    E(ESPIPE, "invalid seek"),
    E(ETXTBSY, "text file is busy"),
    E(EXDEV, "cross-device link not permitted"),
    E(ENXIO, "no such device or address"),
    E(EMLINK, "too many links"),
    E(ENOTTY, "inappropriate ioctl for device"),
};
#undef E

int js_node_uv_error(int e) {
    for (size_t i = 0; i < sizeof ERRORS / sizeof ERRORS[0]; i++)
        if (ERRORS[i].code == e) return -ERRORS[i].uv;
    return -e;
}

static int errno_arg(uint32_t argc, const JSValue *argv) {
    return argc > 0 && js_is_int32(argv[0]) ? -js_as_int32(argv[0]) : 0;
}

/* errnoName(-errno): "ENOENT", or "UNKNOWN". */
JSValue js_host_errno_name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                           const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    int e = errno_arg(argc, argv);
    for (size_t i = 0; i < sizeof ERRORS / sizeof ERRORS[0]; i++)
        if (ERRORS[i].code == e || ERRORS[i].uv == e) return js_new_string_cstr(ctx, ERRORS[i].name);
    return js_new_string_cstr(ctx, "UNKNOWN");
}

/* errnoMessage(-errno): "no such file or directory", or "unknown error". */
JSValue js_host_errno_message(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                              const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    int e = errno_arg(argc, argv);
    for (size_t i = 0; i < sizeof ERRORS / sizeof ERRORS[0]; i++)
        if (ERRORS[i].code == e || ERRORS[i].uv == e) return js_new_string_cstr(ctx, ERRORS[i].message);
    return js_new_string_cstr(ctx, "unknown error");
}

/* errnoMap() → [[uv code, name, message], …]: libuv's every error, in its order
 * (util.getSystemErrorMap). Its names and codes are compile-time constants: nothing of libuv is
 * linked. */
JSValue js_host_errno_map(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                          const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    static const struct { int code; const char *name, *message; } map[] = {
#define XX(name, message) { UV_##name, #name, message },
        UV_ERRNO_MAP(XX)
#undef XX
    };
    size_t n = sizeof map / sizeof map[0];
    /* each entry kept in the result as it's made: the collector sees it there */
    JSValue result = js_new_array(ctx, (uint32_t)n);
    if (js_is_exception(result)) return result;
    for (size_t i = 0; i < n; i++) {
        JSValue entry = js_new_array(ctx, 3);
        if (js_is_exception(entry) || js_array_push(ctx, js_as_object(result), entry) < 0) return JS_EXCEPTION;
        JSValue name = js_new_string_cstr(ctx, map[i].name);
        if (js_is_exception(name) || js_array_push(ctx, js_as_object(entry), js_int32(map[i].code)) < 0 ||
            js_array_push(ctx, js_as_object(entry), name) < 0) return JS_EXCEPTION;
        JSValue message = js_new_string_cstr(ctx, map[i].message);
        if (js_is_exception(message) || js_array_push(ctx, js_as_object(entry), message) < 0) return JS_EXCEPTION;
    }
    return result;
}

/* ttyIsatty(fd): whether the descriptor is a terminal (node:tty's isatty). */
JSValue js_host_tty_isatty(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                           JSValue new_target) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    if (argc < 1 || !js_is_int32(argv[0])) return JS_FALSE;
#ifdef _WIN32
    return js_bool(_isatty(js_as_int32(argv[0])) != 0);
#else
    return js_bool(isatty(js_as_int32(argv[0])) == 1);
#endif
}

/* timerUnref(fn, ms) → id: a timer that doesn't keep the program alive (Node's setUnrefTimeout,
 * for socket timeouts); clearTimeout(id) cancels it. */
JSValue js_host_timer_unref(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                            JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    if (argc < 2 || !js_is_callable(argv[0]) || !js_is_number(argv[1])) return js_throw_type_error(ctx, "timerUnref: (fn, ms) expected");
    return js_int32((int32_t)js_add_timer(ctx, argv[0], js_as_number(argv[1]), true));
}

/* loopNow() → libuv's time in ms, as of the last poll (Node's getLibuvNow): what a socket's
 * activity is measured with, without a clock read or an allocation per read and write */
JSValue js_host_loop_now(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                         JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    return js_number((double)uv_now(js_uv_loop(ctx)));
}

/* the id a timer primitive takes: a positive int32, else 0 */
static uint32_t timer_id(uint32_t argc, const JSValue *argv, uint32_t i) {
    return i < argc && js_is_int32(argv[i]) && js_as_int32(argv[i]) > 0 ? (uint32_t)js_as_int32(argv[i]) : 0;
}

/* timerStart(fn, ms, ref, id) → id: fn() once after ms, or at the loop's time when ms < 0 (an
 * immediate); id restarts that timer (refresh()), 0 starts a new one. node:timers' Timeouts. */
JSValue js_host_timer_start(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                            JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    if (argc < 3 || !js_is_callable(argv[0]) || !js_is_number(argv[1])) return js_throw_type_error(ctx, "timerStart: (fn, ms, ref, id) expected");
    double ms = js_as_number(argv[1]);
    return js_int32((int32_t)js_timer_start(ctx, argv[0], ms, ms < 0, !js_truthy(argv[2]), timer_id(argc, argv, 3)));
}

/* asyncContextGet() → the current async context: undefined, or AsyncLocalStorage's frame */
JSValue js_host_async_context_get(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                                  JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    return js_async_context(ctx);
}

/* asyncContextSet(context): what jobs, timers and promise reactions queued from now on carry */
JSValue js_host_async_context_set(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                                  JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    js_set_async_context(ctx, argc ? argv[0] : JS_UNDEFINED);
    return JS_UNDEFINED;
}

/* timerRef(id, ref): whether a pending timer keeps the program alive */
JSValue js_host_timer_ref(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                          JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    uint32_t id = timer_id(argc, argv, 0);
    if (id) js_timer_set_ref(ctx, id, argc > 1 && js_truthy(argv[1]));
    return JS_UNDEFINED;
}

/* timerClear(id) */
JSValue js_host_timer_clear(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                            JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    uint32_t id = timer_id(argc, argv, 0);
    if (id) js_timer_clear(ctx, id);
    return JS_UNDEFINED;
}

/* processMemory(): [rss, heapTotal, heapUsed] in bytes, for process.memoryUsage(): the resident
 * set (libuv), the GC heap's mapped blocks, and what the last collection kept plus what was
 * allocated since. */
JSValue js_host_process_memory(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                               JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    size_t rss = 0;
    if (uv_resident_set_memory(&rss) != 0) rss = 0;
    const JSHeap *h = &ctx->rt->heap;
    JSValue items[3] = { js_number((double)rss), js_number((double)js_heap_size(ctx->rt)),
                         js_number((double)(h->live_after_gc + h->allocated_since_gc)) };
    return js_new_array_from(ctx, items, 3);
}
