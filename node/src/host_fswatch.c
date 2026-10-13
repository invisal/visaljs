/* Host primitives for fs.watch and fs.watchFile (prelude/internal/fs_watch.js): libuv's file
 * system event handles (inotify, kqueue, …) and its stat pollers, numbered, each with one JS
 * callback (a root) called from the loop. A watcher keeps the program alive while it's ref'd
 * (Node's persistent option).
 *
 *   fsWatchStart(path, recursive, cb) → id | -errno    cb(events, filename | null): events 1 rename, 2 change;
 *                                                       or cb(-errno, null) for an error
 *   fsPollStart(path, interval ms, cb) → id | -errno    cb(status, current, previous): fsStat's arrays,
 *                                                       zeros when the file is missing (status -errno)
 *   fsWatchClose(id), fsWatchRef(id, ref) */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers: pthread_rwlock_t */
#include <stdlib.h>
#include <string.h>

#include "js_gc.h"
#include "js_node.h"
#include "js_ops.h"
#include "js_uv.h"
#include "jscontext.h"
#include "jsstring.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED (void)callee, (void)this_val, (void)new_target

JSValue js_host_stat_array(JSContext *ctx, const uv_stat_t *s);  /* host_fs.c */

typedef struct Watch {
    union {
        uv_handle_t    handle;
        uv_fs_event_t  event;
        uv_fs_poll_t   poll;
    } u;
    int     id;
    bool    closing;
    JSValue cb;  /* a root */
} Watch;

static Watch **watches;
static size_t nwatches;

static Watch *add_watch(JSContext *ctx, Watch *w, JSValue cb) {
    size_t id = 0;
    while (id < nwatches && watches[id]) id++;
    if (id == nwatches) {
        size_t n = nwatches ? nwatches * 2 : 8;
        Watch **v = realloc(watches, n * sizeof *v);
        if (!v) js_fatal("out of memory in fs.watch");
        memset(v + nwatches, 0, (n - nwatches) * sizeof *v);
        watches = v;
        nwatches = n;
    }
    watches[id] = w;
    w->id = (int)id;
    w->cb = cb;
    js_add_root(ctx->rt, &w->cb);
    return w;
}

static Watch *watch_arg(uint32_t argc, const JSValue *argv) {
    int id = argc > 0 && js_is_int32(argv[0]) ? js_as_int32(argv[0]) : -1;
    Watch *w = id >= 0 && (size_t)id < nwatches ? watches[id] : NULL;
    return w && !w->closing ? w : NULL;
}

/* A string argument as UTF-8, malloc'd; NULL for anything else. */
static char *string_arg(JSContext *ctx, JSValue v) {
    if (!js_is_string(v)) return NULL;
    JSStrView view = js_string_view(ctx, v);
    size_t n = js_view_to_utf8(view, NULL, 0);
    char *s = malloc(n + 1);
    if (!s) js_fatal("out of memory in fs.watch");
    js_view_to_utf8(view, s, n);
    s[n] = '\0';
    return s;
}

static void on_event(uv_fs_event_t *handle, const char *filename, int events, int status) {
    Watch *w = handle->data;
    JSContext *ctx = js_uv_context();
    JSValue args[2] = { js_int32(status < 0 ? status : events), filename ? js_new_string_cstr(ctx, filename) : JS_NULL };
    (void)js_uv_call(w->cb, 2, args, NULL);
}

static void on_poll(uv_fs_poll_t *handle, int status, const uv_stat_t *prev, const uv_stat_t *curr) {
    Watch *w = handle->data;
    JSContext *ctx = js_uv_context();
    JSValue args[3] = { js_int32(status), js_host_stat_array(ctx, curr), JS_UNDEFINED };
    args[2] = js_host_stat_array(ctx, prev);
    (void)js_uv_call(w->cb, 3, args, NULL);
}

PRIMITIVE(js_host_fs_watch_start) {
    UNUSED;
    char *path = argc > 0 ? string_arg(ctx, argv[0]) : NULL;
    if (!path || argc < 3 || !js_is_callable(argv[2])) {
        free(path);
        return js_int32(UV_EINVAL);
    }
    Watch *w = calloc(1, sizeof *w);
    if (!w) js_fatal("out of memory in fs.watch");
    int r = uv_fs_event_init(js_uv_loop(ctx), &w->u.event);
    if (r == 0) {
        w->u.handle.data = w;
        r = uv_fs_event_start(&w->u.event, on_event, path, js_truthy(argv[1]) ? UV_FS_EVENT_RECURSIVE : 0);
        if (r < 0) {  /* initialized: closed through the loop, then freed */
            uv_close(&w->u.handle, (uv_close_cb)free);
            free(path);
            return js_int32(r);
        }
    } else {
        free(w);
    }
    free(path);
    return r < 0 ? js_int32(r) : js_int32(add_watch(ctx, w, argv[2])->id);
}

PRIMITIVE(js_host_fs_poll_start) {
    UNUSED;
    char *path = argc > 0 ? string_arg(ctx, argv[0]) : NULL;
    if (!path || argc < 3 || !js_is_number(argv[1]) || !js_is_callable(argv[2])) {
        free(path);
        return js_int32(UV_EINVAL);
    }
    Watch *w = calloc(1, sizeof *w);
    if (!w) js_fatal("out of memory in fs.watchFile");
    int r = uv_fs_poll_init(js_uv_loop(ctx), &w->u.poll);
    if (r == 0) {
        w->u.handle.data = w;
        r = uv_fs_poll_start(&w->u.poll, on_poll, path, (unsigned)js_as_number(argv[1]));
        if (r < 0) {
            uv_close(&w->u.handle, (uv_close_cb)free);
            free(path);
            return js_int32(r);
        }
    } else {
        free(w);
    }
    free(path);
    return r < 0 ? js_int32(r) : js_int32(add_watch(ctx, w, argv[2])->id);
}

static void on_closed(uv_handle_t *handle) {
    Watch *w = handle->data;
    watches[w->id] = NULL;
    js_remove_root(js_uv_context()->rt, &w->cb);
    free(w);
}

PRIMITIVE(js_host_fs_watch_close) {
    UNUSED;
    (void)ctx;
    Watch *w = watch_arg(argc, argv);
    if (w) {
        w->closing = true;
        uv_close(&w->u.handle, on_closed);
    }
    return JS_UNDEFINED;
}

PRIMITIVE(js_host_fs_watch_ref) {
    UNUSED;
    (void)ctx;
    Watch *w = watch_arg(argc, argv);
    if (w) {
        if (argc > 1 && js_truthy(argv[1])) uv_ref(&w->u.handle);
        else uv_unref(&w->u.handle);
    }
    return JS_UNDEFINED;
}
