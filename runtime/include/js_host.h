/* js_host.h — the host's globals in the runtime: console, process and global,
 * installed before the program runs, and what host packages (node/) build on. Host packages
 * declare their own primitives (node/include/js_node.h); the generated code declares the ones
 * it uses. */
#ifndef JS_HOST_H
#define JS_HOST_H

/* The Node API visaljs implements, as process.version reports it (node/compat.json's), and
 * visaljs's own version, process.versions.visaljs (cli/package.json's). cli/test checks both. */
#define JS_NODE_VERSION "22.22.2"
#define JS_VISALJS_VERSION "0.0.7"

#include "js_function.h"

/* process.c: console, process and global, installed before the program runs (main); the end
 * of the program, after the event loop ended with `status` (0, or 1 after an uncaught error):
 * process's 'beforeExit' (on success; it may run the loop again) and 'exit', and the exit status
 * (process.exitCode); a process warning on stderr */
int js_host_init(JSContext *ctx, int argc, char **argv);
int js_host_exit(JSContext *ctx, int status);
void js_emit_warning(JSContext *ctx, JSValue message, const char *type, const char *code);

/* cwd(): the working directory (process.cwd()), also a host primitive of node:path; -errno on failure. */
JSValue js_host_cwd(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);

#endif /* JS_HOST_H */
