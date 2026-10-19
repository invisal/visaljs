/* The global process, natively: the command line, the environment, the exit
 * status, standard output and error, and warnings. js_host_init installs it with console
 * and global before the program runs. Its events ('beforeExit', 'exit') go through its emit,
 * which it has once node/prelude/internal/process_events.js made it an EventEmitter. */
#define _XOPEN_SOURCE 700  /* getpid, isatty, realpath, environ under -std=c11 */
#include "js_host.h"

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_atoms.h"
#include "js_console.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_exception.h"
#include "js_jobs.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jsstring.h"
#include "os.h"

#ifdef _WIN32
#include <direct.h>
#include <fcntl.h>
#include <io.h>
#include <process.h>
#define getcwd _getcwd
#define getpid _getpid
#define isatty _isatty
#else
#include <unistd.h>
extern char **environ;
#endif

#define NATIVE(name) static JSValue name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, \
                                         const JSValue *argv, JSValue new_target)
#define UNUSED_ARGS (void)callee, (void)this_val, (void)new_target
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

/* cwd(): the working directory: process.cwd(), and node:path's host primitive. */
JSValue js_host_cwd(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                    const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;
    for (size_t cap = 256;; cap *= 2) {
        char *buf = malloc(cap);
        if (!buf) js_fatal("out of memory");
        if (getcwd(buf, cap)) {
            JSValue r = js_new_string_cstr(ctx, buf);
            free(buf);
            return r;
        }
        int e = errno;
        free(buf);
        if (e != ERANGE) return js_int32(-e);
    }
}

static int saved_argc;
static char **saved_argv;
static JSValue process_object;  /* set by js_host_init, a root: the program may delete globalThis.process */
static bool exiting;                           /* 'exit' was emitted: process.exit() now just exits */

/* process.exitCode: undefined, null or an integer */
static enum { EXIT_UNSET, EXIT_NULL, EXIT_SET } exit_state;
static double exit_value;

static int exit_status(void) {
    return exit_state == EXIT_SET ? (int)(int64_t)exit_value : 0;
}

/* process.emit(type, a[, b]): 1 if it had listeners, 0 if not or process has no emit (it isn't
 * an EventEmitter: the program never names one of its methods), -1 after an exception. */
static int emit_event(JSContext *ctx, const char *type, uint32_t argc, JSValue a, JSValue b) {
    JSValue emit = js_get_value(ctx, process_object, js_atom_from_cstr(ctx, "emit"));
    if (js_is_exception(emit)) return -1;
    if (!js_is_callable(emit)) return 0;
    JSValue args[3] = { js_new_string_cstr(ctx, type), a, b };
    if (js_is_exception(args[0])) return -1;
    JSValue r = js_call(ctx, emit, process_object, argc + 1, args);
    return js_is_exception(r) ? -1 : js_truthy(r);
}

/* rt->on_uncaught: a rejection goes to 'unhandledRejection' (reason, promise); an error, or a
 * rejection nobody listens for, to 'uncaughtException' (error, origin), as in Node. A
 * listener's own error: an 'unhandledRejection' one's is uncaught, an 'uncaughtException'
 * one's ends the program with status 7, without 'exit'. */
static int on_uncaught(JSContext *ctx, JSValue error, JSValue promise) {
    const char *origin = "uncaughtException";
    bool rethrown = false;  /* error is an 'unhandledRejection' listener's */
    if (!js_is_undefined(promise)) {
        int had = emit_event(ctx, "unhandledRejection", 2, error, promise);
        if (had > 0) return 0;
        if (had == 0) origin = "unhandledRejection";
        else {
            error = js_take_exception(ctx);
            rethrown = true;
        }
    }
    JSValue name = js_new_string_cstr(ctx, origin);
    int had = js_is_exception(name) ? -1 : emit_event(ctx, "uncaughtException", 2, error, name);
    if (had > 0) return 0;
    if (had < 0) {
        js_report_error(ctx, "Uncaught ", js_take_exception(ctx));
        exiting = true;
        return 7;
    }
    if (!rethrown) return -1;
    js_report_error(ctx, "Uncaught ", error);
    return 1;
}

/* rt->on_handled_late: 'rejectionHandled' (promise) */
static int on_handled_late(JSContext *ctx, JSValue promise) {
    return emit_event(ctx, "rejectionHandled", 1, promise, JS_UNDEFINED) < 0 ? -1 : 0;
}

/* 'exit', with process.exitCode (0 when unset): once, whichever way the program ends. */
static int emit_exit(JSContext *ctx) {
    if (exiting) return 0;
    exiting = true;
    return emit_event(ctx, "exit", 1, js_number(exit_state == EXIT_SET ? exit_value : 0), JS_UNDEFINED);
}

int js_host_exit(JSContext *ctx, int status) {
    /* 'beforeExit' each time the loop empties, while its listeners give it more to do */
    while (status == 0) {
        int had = emit_event(ctx, "beforeExit", 1, js_number(exit_state == EXIT_SET ? exit_value : 0), JS_UNDEFINED);
        if (had == 0) break;
        if (had < 0 && (status = js_report_uncaught(ctx))) break;
        if (js_run_microtasks(ctx) < 0) status = ctx->rt->failure;
        else if (!js_event_loop_alive(ctx)) break;
        else status = js_run_event_loop(ctx, JS_UNDEFINED);
    }
    if (status != 0) {  /* process.exitCode is the failure's status, as in Node */
        exit_state = EXIT_SET;
        exit_value = status;
    }
    if (emit_exit(ctx) < 0 && (status = js_report_uncaught(ctx))) return status;
    return exit_status();
}

/* ---- Node's argument errors -------------------------------------------------------------- */

static JSValue throw_with_code(JSContext *ctx, JSErrorKind kind, const char *code, JSValue message) {
    JSValue err = js_new_error(ctx, kind, message);
    if (js_is_exception(err)) return err;
    JSValue c = js_new_string_cstr(ctx, code);
    if (js_is_exception(c)) return c;
    js_define_data(ctx, js_as_object(err), js_atom_from_cstr(ctx, "code"), c, JS_PROP_DEFAULT);
    return js_throw(ctx, err);
}

/* Node's determineSpecificType: "type number (1.5)", "an instance of Object", "function f", … */
static JSValue specific_type(JSContext *ctx, JSValue v) {
    char buf[64];
    if (js_is_null(v)) return js_new_string_cstr(ctx, "null");
    if (js_is_undefined(v)) return js_new_string_cstr(ctx, "undefined");
    if (js_is_function(v)) {
        JSValue name = js_get_value(ctx, v, JS_ATOM(name));
        if (!js_is_exception(name)) name = js_to_string(ctx, name);
        JSValue prefix = js_new_string_cstr(ctx, "function ");
        return js_is_exception(name) || js_is_exception(prefix) ? JS_EXCEPTION : js_concat(ctx, prefix, name);
    }
    if (js_is_object(v)) {
        JSValue ctor = js_get_value(ctx, v, JS_ATOM(constructor));
        if (js_is_exception(ctor)) return ctor;
        if (js_is_object(ctor)) {
            int has = js_has_property(ctx, js_as_object(ctor), JS_ATOM(name));
            if (has < 0) return JS_EXCEPTION;
            if (has) {
                JSValue name = js_get_value(ctx, ctor, JS_ATOM(name));
                if (!js_is_exception(name)) name = js_to_string(ctx, name);
                JSValue prefix = js_new_string_cstr(ctx, "an instance of ");
                return js_is_exception(name) || js_is_exception(prefix) ? JS_EXCEPTION : js_concat(ctx, prefix, name);
            }
        }
        JSInspectOptions o = js_inspect_defaults;
        o.depth = -1;
        return js_inspect_with(ctx, v, &o);
    }
    if (js_is_string(v)) {
        if (js_string_length(v) > 28) {
            JSValue dots = js_new_string_cstr(ctx, "...");
            if (js_is_exception(dots)) return dots;
            v = js_concat(ctx, js_substring(ctx, v, 0, 25), dots);
            if (js_is_exception(v)) return v;
        }
        JSValue quoted = js_inspect(ctx, v);  /* '…', or "…" when it has a ' (JSON.stringify) */
        JSValue prefix = js_new_string_cstr(ctx, "type string (");
        JSValue suffix = js_new_string_cstr(ctx, ")");
        if (js_is_exception(quoted) || js_is_exception(prefix) || js_is_exception(suffix)) return JS_EXCEPTION;
        JSValue s = js_concat(ctx, prefix, quoted);
        return js_is_exception(s) ? s : js_concat(ctx, s, suffix);
    }
    const char *type = js_is_number(v) ? "number" : js_is_bool(v) ? "boolean" : js_is_symbol(v) ? "symbol" : "bigint";
    JSValue shown = js_is_symbol(v) ? js_symbol_descriptive_string(ctx, v) : js_inspect(ctx, v);
    if (js_is_exception(shown)) return shown;
    snprintf(buf, sizeof buf, "type %s (", type);
    JSValue prefix = js_new_string_cstr(ctx, buf);
    JSValue suffix = js_new_string_cstr(ctx, ")");
    if (js_is_exception(prefix) || js_is_exception(suffix)) return JS_EXCEPTION;
    JSValue s = js_concat(ctx, prefix, shown);
    return js_is_exception(s) ? s : js_concat(ctx, s, suffix);
}

/* ERR_INVALID_ARG_TYPE: `The "code" argument must be of type number. Received type string ('x')` */
static JSValue invalid_arg_type(JSContext *ctx, const char *name, const char *expected, JSValue v) {
    char buf[160];
    snprintf(buf, sizeof buf, "The \"%s\" argument must be %s. Received ", name, expected);
    JSValue prefix = js_new_string_cstr(ctx, buf);
    JSValue type = specific_type(ctx, v);
    if (js_is_exception(prefix) || js_is_exception(type)) return JS_EXCEPTION;
    JSValue m = js_concat(ctx, prefix, type);
    return js_is_exception(m) ? m : throw_with_code(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", m);
}

/* process.exitCode's rule: undefined, null, or an integer (an integer string is converted). */
static int check_code(JSContext *ctx, JSValue *code) {
    JSValue v = *code;
    if (js_is_nullish(v)) return 0;
    if (js_is_string(v) && js_string_length(v) != 0) {
        double d;
        if (js_to_number(ctx, &d, v)) return -1;
        if (isfinite(d) && d == floor(d)) v = js_number(d);
    }
    if (!js_is_number(v)) {
        JSValue e = invalid_arg_type(ctx, "code", "of type number", *code);
        (void)e;
        return -1;
    }
    double d = js_as_number(v);
    if (!isfinite(d) || d != floor(d)) {
        JSValue shown = js_number_to_string(ctx, v);
        JSValue prefix = js_new_string_cstr(ctx, "The value of \"code\" is out of range. It must be an integer. Received ");
        if (js_is_exception(shown) || js_is_exception(prefix)) return -1;
        JSValue m = js_concat(ctx, prefix, shown);
        if (!js_is_exception(m)) {
            JSValue e = throw_with_code(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", m);
            (void)e;
        }
        return -1;
    }
    *code = v;
    return 0;
}

/* ---- process's functions ------------------------------------------------------------------- */

NATIVE(exit_code_get) {
    UNUSED_ARGS;
    (void)ctx, (void)argc, (void)argv;
    return exit_state == EXIT_SET ? js_number(exit_value) : exit_state == EXIT_NULL ? JS_NULL : JS_UNDEFINED;
}

NATIVE(exit_code_set) {
    UNUSED_ARGS;
    JSValue code = ARG(0);
    if (check_code(ctx, &code) < 0) return JS_EXCEPTION;
    exit_state = js_is_undefined(code) ? EXIT_UNSET : js_is_null(code) ? EXIT_NULL : EXIT_SET;
    exit_value = js_is_number(code) ? js_as_number(code) : 0;
    return JS_UNDEFINED;
}

/* exit(code): process.exitCode = code (when given), 'exit' (unless it's running), then the end. */
NATIVE(process_exit) {
    UNUSED_ARGS;
    if (!js_is_undefined(ARG(0)) && js_is_exception(exit_code_set(ctx, JS_UNDEFINED, JS_UNDEFINED, 1, argv, JS_UNDEFINED)))
        return JS_EXCEPTION;
    if (emit_exit(ctx) < 0) (void)js_report_uncaught(ctx);  /* the status stays the one asked for */
    fflush(stdout);
    fflush(stderr);
    exit(exit_status());
}

NATIVE(process_cwd) {
    UNUSED_ARGS;
    (void)argc, (void)argv;
    JSValue dir = js_host_cwd(ctx, JS_UNDEFINED, JS_UNDEFINED, 0, NULL, JS_UNDEFINED);
    if (js_is_number(dir)) return js_throw_type_error(ctx, "process.cwd() failed");
    return dir;
}

#ifndef _WIN32
/* getuid, geteuid, getgid, getegid: the process's ids (POSIX; Node has none of them on Windows) */
NATIVE(process_getuid) { UNUSED_ARGS; (void)ctx, (void)argc, (void)argv; return js_number((double)getuid()); }
NATIVE(process_geteuid) { UNUSED_ARGS; (void)ctx, (void)argc, (void)argv; return js_number((double)geteuid()); }
NATIVE(process_getgid) { UNUSED_ARGS; (void)ctx, (void)argc, (void)argv; return js_number((double)getgid()); }
NATIVE(process_getegid) { UNUSED_ARGS; (void)ctx, (void)argc, (void)argv; return js_number((double)getegid()); }
#endif

/* nextTick(callback, ...args): Node runs these before promise jobs; visaljs queues them
 * with them. */
NATIVE(process_next_tick) {
    UNUSED_ARGS;
    if (!js_is_callable(ARG(0))) return invalid_arg_type(ctx, "callback", "of type function", ARG(0));
    JSValue args = JS_UNDEFINED;
    if (argc > 1) {
        args = js_new_array_from(ctx, argv + 1, argc - 1);
        if (js_is_exception(args)) return args;
    }
    JSJob job = { JS_JOB_CALLBACK, NULL, argv[0], args, JS_UNDEFINED, JS_UNDEFINED };
    js_enqueue_microtask(ctx, &job);
    return JS_UNDEFINED;
}

NATIVE(process_hrtime) {
    UNUSED_ARGS;
    double ms = js_os_now_ms_precise();
    double sec = floor(ms / 1000), nsec = floor(fmod(ms, 1000) * 1e6);
    JSValue prev = ARG(0);
    if (js_is_array(prev)) {
        JSValue s = js_get_elem(ctx, prev, js_index_key(0)), n = js_get_elem(ctx, prev, js_index_key(1));
        if (js_is_exception(s) || js_is_exception(n)) return JS_EXCEPTION;
        sec -= js_is_number(s) ? js_as_number(s) : 0;
        nsec -= js_is_number(n) ? js_as_number(n) : 0;
        if (nsec < 0) {
            sec -= 1;
            nsec += 1e9;
        }
    }
    JSValue items[2] = { js_number(sec), js_number(nsec) };
    return js_new_array_from(ctx, items, 2);
}

/* process.hrtime.bigint(): the time in nanoseconds; a program that calls it has BigInt */
NATIVE(process_hrtime_bigint) {
    UNUSED_ARGS, (void)argc, (void)argv;
    if (!ctx->rt->bigint) return js_throw_type_error(ctx, "BigInt is not available");
    return ctx->rt->bigint->from_uint64(ctx, (uint64_t)(js_os_now_ms_precise() * 1e6));
}

void js_emit_warning(JSContext *ctx, JSValue message, const char *type, const char *code) {
    const char *quiet = getenv("NODE_NO_WARNINGS");  /* as Node: "1" silences them */
    if (quiet && strcmp(quiet, "1") == 0) return;
    char prefix[96];
    snprintf(prefix, sizeof prefix, "(node:%d) %s%s%s%s: ", (int)getpid(), code ? "[" : "", code ? code : "", code ? "] " : "", type);
    fflush(stdout);
    fputs(prefix, stderr);
    js_write_output(ctx, 2, message);
    fputc('\n', stderr);
    /* after the first warning, Node's hint (it names node, whose flags it is) */
    static bool hinted;
    if (!hinted) {
        hinted = true;
        fprintf(stderr, "(Use `node %s ...` to show where the warning was created)\n",
                strcmp(type, "DeprecationWarning") == 0 ? "--trace-deprecation" : "--trace-warnings");
    }
}

/* emitWarning(warning, type | { type, code }, code): "(node:PID) Warning: …" on stderr. */
NATIVE(process_emit_warning) {
    UNUSED_ARGS;
    JSValue warning = ARG(0), type = ARG(1), code = ARG(2);
    if (js_is_object(type) && !js_is_function(type)) {
        JSValue options = type;
        type = js_get_value(ctx, options, js_atom_from_cstr(ctx, "type"));
        code = js_get_value(ctx, options, js_atom_from_cstr(ctx, "code"));
        if (js_is_exception(type) || js_is_exception(code)) return JS_EXCEPTION;
    }
    JSValue message = warning;
    JSValue name = js_is_string(type) ? type : js_new_string_cstr(ctx, "Warning");
    if (js_is_error(warning)) {
        name = js_get_value(ctx, warning, JS_ATOM(name));
        message = js_get_value(ctx, warning, JS_ATOM(message));
    }
    if (js_is_exception(name) || js_is_exception(message)) return JS_EXCEPTION;
    message = js_to_string(ctx, message);
    name = js_to_string(ctx, name);
    JSValue code_str = js_truthy(code) ? js_to_string(ctx, code) : JS_UNDEFINED;
    if (js_is_exception(message) || js_is_exception(name) || js_is_exception(code_str)) return JS_EXCEPTION;
    char small_name[128], small_code[128];
    size_t n = js_view_to_utf8(js_string_view(ctx, name), small_name, sizeof small_name - 1);
    small_name[n < sizeof small_name ? n : sizeof small_name - 1] = '\0';
    if (strcmp(small_name, "DeprecationWarning") == 0 && js_is_object(process_object)) {  /* silenced as the program runs, as in Node */
        JSValue silenced = js_get_value(ctx, process_object, js_atom_from_cstr(ctx, "noDeprecation"));
        if (js_is_exception(silenced)) return JS_EXCEPTION;
        if (js_truthy(silenced)) return JS_UNDEFINED;
    }
    if (!js_is_undefined(code_str)) {
        size_t c = js_view_to_utf8(js_string_view(ctx, code_str), small_code, sizeof small_code - 1);
        small_code[c < sizeof small_code ? c : sizeof small_code - 1] = '\0';
    }
    js_emit_warning(ctx, message, small_name, js_is_undefined(code_str) ? NULL : small_code);
    return JS_UNDEFINED;
}

/* stdout.write / stderr.write(chunk, encoding, callback): a string as UTF-8, a typed array or a
 * DataView as its bytes; anything else is Node's TypeError */
static JSValue stream_write(JSContext *ctx, int fd, uint32_t argc, const JSValue *argv) {
    JSValue chunk = ARG(0);
    uint8_t *data;
    size_t length;
    if (js_is_string(chunk)) js_write_output(ctx, fd, chunk);
    else if (ctx->rt->view_bytes && ctx->rt->view_bytes(chunk, &data, &length)) js_write_bytes(fd, data, length);
    else if (js_is_null(chunk)) {
        JSValue m = js_new_string_cstr(ctx, "May not write null values to stream");
        return js_is_exception(m) ? m : throw_with_code(ctx, JS_TYPE_ERROR, "ERR_STREAM_NULL_VALUES", m);
    } else return invalid_arg_type(ctx, "chunk", "of type string or an instance of Buffer, TypedArray, or DataView", chunk);
    JSValue callback = js_is_callable(ARG(1)) ? ARG(1) : ARG(2);
    if (js_is_callable(callback)) {
        JSJob job = { JS_JOB_CALLBACK, NULL, callback, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
        js_enqueue_microtask(ctx, &job);
    }
    return JS_TRUE;
}

NATIVE(stdout_write) {
    UNUSED_ARGS;
    return stream_write(ctx, 1, argc, argv);
}

NATIVE(stderr_write) {
    UNUSED_ARGS;
    return stream_write(ctx, 2, argc, argv);
}

/* ---- Building process ------------------------------------------------------------------------ */

static void define(JSContext *ctx, JSObject *o, const char *name, JSValue v) {
    js_define_data(ctx, o, js_atom_from_cstr(ctx, name), v, JS_PROP_DEFAULT);
}

static void define_fn(JSContext *ctx, JSObject *o, const char *name, JSNativeFn fn, uint32_t length) {
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue f = js_new_native(ctx, fn, key, length, JS_FN_STRICT);
    if (!js_is_exception(f)) js_define_data(ctx, o, key, f, JS_PROP_DEFAULT);
}

static JSValue new_stream(JSContext *ctx, int fd, JSNativeFn write) {
    JSValue s = js_new_object(ctx);
    if (js_is_exception(s)) return s;
    JSObject *o = js_as_object(s);
    define(ctx, o, "fd", js_int32(fd));
    define_fn(ctx, o, "write", write, 3);
    if (isatty(fd)) define(ctx, o, "isTTY", JS_TRUE);
    return s;
}

static const char *platform(void) {
#if defined(_WIN32)
    return "win32";
#elif defined(__APPLE__)
    return "darwin";
#elif defined(__FreeBSD__)
    return "freebsd";
#else
    return "linux";
#endif
}

static const char *arch(void) {
#if defined(__x86_64__) || defined(_M_X64)
    return "x64";
#elif defined(__aarch64__) || defined(_M_ARM64)
    return "arm64";
#elif defined(__i386__) || defined(_M_IX86)
    return "ia32";
#elif defined(__arm__)
    return "arm";
#else
    return "unknown";
#endif
}

static JSValue new_process(JSContext *ctx) {
    JSValue process = js_new_object(ctx);
    if (js_is_exception(process)) return process;
    JSObject *p = js_as_object(process);

    /* argv: Node's is the executable, then the script; a compiled program is both */
    const char *argv0 = saved_argc > 0 ? saved_argv[0] : "";
    char resolved[PATH_MAX];
#ifdef _WIN32
    const char *exec_path = _fullpath(resolved, argv0, sizeof resolved) ? resolved : argv0;
#else
    const char *exec_path = strchr(argv0, '/') && realpath(argv0, resolved) ? resolved : argv0;
#endif
    JSValue exec = js_new_string_cstr(ctx, exec_path);
    JSValue args = js_new_array(ctx, 0);
    if (js_is_exception(exec) || js_is_exception(args)) return JS_EXCEPTION;
    JSObject *a = js_as_object(args);
    if (js_array_push(ctx, a, exec) < 0 || js_array_push(ctx, a, exec) < 0) return JS_EXCEPTION;
    for (int i = 1; i < saved_argc; i++) {
        JSValue s = js_new_string_cstr(ctx, saved_argv[i]);
        if (js_is_exception(s) || js_array_push(ctx, a, s) < 0) return JS_EXCEPTION;
    }
    define(ctx, p, "argv", args);
    define(ctx, p, "argv0", js_new_string_cstr(ctx, argv0));
    define(ctx, p, "execArgv", js_new_array(ctx, 0));  /* Node's own options: a compiled program has none */
    define(ctx, p, "execPath", exec);

    /* env: a snapshot (writes don't reach the C environment) */
    JSValue env = js_new_object(ctx);
    if (js_is_exception(env)) return env;
    for (size_t i = 0; environ && environ[i]; i++) {
        const char *eq = strchr(environ[i] + 1, '=');
        if (!eq) continue;
        JSValue name = js_new_string_utf8(ctx, environ[i], (size_t)(eq - environ[i]));
        JSValue value = js_new_string_cstr(ctx, eq + 1);
        if (js_is_exception(name) || js_is_exception(value)) return JS_EXCEPTION;
        JSValue key = js_to_property_key(ctx, name);
        if (js_is_exception(key)) return key;
        js_define_data(ctx, js_as_object(env), key, value, JS_PROP_DEFAULT);
    }
    define(ctx, p, "env", env);
    define(ctx, p, "pid", js_int32((int32_t)getpid()));
    /* version and versions: the Node API implemented, and visaljs's own; read-only, as Node's,
       and versions extensible (Electron's tooling adds to it) */
    js_define_data(ctx, p, js_atom_from_cstr(ctx, "version"), js_new_string_cstr(ctx, "v" JS_NODE_VERSION), JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE);
    JSValue versions = js_new_object(ctx);
    if (js_is_exception(versions)) return versions;
    js_define_data(ctx, js_as_object(versions), js_atom_from_cstr(ctx, "node"), js_new_string_cstr(ctx, JS_NODE_VERSION), JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, js_as_object(versions), js_atom_from_cstr(ctx, "visaljs"), js_new_string_cstr(ctx, JS_VISALJS_VERSION), JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, p, js_atom_from_cstr(ctx, "versions"), versions, JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE);
    /* features: what this build has, in Node 24's names. No inspector, TLS from
       BoringSSL without OCSP stapling, require() of ES modules, no QUIC, no type stripping */
    static const struct { const char *name; bool on; } features[] = {
        { "inspector", false }, { "debug", false }, { "uv", true }, { "ipv6", true },
        { "tls_alpn", true }, { "tls_sni", true }, { "tls_ocsp", false }, { "tls", true },
        { "openssl_is_boringssl", true }, { "cached_builtins", true }, { "require_module", true }, { "quic", false },
        { "typescript", false },
    };
    JSValue feats = js_new_object(ctx);
    if (js_is_exception(feats)) return feats;
    for (size_t i = 0; i < sizeof features / sizeof features[0]; i++)
        define(ctx, js_as_object(feats), features[i].name, js_bool(features[i].on));
    define(ctx, p, "features", feats);
    define(ctx, p, "platform", js_new_string_cstr(ctx, platform()));
    define(ctx, p, "arch", js_new_string_cstr(ctx, arch()));
    define(ctx, p, "stdout", new_stream(ctx, 1, stdout_write));
    define(ctx, p, "stderr", new_stream(ctx, 2, stderr_write));
    define_fn(ctx, p, "cwd", process_cwd, 0);
#ifndef _WIN32
    define_fn(ctx, p, "getuid", process_getuid, 0);
    define_fn(ctx, p, "geteuid", process_geteuid, 0);
    define_fn(ctx, p, "getgid", process_getgid, 0);
    define_fn(ctx, p, "getegid", process_getegid, 0);
#endif
    define_fn(ctx, p, "exit", process_exit, 1);
    define_fn(ctx, p, "nextTick", process_next_tick, 1);
    {
        JSValue key = js_atom_from_cstr(ctx, "hrtime");
        JSValue hrtime = js_new_native(ctx, process_hrtime, key, 1, JS_FN_STRICT);
        if (js_is_exception(hrtime)) return JS_EXCEPTION;
        define_fn(ctx, js_as_object(hrtime), "bigint", process_hrtime_bigint, 0);
        js_define_data(ctx, p, key, hrtime, JS_PROP_DEFAULT);
    }
    define_fn(ctx, p, "emitWarning", process_emit_warning, 3);
    /* exitCode: an accessor, as in Node (enumerable, not configurable) */
    JSValue get = js_new_native(ctx, exit_code_get, js_atom_from_cstr(ctx, "get exitCode"), 0, JS_FN_STRICT);
    JSValue set = js_new_native(ctx, exit_code_set, js_atom_from_cstr(ctx, "set exitCode"), 1, JS_FN_STRICT);
    if (js_is_exception(get) || js_is_exception(set)) return JS_EXCEPTION;
    JSPropertyDescriptor d = { JS_DESC_GET | JS_DESC_SET | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE, JS_PROP_ENUMERABLE,
                               JS_UNDEFINED, get, set };
    if (js_define_own_property(ctx, p, js_atom_from_cstr(ctx, "exitCode"), &d, true) < 0) return JS_EXCEPTION;
    return process;
}

/* Node's globals the runtime doesn't have: console, process and global. */
int js_host_init(JSContext *ctx, int argc, char **argv) {
    saved_argc = argc;
    saved_argv = argv;
#ifdef _WIN32
    /* bytes as written, as Node writes them: the CRT's text mode would turn \n into \r\n */
    _setmode(0, _O_BINARY);
    _setmode(1, _O_BINARY);
    _setmode(2, _O_BINARY);
#endif
    JSValue global = ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT];
    JSObject *g = js_as_object(global);
    JSValue console = js_new_console(ctx);
    if (js_is_exception(console)) return -1;
    js_define_data(ctx, g, js_atom_from_cstr(ctx, "console"), console, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    JSValue process = new_process(ctx);
    if (js_is_exception(process)) return -1;
    process_object = process;
    js_add_root(ctx->rt, &process_object);
    ctx->rt->on_uncaught = on_uncaught;
    ctx->rt->on_handled_late = on_handled_late;
    js_define_data(ctx, g, js_atom_from_cstr(ctx, "process"), process, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, g, js_atom_from_cstr(ctx, "global"), global, JS_PROP_DEFAULT);
    return 0;
}
