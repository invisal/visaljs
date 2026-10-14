/* js_uv.h — the libuv loop the host modules share: node:http's
 * servers and node:net's sockets run on it. Host C only, not the prelude. */
#ifndef JS_UV_H
#define JS_UV_H

#include "js_runtime.h"
#include "uv.h"

/* The loop, created and installed as the runtime's I/O backend on first use. */
uv_loop_t *js_uv_loop(JSContext *ctx);

/* The realm I/O callbacks run in. */
JSContext *js_uv_context(void);

/* Calls a JS callback from an I/O callback, then the microtasks, as Node's MakeCallback does;
 * an uncaught error ends the loop with its status. False once the loop is failing; otherwise
 * the callback's result goes to *result, when given. */
bool js_uv_call(JSValue fn, uint32_t argc, JSValue *argv, JSValue *result);
/* JS is running around what follows (a primitive called from JS that makes js_uv_calls): those
 * calls leave microtasks and output to the outermost one, as calls nested in a js_uv_call do.
 * js_uv_nest(1) before, js_uv_nest(-1) after. */
void js_uv_nest(int delta);
/* After work done under js_uv_nest from an I/O callback (no JS on the stack): the microtasks run
 * and output goes out, as at the end of a js_uv_call. False once the loop is failing. */
bool js_uv_drain(void);

/* A hook run before the loop waits and after every callback: node:http sends its corked output. */
void js_uv_set_flush(void (*flush)(void));

/* node:net's handles, for node:http, which parses a socket's bytes in C as Node does: a hook
 * sees the socket's reads before JS, and hears when the handle closes. */
typedef struct JSNetHook {
    bool (*read)(void *data, ssize_t n, const char *bytes);  /* true: handled (JS doesn't see it) */
    void (*close)(void *data);
} JSNetHook;

/* The open handle's stream, or NULL. */
uv_stream_t *js_net_stream(int id);

/* Hooks the handle's reads (NULL unhooks): false when it isn't open. */
bool js_net_hook(int id, const JSNetHook *hook, void *data);

#endif /* JS_UV_H */
