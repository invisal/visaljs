/* Host primitives for the program's own process (node:process beyond the runtime's process object):
 * the working directory, the file mode mask, uptime, CPU and resource usage, the parent, memory
 * limits, user and group ids (POSIX), abort, exit and execve. Child processes are host_process.c's.
 *
 *   procChdir(path) → 0 | -errno                procUmask(mask | -1) → the old mask (-1: only read it)
 *   procUptime() → seconds since the program started
 *   procCpuUsage(thread) → [user µs, system µs] | -errno     procResourceUsage() → [16 numbers] | -errno
 *   procPpid() → pid                            procMemory() → [available, constrained] bytes
 *   procSetId(kind, id) → 0 | -errno   kind 0 setuid, 1 setgid, 2 seteuid, 3 setegid
 *   procUserId(name) → id | -1                  procGroupId(name) → id | -1
 *   procUserName(id) → name | null              procGetGroups() → [gid, …] | -errno
 *   procSetGroups([gid, …]) → 0 | -errno        procInitGroups(user, gid) → 0 | -errno
 *   procAbort()                                 procReallyExit(code): output flushed, no 'exit'
 *   procExecve(file, [arg, …], [key=value, …]) → -errno (it returns only when it fails) */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE  /* getgroups, setgroups, initgroups */
#define _DARWIN_C_SOURCE /* the same, on macOS */
#include "js_node.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <uv.h>
#ifdef _WIN32
#include <io.h>
#else
#include <grp.h>
#include <pwd.h>
#include <unistd.h>
#endif

#include "js_atoms.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_object.h"
#include "jscontext.h"
#include "jsstring.h"

#define HOST_FN(name) JSValue name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED (void)ctx, (void)callee, (void)this_val, (void)new_target

/* when the program started: set before main, in a program that links this file */
static uint64_t start_ns;
__attribute__((constructor)) static void record_start(void) { start_ns = uv_hrtime(); }

/* A string argument as UTF-8, malloc'd; NULL for anything else. */
static char *string_arg(JSContext *ctx, JSValue v) {
    if (!js_is_string(v)) return NULL;
    JSStrView view = js_string_view(ctx, v);
    size_t n = js_view_to_utf8(view, NULL, 0);
    char *s = malloc(n + 1);
    if (!s) js_fatal("out of memory");
    js_view_to_utf8(view, s, n);
    s[n] = '\0';
    return s;
}

static JSValue numbers(JSContext *ctx, const double *v, uint32_t n) {
    JSValue values[16];
    for (uint32_t i = 0; i < n; i++) values[i] = js_number(v[i]);
    return js_new_array_from(ctx, values, n);
}

HOST_FN(js_host_proc_chdir) {
    UNUSED;
    char *path = argc > 0 ? string_arg(ctx, argv[0]) : NULL;
    if (!path) return js_int32(UV_EINVAL);
    int r = uv_chdir(path);
    free(path);
    return js_int32(r);
}

HOST_FN(js_host_proc_umask) {
    UNUSED;
    int mask = argc > 0 && js_is_int32(argv[0]) ? js_as_int32(argv[0]) : -1;
    if (mask < 0) {  /* read: set it, then back */
        int old = (int)umask(0);
        umask((mode_t)old);
        return js_int32(old);
    }
    return js_int32((int)umask((mode_t)(mask & 0777)));
}

HOST_FN(js_host_proc_uptime) {
    UNUSED, (void)argc, (void)argv;
    return js_number((double)(uv_hrtime() - start_ns) / 1e9);
}

static double usec(uv_timeval_t t) { return (double)t.tv_sec * 1e6 + (double)t.tv_usec; }

HOST_FN(js_host_proc_cpu_usage) {
    UNUSED;
    uv_rusage_t ru;
    int r = argc > 0 && js_truthy(argv[0]) ? uv_getrusage_thread(&ru) : uv_getrusage(&ru);
    if (r < 0) return js_int32(r);
    double v[2] = { usec(ru.ru_utime), usec(ru.ru_stime) };
    return numbers(ctx, v, 2);
}

/* in Node's order: userCPUTime, systemCPUTime, maxRSS (KiB), sharedMemorySize, unsharedDataSize,
 * unsharedStackSize, minorPageFault, majorPageFault, swappedOut, fsRead, fsWrite, ipcSent,
 * ipcReceived, signalsCount, voluntaryContextSwitches, involuntaryContextSwitches */
HOST_FN(js_host_proc_resource_usage) {
    UNUSED, (void)argc, (void)argv;
    uv_rusage_t ru;
    int r = uv_getrusage(&ru);
    if (r < 0) return js_int32(r);
    double v[16] = {
        usec(ru.ru_utime), usec(ru.ru_stime), (double)ru.ru_maxrss, (double)ru.ru_ixrss, (double)ru.ru_idrss, (double)ru.ru_isrss,
        (double)ru.ru_minflt, (double)ru.ru_majflt, (double)ru.ru_nswap, (double)ru.ru_inblock, (double)ru.ru_oublock,
        (double)ru.ru_msgsnd, (double)ru.ru_msgrcv, (double)ru.ru_nsignals, (double)ru.ru_nvcsw, (double)ru.ru_nivcsw,
    };
    return numbers(ctx, v, 16);
}

HOST_FN(js_host_proc_ppid) {
    UNUSED, (void)argc, (void)argv;
    return js_number((double)uv_os_getppid());
}

HOST_FN(js_host_proc_memory) {
    UNUSED, (void)argc, (void)argv;
    double v[2] = { (double)uv_get_available_memory(), (double)uv_get_constrained_memory() };
    return numbers(ctx, v, 2);
}

HOST_FN(js_host_proc_abort) {
    UNUSED, (void)argc, (void)argv;
    fflush(stdout);
    fflush(stderr);
    abort();
}

HOST_FN(js_host_proc_really_exit) {
    UNUSED;
    int code = argc > 0 && js_is_int32(argv[0]) ? js_as_int32(argv[0]) : 0;
    fflush(stdout);
    fflush(stderr);
    exit(code);
}

#ifndef _WIN32

HOST_FN(js_host_proc_set_id) {
    UNUSED;
    if (argc < 2 || !js_is_int32(argv[0]) || !js_is_number(argv[1])) return js_int32(UV_EINVAL);
    double d = js_as_number(argv[1]);
    int r;
    switch (js_as_int32(argv[0])) {
    case 0: r = setuid((uid_t)d); break;
    case 1: r = setgid((gid_t)d); break;
    case 2: r = seteuid((uid_t)d); break;
    case 3: r = setegid((gid_t)d); break;
    default: return js_int32(UV_EINVAL);
    }
    return js_int32(r < 0 ? -errno : 0);
}

HOST_FN(js_host_proc_user_id) {
    UNUSED;
    char *name = argc > 0 ? string_arg(ctx, argv[0]) : NULL;
    if (!name) return js_int32(-1);
    struct passwd *pw = getpwnam(name);
    free(name);
    return pw ? js_number((double)pw->pw_uid) : js_int32(-1);
}

HOST_FN(js_host_proc_group_id) {
    UNUSED;
    char *name = argc > 0 ? string_arg(ctx, argv[0]) : NULL;
    if (!name) return js_int32(-1);
    struct group *gr = getgrnam(name);
    free(name);
    return gr ? js_number((double)gr->gr_gid) : js_int32(-1);
}

HOST_FN(js_host_proc_user_name) {
    UNUSED;
    if (argc < 1 || !js_is_number(argv[0])) return JS_NULL;
    struct passwd *pw = getpwuid((uid_t)js_as_number(argv[0]));
    return pw ? js_new_string_cstr(ctx, pw->pw_name) : JS_NULL;
}

HOST_FN(js_host_proc_get_groups) {
    UNUSED, (void)argc, (void)argv;
    int n = getgroups(0, NULL);
    if (n < 0) return js_int32(-errno);
    gid_t *groups = malloc(((size_t)n + 1) * sizeof *groups);
    if (!groups) js_fatal("out of memory");
    n = getgroups(n, groups);
    if (n < 0) {
        free(groups);
        return js_int32(-errno);
    }
    /* the effective group too, as Node lists it */
    gid_t egid = getegid();
    bool listed = false;
    for (int i = 0; i < n; i++) listed |= groups[i] == egid;
    if (!listed) groups[n++] = egid;
    JSValue list = js_new_array(ctx, (uint32_t)n);
    for (int i = 0; i < n && !js_is_exception(list); i++) {
        if (js_array_push(ctx, js_as_object(list), js_number((double)groups[i])) < 0) list = JS_EXCEPTION;
    }
    free(groups);
    return list;
}

HOST_FN(js_host_proc_set_groups) {
    UNUSED;
    if (argc < 1 || !js_is_object(argv[0])) return js_int32(UV_EINVAL);
    JSValue len = js_get_value(ctx, argv[0], JS_ATOM(length));
    if (!js_is_number(len)) return js_int32(UV_EINVAL);
    size_t n = (size_t)js_as_number(len);
    gid_t *groups = malloc((n + 1) * sizeof *groups);
    if (!groups) js_fatal("out of memory");
    for (size_t i = 0; i < n; i++) {
        JSValue v = js_get_index(ctx, argv[0], js_int32((int32_t)i));
        if (!js_is_number(v)) {
            free(groups);
            return js_int32(UV_EINVAL);
        }
        groups[i] = (gid_t)js_as_number(v);
    }
    int r = setgroups(n, groups);
    free(groups);
    return js_int32(r < 0 ? -errno : 0);
}

HOST_FN(js_host_proc_init_groups) {
    UNUSED;
    char *user = argc > 0 ? string_arg(ctx, argv[0]) : NULL;
    if (!user || argc < 2 || !js_is_number(argv[1])) {
        free(user);
        return js_int32(UV_EINVAL);
    }
    int r = initgroups(user, (gid_t)js_as_number(argv[1]));
    free(user);
    return js_int32(r < 0 ? -errno : 0);
}

/* the strings of an array, NULL-terminated, malloc'd */
static char **string_list(JSContext *ctx, JSValue array) {
    if (!js_is_object(array)) return NULL;
    JSValue len = js_get_value(ctx, array, JS_ATOM(length));
    size_t n = js_is_number(len) ? (size_t)js_as_number(len) : 0;
    char **list = calloc(n + 1, sizeof *list);
    if (!list) js_fatal("out of memory");
    for (size_t i = 0; i < n; i++) {
        list[i] = string_arg(ctx, js_get_index(ctx, array, js_int32((int32_t)i)));
        if (!list[i]) list[i] = strdup("");
    }
    return list;
}

static void free_list(char **list) {
    for (size_t i = 0; list && list[i]; i++) free(list[i]);
    free(list);
}

HOST_FN(js_host_proc_execve) {
    UNUSED;
    char *file = argc > 0 ? string_arg(ctx, argv[0]) : NULL;
    char **args = argc > 1 ? string_list(ctx, argv[1]) : NULL;
    char **env = argc > 2 ? string_list(ctx, argv[2]) : NULL;
    if (!file || !args || !env) {
        free(file), free_list(args), free_list(env);
        return js_int32(UV_EINVAL);
    }
    fflush(stdout);
    fflush(stderr);
    execve(file, args, env);
    int e = errno;
    free(file), free_list(args), free_list(env);
    return js_int32(-e);
}

#else  /* Windows: Node has none of these */

HOST_FN(js_host_proc_set_id) { UNUSED, (void)argc, (void)argv; return js_int32(UV_ENOSYS); }
HOST_FN(js_host_proc_user_id) { UNUSED, (void)argc, (void)argv; return js_int32(-1); }
HOST_FN(js_host_proc_group_id) { UNUSED, (void)argc, (void)argv; return js_int32(-1); }
HOST_FN(js_host_proc_user_name) { UNUSED, (void)argc, (void)argv; return JS_NULL; }
HOST_FN(js_host_proc_get_groups) { UNUSED, (void)argc, (void)argv; return js_int32(UV_ENOSYS); }
HOST_FN(js_host_proc_set_groups) { UNUSED, (void)argc, (void)argv; return js_int32(UV_ENOSYS); }
HOST_FN(js_host_proc_init_groups) { UNUSED, (void)argc, (void)argv; return js_int32(UV_ENOSYS); }
HOST_FN(js_host_proc_execve) { UNUSED, (void)argc, (void)argv; return js_int32(UV_ENOSYS); }

#endif
