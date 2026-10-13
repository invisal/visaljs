/* Host primitives for node:os: the system's facts through libuv, as Node's os module
 * gets them, and the constants (signals and errno numbers) of the platform the program was built
 * for. Failures return -errno, which the prelude turns into Node's SystemError. */
#define _GNU_SOURCE  /* libuv's headers, and every signal and errno name the platform has */
#include "js_node.h"

#include <errno.h>
#include <stdio.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>

#include "js_exception.h"
#include "jsstring.h"
#include "uv.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED_PRIMITIVE_ARGS (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target

static JSValue array_of(JSContext *ctx, const JSValue *items, uint32_t n) {
    JSValue a = js_new_array(ctx, n);
    for (uint32_t i = 0; i < n; i++)
        if (js_array_append(ctx, a, items[i]) < 0) return JS_EXCEPTION;
    return a;
}

/* osInterfaces(): [name, address, netmask, family (4 | 6), mac, internal, scopeid, …], 7 per
 * address (uv_interface_addresses), or -errno. */
PRIMITIVE(js_host_os_interfaces) {
    UNUSED_PRIMITIVE_ARGS;
    uv_interface_address_t *list;
    int count;
    int r = uv_interface_addresses(&list, &count);
    if (r < 0) return js_int32(r);
    JSValue a = js_new_array(ctx, (uint32_t)count * 7);
    for (int i = 0; i < count && !js_is_exception(a); i++) {
        uv_interface_address_t *ia = &list[i];
        char address[INET6_ADDRSTRLEN], netmask[INET6_ADDRSTRLEN], mac[18];
        bool v6 = ia->address.address4.sin_family == AF_INET6;
        if (v6) {
            uv_ip6_name(&ia->address.address6, address, sizeof address);
            uv_ip6_name(&ia->netmask.netmask6, netmask, sizeof netmask);
        } else {
            uv_ip4_name(&ia->address.address4, address, sizeof address);
            uv_ip4_name(&ia->netmask.netmask4, netmask, sizeof netmask);
        }
        const unsigned char *m = (const unsigned char *)ia->phys_addr;
        snprintf(mac, sizeof mac, "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
        JSValue items[7] = {
            js_new_string_cstr(ctx, ia->name), js_new_string_cstr(ctx, address), js_new_string_cstr(ctx, netmask),
            js_int32(v6 ? 6 : 4), js_new_string_cstr(ctx, mac), js_bool(ia->is_internal),
            js_number(v6 ? (double)ia->address.address6.sin6_scope_id : 0),
        };
        for (int k = 0; k < 7; k++) {
            if (js_is_exception(items[k]) || js_array_append(ctx, a, items[k]) < 0) {
                a = JS_EXCEPTION;
                break;
            }
        }
    }
    uv_free_interface_addresses(list, count);
    return a;
}

/* osGetPriority(pid) → priority | -errno */
PRIMITIVE(js_host_os_get_priority) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    int priority;
    int r = uv_os_getpriority(argc > 0 && js_is_number(argv[0]) ? (uv_pid_t)js_as_number(argv[0]) : 0, &priority);
    return js_int32(r < 0 ? r : priority);
}

/* osSetPriority(pid, priority) → 0 | -errno */
PRIMITIVE(js_host_os_set_priority) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    if (argc < 2 || !js_is_number(argv[0]) || !js_is_int32(argv[1])) return js_int32(UV_EINVAL);
    return js_int32(uv_os_setpriority((uv_pid_t)js_as_number(argv[0]), js_as_int32(argv[1])));
}

/* osUname(): [sysname, release, version, machine], or -errno. */
PRIMITIVE(js_host_os_uname) {
    UNUSED_PRIMITIVE_ARGS;
    uv_utsname_t u;
    int e = uv_os_uname(&u);
    if (e) return js_int32(e);
    JSValue items[4] = { js_new_string_cstr(ctx, u.sysname), js_new_string_cstr(ctx, u.release), js_new_string_cstr(ctx, u.version),
                         js_new_string_cstr(ctx, u.machine) };
    return array_of(ctx, items, 4);
}

typedef int (*PathFn)(char *buffer, size_t *size);

static JSValue path_result(JSContext *ctx, PathFn fn) {
    char buf[4096];
    size_t n = sizeof buf;
    int e = fn(buf, &n);
    return e ? js_int32(e) : js_new_string_utf8(ctx, buf, n);
}

/* osHostname(), osHomedir(), osTmpdir(): a string, or -errno. */
PRIMITIVE(js_host_os_hostname) {
    UNUSED_PRIMITIVE_ARGS;
    return path_result(ctx, uv_os_gethostname);
}

PRIMITIVE(js_host_os_homedir) {
    UNUSED_PRIMITIVE_ARGS;
    return path_result(ctx, uv_os_homedir);
}

PRIMITIVE(js_host_os_tmpdir) {
    UNUSED_PRIMITIVE_ARGS;
    return path_result(ctx, uv_os_tmpdir);
}

/* osMemory(): [total, free] in bytes. */
PRIMITIVE(js_host_os_memory) {
    UNUSED_PRIMITIVE_ARGS;
    JSValue items[2] = { js_number((double)uv_get_total_memory()), js_number((double)uv_get_free_memory()) };
    return array_of(ctx, items, 2);
}

/* osUptime(): seconds, or -errno. */
PRIMITIVE(js_host_os_uptime) {
    UNUSED_PRIMITIVE_ARGS;
    double up;
    int e = uv_uptime(&up);
    return e ? js_int32(e) : js_number(up);
}

/* osLoadavg(): [1, 5, 15 minutes]. */
PRIMITIVE(js_host_os_loadavg) {
    UNUSED_PRIMITIVE_ARGS;
    double avg[3];
    uv_loadavg(avg);
    JSValue items[3] = { js_number(avg[0]), js_number(avg[1]), js_number(avg[2]) };
    return array_of(ctx, items, 3);
}

/* osParallelism(): os.availableParallelism(). */
PRIMITIVE(js_host_os_parallelism) {
    UNUSED_PRIMITIVE_ARGS;
    (void)ctx;
    return js_number((double)uv_available_parallelism());
}

/* osCpus(): [model, speed, user, nice, sys, idle, irq] for each CPU (times in ms), or -errno. */
PRIMITIVE(js_host_os_cpus) {
    UNUSED_PRIMITIVE_ARGS;
    uv_cpu_info_t *cpus;
    int count;
    int e = uv_cpu_info(&cpus, &count);
    if (e) return js_int32(e);
    JSValue out = js_new_array(ctx, (uint32_t)count);
    for (int i = 0; i < count; i++) {
        uv_cpu_info_t *c = &cpus[i];
        JSValue items[7] = { js_new_string_cstr(ctx, c->model), js_number(c->speed), js_number((double)c->cpu_times.user),
                             js_number((double)c->cpu_times.nice), js_number((double)c->cpu_times.sys),
                             js_number((double)c->cpu_times.idle), js_number((double)c->cpu_times.irq) };
        JSValue cpu = array_of(ctx, items, 7);
        if (js_is_exception(cpu) || js_array_append(ctx, out, cpu) < 0) {
            uv_free_cpu_info(cpus, count);
            return JS_EXCEPTION;
        }
    }
    uv_free_cpu_info(cpus, count);
    return out;
}

/* osUserInfo(): [uid, gid, username, homedir, shell] (shell null when there is none), or -errno. */
PRIMITIVE(js_host_os_user_info) {
    UNUSED_PRIMITIVE_ARGS;
    uv_passwd_t pw;
    int e = uv_os_get_passwd(&pw);
    if (e) return js_int32(e);
    JSValue items[5] = { js_number((double)pw.uid), js_number((double)pw.gid), js_new_string_cstr(ctx, pw.username),
                         js_new_string_cstr(ctx, pw.homedir), pw.shell ? js_new_string_cstr(ctx, pw.shell) : JS_NULL };
    uv_os_free_passwd(&pw);
    return array_of(ctx, items, 5);
}

/* The platform's numbers, as Node's node_constants.cc lists them */
static const struct { const char *name; int value; } SIGNALS[] = {
#ifdef SIGHUP
    { "SIGHUP", SIGHUP },
#endif
#ifdef SIGINT
    { "SIGINT", SIGINT },
#endif
#ifdef SIGQUIT
    { "SIGQUIT", SIGQUIT },
#endif
#ifdef SIGILL
    { "SIGILL", SIGILL },
#endif
#ifdef SIGTRAP
    { "SIGTRAP", SIGTRAP },
#endif
#ifdef SIGABRT
    { "SIGABRT", SIGABRT },
#endif
#ifdef SIGIOT
    { "SIGIOT", SIGIOT },
#endif
#ifdef SIGBUS
    { "SIGBUS", SIGBUS },
#endif
#ifdef SIGFPE
    { "SIGFPE", SIGFPE },
#endif
#ifdef SIGKILL
    { "SIGKILL", SIGKILL },
#endif
#ifdef SIGUSR1
    { "SIGUSR1", SIGUSR1 },
#endif
#ifdef SIGSEGV
    { "SIGSEGV", SIGSEGV },
#endif
#ifdef SIGUSR2
    { "SIGUSR2", SIGUSR2 },
#endif
#ifdef SIGPIPE
    { "SIGPIPE", SIGPIPE },
#endif
#ifdef SIGALRM
    { "SIGALRM", SIGALRM },
#endif
#ifdef SIGTERM
    { "SIGTERM", SIGTERM },
#endif
#ifdef SIGCHLD
    { "SIGCHLD", SIGCHLD },
#endif
#ifdef SIGSTKFLT
    { "SIGSTKFLT", SIGSTKFLT },
#endif
#ifdef SIGCONT
    { "SIGCONT", SIGCONT },
#endif
#ifdef SIGSTOP
    { "SIGSTOP", SIGSTOP },
#endif
#ifdef SIGTSTP
    { "SIGTSTP", SIGTSTP },
#endif
#ifdef SIGBREAK
    { "SIGBREAK", SIGBREAK },
#endif
#ifdef SIGTTIN
    { "SIGTTIN", SIGTTIN },
#endif
#ifdef SIGTTOU
    { "SIGTTOU", SIGTTOU },
#endif
#ifdef SIGURG
    { "SIGURG", SIGURG },
#endif
#ifdef SIGXCPU
    { "SIGXCPU", SIGXCPU },
#endif
#ifdef SIGXFSZ
    { "SIGXFSZ", SIGXFSZ },
#endif
#ifdef SIGVTALRM
    { "SIGVTALRM", SIGVTALRM },
#endif
#ifdef SIGPROF
    { "SIGPROF", SIGPROF },
#endif
#ifdef SIGWINCH
    { "SIGWINCH", SIGWINCH },
#endif
#ifdef SIGIO
    { "SIGIO", SIGIO },
#endif
#ifdef SIGPOLL
    { "SIGPOLL", SIGPOLL },
#endif
#ifdef SIGLOST
    { "SIGLOST", SIGLOST },
#endif
#ifdef SIGPWR
    { "SIGPWR", SIGPWR },
#endif
#ifdef SIGINFO
    { "SIGINFO", SIGINFO },
#endif
#ifdef SIGSYS
    { "SIGSYS", SIGSYS },
#endif
#ifdef SIGUNUSED
    { "SIGUNUSED", SIGUNUSED },
#endif
};

static const struct { const char *name; int value; } ERRNOS[] = {
#ifdef E2BIG
    { "E2BIG", E2BIG },
#endif
#ifdef EACCES
    { "EACCES", EACCES },
#endif
#ifdef EADDRINUSE
    { "EADDRINUSE", EADDRINUSE },
#endif
#ifdef EADDRNOTAVAIL
    { "EADDRNOTAVAIL", EADDRNOTAVAIL },
#endif
#ifdef EAFNOSUPPORT
    { "EAFNOSUPPORT", EAFNOSUPPORT },
#endif
#ifdef EAGAIN
    { "EAGAIN", EAGAIN },
#endif
#ifdef EALREADY
    { "EALREADY", EALREADY },
#endif
#ifdef EBADF
    { "EBADF", EBADF },
#endif
#ifdef EBADMSG
    { "EBADMSG", EBADMSG },
#endif
#ifdef EBUSY
    { "EBUSY", EBUSY },
#endif
#ifdef ECANCELED
    { "ECANCELED", ECANCELED },
#endif
#ifdef ECHILD
    { "ECHILD", ECHILD },
#endif
#ifdef ECONNABORTED
    { "ECONNABORTED", ECONNABORTED },
#endif
#ifdef ECONNREFUSED
    { "ECONNREFUSED", ECONNREFUSED },
#endif
#ifdef ECONNRESET
    { "ECONNRESET", ECONNRESET },
#endif
#ifdef EDEADLK
    { "EDEADLK", EDEADLK },
#endif
#ifdef EDESTADDRREQ
    { "EDESTADDRREQ", EDESTADDRREQ },
#endif
#ifdef EDOM
    { "EDOM", EDOM },
#endif
#ifdef EDQUOT
    { "EDQUOT", EDQUOT },
#endif
#ifdef EEXIST
    { "EEXIST", EEXIST },
#endif
#ifdef EFAULT
    { "EFAULT", EFAULT },
#endif
#ifdef EFBIG
    { "EFBIG", EFBIG },
#endif
#ifdef EHOSTUNREACH
    { "EHOSTUNREACH", EHOSTUNREACH },
#endif
#ifdef EIDRM
    { "EIDRM", EIDRM },
#endif
#ifdef EILSEQ
    { "EILSEQ", EILSEQ },
#endif
#ifdef EINPROGRESS
    { "EINPROGRESS", EINPROGRESS },
#endif
#ifdef EINTR
    { "EINTR", EINTR },
#endif
#ifdef EINVAL
    { "EINVAL", EINVAL },
#endif
#ifdef EIO
    { "EIO", EIO },
#endif
#ifdef EISCONN
    { "EISCONN", EISCONN },
#endif
#ifdef EISDIR
    { "EISDIR", EISDIR },
#endif
#ifdef ELOOP
    { "ELOOP", ELOOP },
#endif
#ifdef EMFILE
    { "EMFILE", EMFILE },
#endif
#ifdef EMLINK
    { "EMLINK", EMLINK },
#endif
#ifdef EMSGSIZE
    { "EMSGSIZE", EMSGSIZE },
#endif
#ifdef EMULTIHOP
    { "EMULTIHOP", EMULTIHOP },
#endif
#ifdef ENAMETOOLONG
    { "ENAMETOOLONG", ENAMETOOLONG },
#endif
#ifdef ENETDOWN
    { "ENETDOWN", ENETDOWN },
#endif
#ifdef ENETRESET
    { "ENETRESET", ENETRESET },
#endif
#ifdef ENETUNREACH
    { "ENETUNREACH", ENETUNREACH },
#endif
#ifdef ENFILE
    { "ENFILE", ENFILE },
#endif
#ifdef ENOBUFS
    { "ENOBUFS", ENOBUFS },
#endif
#ifdef ENODATA
    { "ENODATA", ENODATA },
#endif
#ifdef ENODEV
    { "ENODEV", ENODEV },
#endif
#ifdef ENOENT
    { "ENOENT", ENOENT },
#endif
#ifdef ENOEXEC
    { "ENOEXEC", ENOEXEC },
#endif
#ifdef ENOLCK
    { "ENOLCK", ENOLCK },
#endif
#ifdef ENOLINK
    { "ENOLINK", ENOLINK },
#endif
#ifdef ENOMEM
    { "ENOMEM", ENOMEM },
#endif
#ifdef ENOMSG
    { "ENOMSG", ENOMSG },
#endif
#ifdef ENOPROTOOPT
    { "ENOPROTOOPT", ENOPROTOOPT },
#endif
#ifdef ENOSPC
    { "ENOSPC", ENOSPC },
#endif
#ifdef ENOSR
    { "ENOSR", ENOSR },
#endif
#ifdef ENOSTR
    { "ENOSTR", ENOSTR },
#endif
#ifdef ENOSYS
    { "ENOSYS", ENOSYS },
#endif
#ifdef ENOTCONN
    { "ENOTCONN", ENOTCONN },
#endif
#ifdef ENOTDIR
    { "ENOTDIR", ENOTDIR },
#endif
#ifdef ENOTEMPTY
    { "ENOTEMPTY", ENOTEMPTY },
#endif
#ifdef ENOTSOCK
    { "ENOTSOCK", ENOTSOCK },
#endif
#ifdef ENOTSUP
    { "ENOTSUP", ENOTSUP },
#endif
#ifdef ENOTTY
    { "ENOTTY", ENOTTY },
#endif
#ifdef ENXIO
    { "ENXIO", ENXIO },
#endif
#ifdef EOPNOTSUPP
    { "EOPNOTSUPP", EOPNOTSUPP },
#endif
#ifdef EOVERFLOW
    { "EOVERFLOW", EOVERFLOW },
#endif
#ifdef EPERM
    { "EPERM", EPERM },
#endif
#ifdef EPIPE
    { "EPIPE", EPIPE },
#endif
#ifdef EPROTO
    { "EPROTO", EPROTO },
#endif
#ifdef EPROTONOSUPPORT
    { "EPROTONOSUPPORT", EPROTONOSUPPORT },
#endif
#ifdef EPROTOTYPE
    { "EPROTOTYPE", EPROTOTYPE },
#endif
#ifdef ERANGE
    { "ERANGE", ERANGE },
#endif
#ifdef EROFS
    { "EROFS", EROFS },
#endif
#ifdef ESPIPE
    { "ESPIPE", ESPIPE },
#endif
#ifdef ESRCH
    { "ESRCH", ESRCH },
#endif
#ifdef ESTALE
    { "ESTALE", ESTALE },
#endif
#ifdef ETIME
    { "ETIME", ETIME },
#endif
#ifdef ETIMEDOUT
    { "ETIMEDOUT", ETIMEDOUT },
#endif
#ifdef ETXTBSY
    { "ETXTBSY", ETXTBSY },
#endif
#ifdef EWOULDBLOCK
    { "EWOULDBLOCK", EWOULDBLOCK },
#endif
#ifdef EXDEV
    { "EXDEV", EXDEV },
#endif
};

static JSValue table(JSContext *ctx, const char *const *names, const int *values, size_t n) {
    (void)names, (void)values;
    JSValue a = js_new_array(ctx, (uint32_t)(2 * n));
    for (size_t i = 0; i < n; i++)
        if (js_array_append(ctx, a, js_new_string_cstr(ctx, names[i])) < 0 || js_array_append(ctx, a, js_int32(values[i])) < 0)
            return JS_EXCEPTION;
    return a;
}

/* osConstants(): [signals, errno], each a flat [name, number, name, number, …]. */
PRIMITIVE(js_host_os_constants) {
    UNUSED_PRIMITIVE_ARGS;
    const size_t ns = sizeof SIGNALS / sizeof SIGNALS[0], ne = sizeof ERRNOS / sizeof ERRNOS[0];
    const char *names[128];
    int values[128];
    for (size_t i = 0; i < ns; i++) names[i] = SIGNALS[i].name, values[i] = SIGNALS[i].value;
    JSValue s = table(ctx, names, values, ns);
    for (size_t i = 0; i < ne; i++) names[i] = ERRNOS[i].name, values[i] = ERRNOS[i].value;
    JSValue e = table(ctx, names, values, ne);
    JSValue items[2] = { s, e };
    return array_of(ctx, items, 2);
}
