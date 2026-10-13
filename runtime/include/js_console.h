/*
 * js_console.h — console, util.inspect and util.format, in C: Node's
 * algorithms, so output matches Node's byte for byte. Also the test host's print and the
 * uncaught-error report.
 */
#ifndef JS_CONSOLE_H
#define JS_CONSOLE_H

#include "js_function.h"

/* util.inspect's options (the ones visaljs honors; colors are always off). */
typedef struct JSInspectOptions {
    bool   show_hidden;
    double depth;              /* INFINITY for null */
    bool   custom_inspect;
    double max_array_length;   /* INFINITY for null */
    double max_string_length;
    double break_length;
    int    compact;            /* -1 for true, 0 for false, else a number */
    bool   sorted;             /* true: entries in the default sort order (a comparator isn't supported) */
    int    getters;            /* JS_INSPECT_GETTERS_*: which getters are called to show their value */
} JSInspectOptions;

enum { JS_INSPECT_GETTERS_OFF, JS_INSPECT_GETTERS_ALL, JS_INSPECT_GETTERS_GET, JS_INSPECT_GETTERS_SET };

extern const JSInspectOptions js_inspect_defaults;  /* Node's util.inspect.defaultOptions */

/* util.inspect(v) with the default options, or with `o`. */
JS_WARN_UNUSED JSValue js_inspect(JSContext *ctx, JSValue v);
JS_WARN_UNUSED JSValue js_inspect_with(JSContext *ctx, JSValue v, const JSInspectOptions *o);
/* util.format(...args): console.log's text, without the newline; with inspect options. */
JS_WARN_UNUSED JSValue js_format(JSContext *ctx, uint32_t argc, const JSValue *argv);
JS_WARN_UNUSED JSValue js_format_with(JSContext *ctx, const JSInspectOptions *o, uint32_t argc, const JSValue *argv);
/* Reads util.inspect's options object into `o` (unknown keys ignored). 0, or -1. */
JS_WARN_UNUSED int js_inspect_options_from(JSContext *ctx, JSValue opts, JSInspectOptions *o);

/* node:util's inspect, format and formatWithOptions (the host prelude's util.js exports them). */
JSValue js_util_inspect(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);
JSValue js_util_format(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);
JSValue js_util_format_with_options(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);
/* node:util/types' primitive (util_types.c): an object's internal kind as a tag string. */
JSValue js_util_type_tag(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);
/* The util.inspect function custom inspectors receive (one per realm). */
JSValue js_util_inspect_function(JSContext *ctx);

/* Writes a string as UTF-8 (lone surrogates as U+FFFD) to fd 1 or 2; stdout is flushed
 * before anything goes to stderr, so the two interleave as written. */
void js_write_output(JSContext *ctx, int fd, JSValue s);
/* Writes bytes as they are to fd 1 or 2, as js_write_output does a string. */
void js_write_bytes(int fd, const uint8_t *data, size_t length);

/* The global console object. */
JSValue js_new_console(JSContext *ctx);

/* The test host's print: String(argument) and a newline, on stdout. */
JSValue js_print(JSContext *ctx, JSValue callee, JSValue this_val,
                 uint32_t argc, const JSValue *argv, JSValue new_target);

/* An uncaught error, the pending exception (cleared): the host's handler's (rt->on_uncaught),
 * else printed to stderr. 0 when handled (the program goes on), else the exit status: 1, or the
 * handler's. js_report_rejection is the same for the reason of a promise rejected and
 * unhandled, printed "Uncaught (in promise) …". */
int js_report_uncaught(JSContext *ctx);
int js_report_rejection(JSContext *ctx, JSValue promise, JSValue reason);
/* Prints `prefix` and the value as an uncaught error to stderr (e.g. "Uncaught (in promise) "). */
void js_report_error(JSContext *ctx, const char *prefix, JSValue e);

#endif /* JS_CONSOLE_H */
