/* Host primitives for process's signal events and process.kill (prelude/internal/
 * process_signals.js), on libuv's signal handles. A watched signal's handle is unref'd: like
 * Node's, it doesn't keep the program alive.
 *
 *   signalStart(signum, cb) → 0 | -errno   cb(signum) from the loop each time the signal arrives
 *   signalStop(signum)                      the default action again
 *   processKill(pid, signum) → 0 | -errno */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers: pthread_rwlock_t */
#include "js_gc.h"
#include "js_node.h"
#include "js_ops.h"
#include "js_uv.h"
#include "jscontext.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED (void)callee, (void)this_val, (void)new_target
#define MAX_SIGNAL 65  /* above Linux's SIGRTMAX */

static struct {
    uv_signal_t handle;
    bool        open;
    JSValue     cb;  /* a root once open */
} watches[MAX_SIGNAL];

static void on_signal(uv_signal_t *handle, int signum) {
    (void)handle;
    JSValue arg = js_int32(signum);
    (void)js_uv_call(watches[signum].cb, 1, &arg, NULL);
}

static int signal_arg(uint32_t argc, const JSValue *argv) {
    int signum = argc > 0 && js_is_int32(argv[0]) ? js_as_int32(argv[0]) : 0;
    return signum > 0 && signum < MAX_SIGNAL ? signum : 0;
}

PRIMITIVE(js_host_signal_start) {
    UNUSED;
    int signum = signal_arg(argc, argv);
    if (!signum || argc < 2 || !js_is_callable(argv[1])) return js_int32(UV_EINVAL);
    if (!watches[signum].open) {
        int r = uv_signal_init(js_uv_loop(ctx), &watches[signum].handle);
        if (r < 0) return js_int32(r);
        uv_unref((uv_handle_t *)&watches[signum].handle);
        watches[signum].cb = JS_UNDEFINED;
        js_add_root(ctx->rt, &watches[signum].cb);
        watches[signum].open = true;
    }
    int r = uv_signal_start(&watches[signum].handle, on_signal, signum);
    if (r == 0) watches[signum].cb = argv[1];
    return js_int32(r);
}

PRIMITIVE(js_host_signal_stop) {
    UNUSED;
    (void)ctx;
    int signum = signal_arg(argc, argv);
    if (signum && watches[signum].open) {
        uv_signal_stop(&watches[signum].handle);
        watches[signum].cb = JS_UNDEFINED;
    }
    return JS_UNDEFINED;
}

PRIMITIVE(js_host_process_kill) {
    UNUSED;
    (void)ctx;
    if (argc < 2 || !js_is_number(argv[0]) || !js_is_int32(argv[1])) return js_int32(UV_EINVAL);
    return js_int32(uv_kill((int)js_as_number(argv[0]), js_as_int32(argv[1])));
}
