/* Host primitives for node:child_process: child processes on libuv (uv_spawn), as Node's
 * ProcessWrap and SyncProcessRunner make them. A child's stdio pipes are node:net's pipe handles
 * (host_net.c), so the prelude reads and writes them as net.Sockets. Processes are numbered; each
 * has one JS callback (a root), called once from the loop as cb(exitStatus, termSignal).
 *
 *   processSpawn(file, args, envPairs, cwd, stdio, flags, uid, gid, cb) → [0, id, pid] | [-errno]
 *     stdio: [kind, value] per descriptor; kind 0 ignore, 1 a pipe (value: its net handle id),
 *     2 an overlapped pipe, 3 a descriptor the child inherits (value: the fd), 4 a stream whose
 *     handle the child inherits (value: its net handle id)
 *     flags: 1 detached, 2 windowsHide, 4 windowsVerbatimArguments; uid, gid: -1 for none
 *   processKill(id, signum) → 0 | -errno, processRef(id, ref), processClose(id)
 *   processSpawnSync(file, args, envPairs, cwd, stdio, flags, uid, gid, timeout, maxBuffer, killSignal)
 *     → [error (0 | -errno), pid, exitStatus, termSignal, output]: the child run to its end on a
 *     loop of its own; stdio as above, a pipe's value its input (bytes, or null); output has a
 *     pipe's bytes (a Uint8Array) at its index, null elsewhere. error is ETIMEDOUT after `timeout`
 *     ms, ENOBUFS past `maxBuffer` bytes of output (the child is then sent killSignal), or the
 *     spawn's. */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers: pthread_rwlock_t */
#include <math.h>
#include <signal.h>
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

#define HOST_FN(name) JSValue name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED (void)callee, (void)this_val, (void)new_target

enum { STDIO_IGNORE, STDIO_PIPE, STDIO_OVERLAPPED, STDIO_FD, STDIO_STREAM };
enum { FLAG_DETACHED = 1, FLAG_WINDOWS_HIDE = 2, FLAG_VERBATIM = 4 };

/* ---- Arguments ------------------------------------------------------------------------------ */

/* A string as malloc'd UTF-8. */
static char *utf8(JSContext *ctx, JSValue v) {
    JSStrView view = js_string_view(ctx, v);
    size_t n = js_view_to_utf8(view, NULL, 0);
    char *s = malloc(n + 1);
    if (!s) js_fatal("out of memory in child_process");
    js_view_to_utf8(view, s, n);
    s[n] = '\0';
    return s;
}

/* An array of strings as a NULL-terminated array of malloc'd UTF-8; NULL for anything else. */
static char **string_list(JSContext *ctx, JSValue v) {
    if (!js_is_array(v)) return NULL;
    uint32_t n = js_array_length(js_as_object(v));
    char **list = calloc(n + 1, sizeof *list);
    if (!list) js_fatal("out of memory in child_process");
    for (uint32_t i = 0; i < n; i++) {
        JSValue s = js_get_index(ctx, v, js_int32((int32_t)i));
        list[i] = utf8(ctx, js_is_string(s) ? s : js_empty_string());
    }
    return list;
}

static void free_list(char **list) {
    if (!list) return;
    for (char **p = list; *p; p++) free(*p);
    free(list);
}

static int int_arg(uint32_t argc, const JSValue *argv, uint32_t i, int fallback) {
    return i < argc && js_is_number(argv[i]) ? (int)js_as_number(argv[i]) : fallback;
}

/* The options both spawns share, as uv_spawn takes them; the stdio containers come after. */
typedef struct SpawnArgs {
    uv_process_options_t o;
    char  *file;
    char **args;
    char **env;
    char  *cwd;
    uint32_t nstdio;
    int   *kinds;
    JSValue stdio;
} SpawnArgs;

static bool spawn_args(JSContext *ctx, uint32_t argc, const JSValue *argv, SpawnArgs *a) {
    memset(a, 0, sizeof *a);
    if (argc < 8 || !js_is_string(argv[0]) || !js_is_array(argv[1]) || !js_is_array(argv[4])) return false;
    a->file = utf8(ctx, argv[0]);
    a->args = string_list(ctx, argv[1]);
    a->env = string_list(ctx, argv[2]);  /* barrier: not a cell */
    a->cwd = js_is_string(argv[3]) ? utf8(ctx, argv[3]) : NULL;
    a->stdio = argv[4];
    a->nstdio = js_array_length(js_as_object(argv[4]));
    a->kinds = calloc(a->nstdio ? a->nstdio : 1, sizeof *a->kinds);
    if (!a->kinds) js_fatal("out of memory in child_process");
    a->o.file = a->file;
    a->o.args = a->args;
    a->o.env = a->env;
    a->o.cwd = a->cwd;
    int flags = int_arg(argc, argv, 5, 0);
    int uid = int_arg(argc, argv, 6, -1), gid = int_arg(argc, argv, 7, -1);
    if (uid >= 0) a->o.flags |= UV_PROCESS_SETUID, a->o.uid = (uv_uid_t)uid;
    if (gid >= 0) a->o.flags |= UV_PROCESS_SETGID, a->o.gid = (uv_gid_t)gid;
    if (flags & FLAG_DETACHED) a->o.flags |= UV_PROCESS_DETACHED;
    if (flags & FLAG_WINDOWS_HIDE) a->o.flags |= UV_PROCESS_WINDOWS_HIDE;
    if (flags & FLAG_VERBATIM) a->o.flags |= UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS;
    return true;
}

static void free_spawn_args(SpawnArgs *a) {
    free(a->file);
    free_list(a->args);
    free_list(a->env);
    free(a->cwd);
    free(a->kinds);
    free(a->o.stdio);
}

/* stdio[i] as [kind, value] */
static int stdio_entry(JSContext *ctx, SpawnArgs *a, uint32_t i, JSValue *value) {
    JSValue e = js_get_index(ctx, a->stdio, js_int32((int32_t)i));
    *value = js_is_array(e) ? js_get_index(ctx, e, js_int32(1)) : JS_UNDEFINED;
    JSValue k = js_is_array(e) ? js_get_index(ctx, e, js_int32(0)) : JS_UNDEFINED;
    return js_is_int32(k) ? js_as_int32(k) : STDIO_IGNORE;
}

/* ---- Processes ------------------------------------------------------------------------------ */

typedef struct Process {
    uv_process_t proc;
    int     id;
    bool    closing;
    JSValue cb;  /* a root */
} Process;

static Process **procs;
static size_t nprocs;

static Process *new_process(JSContext *ctx, JSValue cb) {
    Process *p = calloc(1, sizeof *p);
    if (!p) js_fatal("out of memory in child_process");
    size_t id = 0;
    while (id < nprocs && procs[id]) id++;
    if (id == nprocs) {
        size_t n = nprocs ? nprocs * 2 : 8;
        Process **v = realloc(procs, n * sizeof *v);
        if (!v) js_fatal("out of memory in child_process");
        memset(v + nprocs, 0, (n - nprocs) * sizeof *v);
        procs = v;
        nprocs = n;
    }
    procs[id] = p;
    p->id = (int)id;
    p->cb = cb;
    js_add_root(ctx->rt, &p->cb);
    return p;
}

static void free_process(Process *p) {
    procs[p->id] = NULL;
    js_remove_root(js_uv_context()->rt, &p->cb);
    free(p);
}

static void on_process_closed(uv_handle_t *h) {
    free_process((Process *)h);
}

static void on_exit(uv_process_t *proc, int64_t exit_status, int term_signal) {
    Process *p = (Process *)proc;
    JSValue args[2] = { js_number((double)exit_status), js_int32(term_signal) };
    (void)js_uv_call(p->cb, 2, args, NULL);
}

static Process *process_arg(uint32_t argc, const JSValue *argv) {
    int32_t id = argc > 0 && js_is_int32(argv[0]) ? js_as_int32(argv[0]) : -1;
    Process *p = id >= 0 && (size_t)id < nprocs ? procs[id] : NULL;
    return p && !p->closing ? p : NULL;
}

/* processSpawn(file, args, envPairs, cwd, stdio, flags, uid, gid, cb) → [0, id, pid] | [-errno] */
HOST_FN(js_host_process_spawn) {
    UNUSED;
    SpawnArgs a;
    if (!spawn_args(ctx, argc, argv, &a) || argc < 9 || !js_is_callable(argv[8])) {
        free_spawn_args(&a);
        return js_throw_type_error(ctx, "processSpawn: bad arguments");
    }
    a.o.exit_cb = on_exit;
    a.o.stdio_count = (int)a.nstdio;
    a.o.stdio = calloc(a.nstdio ? a.nstdio : 1, sizeof *a.o.stdio);
    if (!a.o.stdio) js_fatal("out of memory in child_process");
    for (uint32_t i = 0; i < a.nstdio; i++) {
        JSValue value;
        int kind = stdio_entry(ctx, &a, i, &value);
        uv_stdio_container_t *c = &a.o.stdio[i];
        int id = js_is_int32(value) ? js_as_int32(value) : -1;
        switch (kind) {
        case STDIO_PIPE:
        case STDIO_OVERLAPPED:
            c->data.stream = js_net_stream(id);
            /* as Node's ProcessWrap: readable and writable both, whichever end the child uses */
            c->flags = c->data.stream ? UV_CREATE_PIPE | UV_READABLE_PIPE | UV_WRITABLE_PIPE | (kind == STDIO_OVERLAPPED ? UV_OVERLAPPED_PIPE : 0) : UV_IGNORE;
            break;
        case STDIO_FD:
            c->flags = UV_INHERIT_FD;
            c->data.fd = id;
            break;
        case STDIO_STREAM:
            c->data.stream = js_net_stream(id);
            c->flags = c->data.stream ? UV_INHERIT_STREAM : UV_IGNORE;
            break;
        default:
            c->flags = UV_IGNORE;
        }
    }
    Process *p = new_process(ctx, argv[8]);
    int r = uv_spawn(js_uv_loop(ctx), &p->proc, &a.o);
    free_spawn_args(&a);
    if (r < 0) {
        /* libuv initialized the handle even so: it still has to be closed */
        p->closing = true;
        uv_close((uv_handle_t *)&p->proc, on_process_closed);
        JSValue items[1] = { js_int32(r) };
        return js_new_array_from(ctx, items, 1);
    }
    JSValue items[3] = { js_int32(0), js_int32(p->id), js_number((double)p->proc.pid) };
    return js_new_array_from(ctx, items, 3);
}

/* processKill(id, signum) → 0 | -errno */
HOST_FN(js_host_process_kill_child) {
    UNUSED;
    (void)ctx;
    Process *p = process_arg(argc, argv);
    if (!p) return js_int32(UV_ESRCH);
    return js_int32(uv_process_kill(&p->proc, int_arg(argc, argv, 1, 15)));
}

/* processRef(id, ref): an unref'd child doesn't keep the program running */
HOST_FN(js_host_process_ref) {
    UNUSED;
    (void)ctx;
    Process *p = process_arg(argc, argv);
    if (p && argc > 1) {
        if (js_truthy(argv[1])) uv_ref((uv_handle_t *)&p->proc);
        else uv_unref((uv_handle_t *)&p->proc);
    }
    return JS_UNDEFINED;
}

/* processClose(id): after its exit; the callback isn't called again */
HOST_FN(js_host_process_close) {
    UNUSED;
    (void)ctx;
    Process *p = process_arg(argc, argv);
    if (p) {
        p->closing = true;
        uv_close((uv_handle_t *)&p->proc, on_process_closed);
    }
    return JS_UNDEFINED;
}

/* ---- spawnSync (Node's SyncProcessRunner) --------------------------------------------------- */

typedef struct SyncRun SyncRun;

typedef struct SyncPipe {
    uv_pipe_t pipe;
    SyncRun  *run;
    bool      used;
    uint8_t  *input;
    size_t    input_len;
    uint8_t  *out;
    size_t    out_len, out_cap;
    uv_write_t write_req;
    uv_shutdown_t shutdown_req;
} SyncPipe;

struct SyncRun {
    uv_loop_t    loop;
    uv_process_t proc;
    uv_timer_t   timer;
    bool         timer_started;
    SyncPipe    *pipes;
    uint32_t     npipes;
    double       max_buffer;
    size_t       buffered;
    int          kill_signal;
    int          error;
    bool         exited, killed;
    int64_t      exit_status;
    int          term_signal;
};

static void sync_kill(SyncRun *r) {
    if (r->killed || r->exited) return;
    r->killed = true;
    int e = uv_process_kill(&r->proc, r->kill_signal);
    /* as Node: when the signal can't be sent, SIGKILL instead */
    if (e < 0 && e != UV_ESRCH) {
        if (!r->error) r->error = e;
        uv_process_kill(&r->proc, SIGKILL);
    }
}

static void sync_alloc(uv_handle_t *h, size_t suggested, uv_buf_t *buf) {
    SyncPipe *sp = (SyncPipe *)h;
    if (sp->out_cap - sp->out_len < suggested) {
        size_t cap = sp->out_cap ? sp->out_cap * 2 : 65536;
        while (cap - sp->out_len < suggested) cap *= 2;
        uint8_t *b = realloc(sp->out, cap);
        if (!b) js_fatal("out of memory in child_process");
        sp->out = b;
        sp->out_cap = cap;
    }
    buf->base = (char *)sp->out + sp->out_len;
    buf->len = sp->out_cap - sp->out_len;
}

static void sync_read(uv_stream_t *s, ssize_t n, const uv_buf_t *buf) {
    (void)buf;
    SyncPipe *sp = (SyncPipe *)s;
    SyncRun *r = sp->run;
    if (n > 0) {
        sp->out_len += (size_t)n;
        r->buffered += (size_t)n;
        if ((double)r->buffered > r->max_buffer) {
            if (!r->error) r->error = UV_ENOBUFS;
            sync_kill(r);
        }
    } else if (n < 0) {
        uv_read_stop(s);
        if (!uv_is_closing((uv_handle_t *)s)) uv_close((uv_handle_t *)s, NULL);
    }
}

static void sync_shutdown(uv_shutdown_t *req, int status) {
    (void)status;
    SyncPipe *sp = (SyncPipe *)req->data;
    /* the child may still write to it: reading goes on until it ends */
    (void)sp;
}

static void sync_written(uv_write_t *req, int status) {
    SyncPipe *sp = (SyncPipe *)req->data;
    if (status < 0 && status != UV_EPIPE && !sp->run->error) sp->run->error = status;
    sp->shutdown_req.data = sp;
    if (uv_shutdown(&sp->shutdown_req, (uv_stream_t *)&sp->pipe, sync_shutdown) < 0 && !uv_is_closing((uv_handle_t *)&sp->pipe))
        uv_close((uv_handle_t *)&sp->pipe, NULL);
}

static void sync_exit(uv_process_t *proc, int64_t exit_status, int term_signal) {
    SyncRun *r = (SyncRun *)proc->data;
    r->exited = true;
    r->exit_status = exit_status;
    r->term_signal = term_signal;
    uv_close((uv_handle_t *)proc, NULL);
    if (r->timer_started) uv_close((uv_handle_t *)&r->timer, NULL);
    r->timer_started = false;
}

static void sync_timeout(uv_timer_t *t) {
    SyncRun *r = (SyncRun *)t->data;
    if (!r->error) r->error = UV_ETIMEDOUT;
    sync_kill(r);
}

static void close_any(uv_handle_t *h, void *arg) {
    (void)arg;
    if (!uv_is_closing(h)) uv_close(h, NULL);
}

/* processSpawnSync(file, args, envPairs, cwd, stdio, flags, uid, gid, timeout, maxBuffer, killSignal)
 *   → [error, pid, exitStatus, termSignal, output] */
HOST_FN(js_host_process_spawn_sync) {
    UNUSED;
    SpawnArgs a;
    if (!spawn_args(ctx, argc, argv, &a)) {
        free_spawn_args(&a);
        return js_throw_type_error(ctx, "processSpawnSync: bad arguments");
    }
    SyncRun *r = calloc(1, sizeof *r);
    if (!r) js_fatal("out of memory in child_process");
    double timeout = argc > 8 && js_is_number(argv[8]) ? js_as_number(argv[8]) : 0;
    r->max_buffer = argc > 9 && js_is_number(argv[9]) ? js_as_number(argv[9]) : INFINITY;
    r->kill_signal = int_arg(argc, argv, 10, SIGTERM);
#ifndef _WIN32
    /* a child that exits before it reads its input: writing it fails with EPIPE (sync_written)
     * instead of killing the process, as in Node (which ignores SIGPIPE at startup). This loop
     * is its own: js_uv_loop, which does the same, may not have run. */
    signal(SIGPIPE, SIG_IGN);
#endif
    uv_loop_init(&r->loop);
    r->npipes = a.nstdio;
    r->pipes = calloc(a.nstdio ? a.nstdio : 1, sizeof *r->pipes);
    a.o.stdio = calloc(a.nstdio ? a.nstdio : 1, sizeof *a.o.stdio);
    if (!r->pipes || !a.o.stdio) js_fatal("out of memory in child_process");
    a.o.stdio_count = (int)a.nstdio;
    a.o.exit_cb = sync_exit;
    for (uint32_t i = 0; i < a.nstdio; i++) {
        JSValue value;
        int kind = stdio_entry(ctx, &a, i, &value);
        uv_stdio_container_t *c = &a.o.stdio[i];
        SyncPipe *sp = &r->pipes[i];
        sp->run = r;
        if (kind == STDIO_PIPE || kind == STDIO_OVERLAPPED) {
            uv_pipe_init(&r->loop, &sp->pipe, 0);
            sp->used = true;
            c->flags = UV_CREATE_PIPE | UV_READABLE_PIPE | UV_WRITABLE_PIPE | (kind == STDIO_OVERLAPPED ? UV_OVERLAPPED_PIPE : 0);
            c->data.stream = (uv_stream_t *)&sp->pipe;
            uint8_t *bytes;
            size_t n;
            if (js_buffer_source_bytes(value, &bytes, &n)) {
                /* copied: no JS runs until the child is done, but the bytes aren't ours */
                sp->input = malloc(n ? n : 1);
                if (!sp->input) js_fatal("out of memory in child_process");
                memcpy(sp->input, bytes, n);
                sp->input_len = n;
            }
        } else if (kind == STDIO_FD) {
            c->flags = UV_INHERIT_FD;
            c->data.fd = js_is_int32(value) ? js_as_int32(value) : (int)i;
        } else {
            c->flags = UV_IGNORE;
        }
    }
    r->proc.data = r;
    int e = uv_spawn(&r->loop, &r->proc, &a.o);
    free_spawn_args(&a);
    if (e < 0) {
        r->error = e;
        uv_close((uv_handle_t *)&r->proc, NULL);
    } else {
        for (uint32_t i = 0; i < r->npipes; i++) {
            SyncPipe *sp = &r->pipes[i];
            if (!sp->used) continue;
            if (i == 0 || sp->input) {
                /* the child's input: written, then the pipe shut down (an empty input too) */
                sp->write_req.data = sp;
                uv_buf_t b = uv_buf_init((char *)(sp->input ? sp->input : (uint8_t *)""), (unsigned)sp->input_len);
                if (uv_write(&sp->write_req, (uv_stream_t *)&sp->pipe, &b, 1, sync_written) < 0) uv_close((uv_handle_t *)&sp->pipe, NULL);
            } else {
                uv_read_start((uv_stream_t *)&sp->pipe, sync_alloc, sync_read);
            }
        }
        if (timeout > 0) {
            uv_timer_init(&r->loop, &r->timer);
            r->timer.data = r;
            uv_timer_start(&r->timer, sync_timeout, (uint64_t)timeout, 0);
            r->timer_started = true;
        }
    }
    uv_run(&r->loop, UV_RUN_DEFAULT);
    uv_walk(&r->loop, close_any, NULL);
    uv_run(&r->loop, UV_RUN_DEFAULT);
    uv_loop_close(&r->loop);

    JSValue output = js_new_array(ctx, 0);
    for (uint32_t i = 0; i < r->npipes; i++) {
        SyncPipe *sp = &r->pipes[i];
        JSValue v = JS_NULL;
        if (sp->used && !sp->input && i != 0) {
            v = js_new_uint8_array(ctx, sp->out_len);
            if (js_is_exception(v)) js_fatal("out of memory in child_process");
            uint8_t *data;
            size_t len;
            js_buffer_source_bytes(v, &data, &len);
            if (sp->out_len) memcpy(data, sp->out, sp->out_len);
        }
        free(sp->out);
        free(sp->input);
        if (js_array_push(ctx, js_as_object(output), v) < 0) js_fatal("out of memory in child_process");
    }
    JSValue items[5] = {
        js_int32(r->error),
        js_number(e < 0 ? 0 : (double)r->proc.pid),
        r->exited ? js_number((double)r->exit_status) : JS_NULL,
        js_int32(r->term_signal),
        output,
    };
    free(r->pipes);
    free(r);
    return js_new_array_from(ctx, items, 5);
}
