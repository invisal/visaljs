/* The global console, natively: Node's methods and output, formatted by
 * inspect.c. Also the test host's print and the uncaught-error report. */
#include "js_console.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_atoms.h"
#include "js_builtins.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_exception.h"
#include "js_host.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jsnum.h"
#include "jsstring.h"
#include "os.h"

/* console's methods are core entries (js_core.def): installed only when the program names them */
#define NATIVE(name) JSValue js_core_##name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, \
                                            const JSValue *argv, JSValue new_target)
#define UNUSED_ARGS (void)callee, (void)this_val, (void)new_target
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

/* ---- Output -------------------------------------------------------------------- */

/* A string as UTF-8, lone surrogates as U+FFFD; *out is malloc'd unless it is `small`. */
static size_t utf8_of(JSContext *ctx, JSValue s, char *small, size_t cap, char **out) {
    JSStrView v = js_string_view(ctx, s);
    size_t n = js_view_to_utf8(v, small, cap);
    *out = small;
    if (n > cap) {
        *out = malloc(n);
        if (!*out) js_fatal("out of memory writing output");
        js_view_to_utf8(v, *out, n);
    }
    return n;
}

static FILE *stream(int fd) {
    if (fd == 2) {
        fflush(stdout);
        return stderr;
    }
    return stdout;
}

void js_write_output(JSContext *ctx, int fd, JSValue s) {
    char small[1024], *buf;
    size_t n = utf8_of(ctx, s, small, sizeof small, &buf);
    fwrite(buf, 1, n, stream(fd));
    if (buf != small) free(buf);
}

void js_write_bytes(int fd, const uint8_t *data, size_t length) {
    fwrite(data, 1, length, stream(fd));
}

/* console.group's indentation, in spaces */
static size_t group_indent;

/* One line of console output: every line indented by the groups, then a newline. stdio
 * buffers it (fully when redirected, by line on a terminal) and flushes at exit and before the
 * event loop waits (js_run_event_loop). */
static void emit(int fd, const char *s, size_t n) {
    FILE *out = stream(fd);
    size_t start = 0;
    for (size_t i = 0; i <= n; i++) {
        if (i < n && s[i] != '\n') continue;
        for (size_t k = 0; k < group_indent; k++) fputc(' ', out);
        fwrite(s + start, 1, i - start + (i < n), out);
        start = i + 1;
    }
    fputc('\n', out);
}

static void emit_string(JSContext *ctx, int fd, JSValue s) {
    char small[1024], *buf;
    size_t n = utf8_of(ctx, s, small, sizeof small, &buf);
    emit(fd, buf, n);
    if (buf != small) free(buf);
}

/* console.log's line: util.format of the arguments. */
static JSValue print_args(JSContext *ctx, int fd, uint32_t argc, const JSValue *argv) {
    JSValue s = js_format(ctx, argc, argv);
    if (js_is_exception(s)) return s;
    emit_string(ctx, fd, s);
    return JS_UNDEFINED;
}

/* ---- console's methods ---------------------------------------------------------------- */

NATIVE(console_log) {
    UNUSED_ARGS;
    return print_args(ctx, 1, argc, argv);
}

NATIVE(console_error) {
    UNUSED_ARGS;
    return print_args(ctx, 2, argc, argv);
}

NATIVE(console_dir) {
    UNUSED_ARGS;
    JSInspectOptions o = js_inspect_defaults;
    o.custom_inspect = false;
    if (js_inspect_options_from(ctx, ARG(1), &o) < 0) return JS_EXCEPTION;
    JSValue s = js_inspect_with(ctx, ARG(0), &o);
    if (js_is_exception(s)) return s;
    emit_string(ctx, 1, s);
    return JS_UNDEFINED;
}

NATIVE(console_assert) {
    UNUSED_ARGS;
    if (js_truthy(ARG(0))) return JS_UNDEFINED;
    uint32_t n = argc > 1 ? argc - 1 : 0;
    JSValue *args = malloc((n + 1) * sizeof *args);
    if (!args) js_fatal("out of memory");
    JSValue failed = js_new_string_cstr(ctx, "Assertion failed");
    JSValue r = failed;
    if (!js_is_exception(failed)) {
        if (n && js_is_string(argv[1])) {
            /* "Assertion failed: " + the message, which can hold format specifiers */
            JSValue colon = js_new_string_cstr(ctx, "Assertion failed: ");
            args[0] = js_is_exception(colon) ? colon : js_concat(ctx, colon, argv[1]);
            for (uint32_t i = 1; i < n; i++) args[i] = argv[i + 1];
        } else {
            args[0] = failed;
            for (uint32_t i = 0; i < n; i++) args[i + 1] = argv[i + 1];
            n++;
        }
        JSValue first = args[0];
        r = js_is_exception(first) ? first : print_args(ctx, 2, n ? n : 1, args);
        js_keep_alive(first);  /* args is malloc'd: the scan doesn't see it */
    }
    free(args);
    return r;
}

/* A key in console's state for `label`: "count:" or "time:" and the label. */
static JSValue state_key(JSContext *ctx, const char *kind, JSValue label) {
    JSValue l = js_is_undefined(label) ? js_new_string_cstr(ctx, "default") : js_to_string(ctx, label);
    if (js_is_exception(l)) return l;
    JSValue prefix = js_new_string_cstr(ctx, kind);
    if (js_is_exception(prefix)) return prefix;
    JSValue k = js_concat(ctx, prefix, l);
    return js_is_exception(k) ? k : js_to_property_key(ctx, k);
}

static JSObject *state(JSContext *ctx) {
    JSValue *slot = &ctx->intrinsics[JS_INTRINSIC_CONSOLE_STATE];
    if (!js_is_object(*slot)) *slot = js_new_object_proto(ctx, JS_NULL, JS_DEFAULT_INLINE_SLOTS);
    return js_as_object(*slot);
}

/* The label as console prints it: String(label), "default" when absent. */
static JSValue label_string(JSContext *ctx, JSValue label) {
    return js_is_undefined(label) ? js_new_string_cstr(ctx, "default") : js_to_string(ctx, label);
}

NATIVE(console_count) {
    UNUSED_ARGS;
    JSValue key = state_key(ctx, "count:", ARG(0));
    JSValue label = label_string(ctx, ARG(0));
    if (js_is_exception(key) || js_is_exception(label)) return JS_EXCEPTION;
    JSObject *st = state(ctx);
    JSValue n = js_get(ctx, st, key, js_object_value(st));
    if (js_is_exception(n)) return n;
    int32_t count = js_is_int32(n) ? js_as_int32(n) + 1 : 1;
    js_define_data(ctx, st, key, js_int32(count), JS_PROP_DEFAULT);
    char suffix[24];
    snprintf(suffix, sizeof suffix, ": %d", count);
    JSValue s = js_new_string_cstr(ctx, suffix);
    if (js_is_exception(s)) return s;
    s = js_concat(ctx, label, s);
    if (js_is_exception(s)) return s;
    emit_string(ctx, 1, s);
    return JS_UNDEFINED;
}

NATIVE(console_count_reset) {
    UNUSED_ARGS;
    JSValue key = state_key(ctx, "count:", ARG(0));
    if (js_is_exception(key)) return key;
    JSObject *st = state(ctx);
    JSValue n = js_get(ctx, st, key, js_object_value(st));
    if (js_is_exception(n)) return n;
    if (js_is_int32(n)) js_define_data(ctx, st, key, js_int32(0), JS_PROP_DEFAULT);
    return JS_UNDEFINED;
}

NATIVE(console_group) {
    UNUSED_ARGS;
    if (argc) {
        JSValue r = print_args(ctx, 1, argc, argv);
        if (js_is_exception(r)) return r;
    }
    group_indent += 2;
    return JS_UNDEFINED;
}

NATIVE(console_group_end) {
    (void)ctx, (void)argc, (void)argv;
    UNUSED_ARGS;
    group_indent = group_indent >= 2 ? group_indent - 2 : 0;
    return JS_UNDEFINED;
}

/* Node's formatTime: "12.345ms", "1.500s", "1:02.003 (m:ss.mmm)". */
static void format_time(char *out, size_t cap, double ms) {
    double hours = 0, minutes = 0, seconds = 0;
    if (ms >= 1000) {
        if (ms >= 60000) {
            if (ms >= 3600000) {
                hours = floor(ms / 3600000);
                ms = fmod(ms, 3600000);
            }
            minutes = floor(ms / 60000);
            ms = fmod(ms, 60000);
        }
        seconds = ms / 1000;
    }
    if (hours != 0 || minutes != 0) {
        char sec[32];
        snprintf(sec, sizeof sec, "%06.3f", seconds);  /* ss.mmm */
        if (hours != 0) snprintf(out, cap, "%.0f:%02.0f:%s (h:mm:ss.mmm)", hours, minutes, sec);
        else snprintf(out, cap, "%.0f:%s (m:ss.mmm)", minutes, sec);
        return;
    }
    if (seconds != 0) {
        snprintf(out, cap, "%.3fs", seconds);
        return;
    }
    /* Number(ms.toFixed(3)): no trailing zeros */
    char fixed[48];
    snprintf(fixed, sizeof fixed, "%.3f", ms);
    char num[JS_NUM_BUF_SIZE];
    js_num_to_cstr(num, strtod(fixed, NULL));
    snprintf(out, cap, "%.*sms", (int)(cap > 3 ? cap - 3 : 0), num);
}

/* "label: 1.234ms", then any data (console.timeLog), on stdout. */
static JSValue print_time(JSContext *ctx, JSValue label, double start, uint32_t extra, const JSValue *data) {
    char t[96];
    format_time(t, sizeof t, js_os_now_ms_precise() - start);
    JSValue fmt = js_new_string_cstr(ctx, "%s: %s");  /* on the stack: the next allocation may collect */
    JSValue elapsed = js_new_string_cstr(ctx, t);
    JSValue *args = malloc((3 + extra) * sizeof *args);
    if (!args) js_fatal("out of memory");
    args[0] = fmt;
    args[1] = label;
    args[2] = elapsed;
    for (uint32_t i = 0; i < extra; i++) args[3 + i] = data[i];
    JSValue r = js_is_exception(fmt) || js_is_exception(elapsed) ? JS_EXCEPTION : print_args(ctx, 1, 3 + extra, args);
    js_keep_alive(fmt);  /* args is malloc'd: the scan doesn't see it */
    js_keep_alive(elapsed);
    js_keep_alive(label);
    free(args);
    return r;
}

/* The timer's start, or a warning (Node's process.emitWarning) and -1. */
static int timer_start(JSContext *ctx, JSValue label_arg, const char *method, JSValue *key, JSValue *label, double *start) {
    *key = state_key(ctx, "time:", label_arg);
    *label = label_string(ctx, label_arg);
    if (js_is_exception(*key) || js_is_exception(*label)) return -2;
    JSObject *st = state(ctx);
    JSValue v = js_get(ctx, st, *key, js_object_value(st));
    if (js_is_exception(v)) return -2;
    if (!js_is_number(v)) {
        char prefix[64];
        snprintf(prefix, sizeof prefix, "No such label '");
        JSValue a = js_new_string_cstr(ctx, prefix);
        JSValue b = js_new_string_cstr(ctx, method);
        if (js_is_exception(a) || js_is_exception(b)) return -2;
        JSValue m = js_concat(ctx, a, *label);
        if (js_is_exception(m)) return -2;
        m = js_concat(ctx, m, b);
        if (js_is_exception(m)) return -2;
        js_emit_warning(ctx, m, "Warning", NULL);
        return -1;
    }
    *start = js_as_number(v);
    return 0;
}

NATIVE(console_time) {
    UNUSED_ARGS;
    JSValue key = state_key(ctx, "time:", ARG(0));
    JSValue label = label_string(ctx, ARG(0));
    if (js_is_exception(key) || js_is_exception(label)) return JS_EXCEPTION;
    JSObject *st = state(ctx);
    JSValue v = js_get(ctx, st, key, js_object_value(st));
    if (js_is_exception(v)) return v;
    if (js_is_number(v)) {
        JSValue a = js_new_string_cstr(ctx, "Label '");
        JSValue b = js_new_string_cstr(ctx, "' already exists for console.time()");
        if (js_is_exception(a) || js_is_exception(b)) return JS_EXCEPTION;
        JSValue m = js_concat(ctx, a, label);
        if (!js_is_exception(m)) m = js_concat(ctx, m, b);
        if (js_is_exception(m)) return m;
        js_emit_warning(ctx, m, "Warning", NULL);
        return JS_UNDEFINED;
    }
    js_define_data(ctx, st, key, js_number(js_os_now_ms_precise()), JS_PROP_DEFAULT);
    return JS_UNDEFINED;
}

NATIVE(console_time_log) {
    UNUSED_ARGS;
    JSValue key, label;
    double start;
    int r = timer_start(ctx, ARG(0), "' for console.timeLog()", &key, &label, &start);
    if (r == -2) return JS_EXCEPTION;
    if (r == -1) return JS_UNDEFINED;
    return print_time(ctx, label, start, argc > 1 ? argc - 1 : 0, argv + 1);
}

NATIVE(console_time_end) {
    UNUSED_ARGS;
    JSValue key, label;
    double start;
    int r = timer_start(ctx, ARG(0), "' for console.timeEnd()", &key, &label, &start);
    if (r == -2) return JS_EXCEPTION;
    if (r == -1) return JS_UNDEFINED;
    JSValue printed = print_time(ctx, label, start, 0, NULL);
    if (js_is_exception(printed)) return printed;
    if (js_delete_property(ctx, state(ctx), key, false) < 0) return JS_EXCEPTION;
    return JS_UNDEFINED;
}

/* Node adds the stack's frames, which visaljs doesn't record. */
NATIVE(console_trace) {
    UNUSED_ARGS;
    JSValue message = js_format(ctx, argc, argv);
    if (js_is_exception(message)) return message;
    JSValue trace = js_new_string_cstr(ctx, js_string_length(message) ? "Trace: " : "Trace");
    if (js_is_exception(trace)) return trace;
    JSValue s = js_concat(ctx, trace, message);
    if (js_is_exception(s)) return s;
    emit_string(ctx, 2, s);
    return JS_UNDEFINED;
}

/* ---- console.table (Node's internal/cli_table.js) --------------------------------------------- */

/* Ported from Node.js (Copyright Node.js contributors, MIT): runtime/third_party/nodejs/LICENSE. */

/* The table's strings live in malloc'd arrays: `keep`, a JS array on the stack, holds them
 * for the scan. */
static JSValue kept(JSContext *ctx, JSValue keep, JSValue v) {
    if (!js_is_exception(v) && js_is_cell(v) && js_array_push(ctx, js_as_object(keep), v) < 0) return JS_EXCEPTION;
    return v;
}

/* A cell: inspected with depth 0 (-1 for objects of more than two keys), three array items. */
static JSValue table_cell(JSContext *ctx, JSValue keep, JSValue v) {
    JSInspectOptions o = js_inspect_defaults;
    o.depth = 0;
    if (js_is_object(v) && !js_is_array(v)) {
        JSValue keys = js_own_keys(ctx, js_as_object(v));
        if (js_is_exception(keys)) return keys;
        uint32_t enumerable = 0;
        JSValueArray *list = (JSValueArray *)js_as_cell(keys);
        for (uint32_t i = 0; i < list->cell.aux; i++) {
            JSPropertyDescriptor d;
            if (js_is_symbol(list->values[i])) continue;
            int has = js_get_own_property(ctx, js_as_object(v), list->values[i], &d);
            if (has < 0) return JS_EXCEPTION;
            enumerable += has && (d.attrs & JS_PROP_ENUMERABLE);
        }
        if (enumerable > 2) o.depth = -1;
    }
    o.max_array_length = 3;
    o.break_length = INFINITY;
    return kept(ctx, keep, js_inspect_with(ctx, v, &o));
}

static void put_utf8(char **buf, size_t *len, size_t *cap, const char *s, size_t n) {
    if (*len + n + 1 > *cap) {
        while (*len + n + 1 > *cap) *cap = *cap ? *cap * 2 : 1024;
        char *grown = realloc(*buf, *cap);
        if (!grown) js_fatal("out of memory");
        *buf = grown;
    }
    memcpy(*buf + *len, s, n);
    *len += n;
}

#define PUT(s) put_utf8(&out, &len, &cap, (s), strlen(s))

static void put_cell(JSContext *ctx, char **out, size_t *len, size_t *cap, JSValue s, uint32_t width) {
    char small[256], *buf;
    size_t n = utf8_of(ctx, s, small, sizeof small, &buf);
    put_utf8(out, len, cap, buf, n);
    if (buf != small) free(buf);
    for (uint32_t i = js_string_length(s); i < width; i++) put_utf8(out, len, cap, " ", 1);
}

/* head: the column names; columns[c][r]: a cell (undefined: empty). */
static void render_table(JSContext *ctx, JSValue *head, uint32_t ncols, JSValue **columns, uint32_t *lengths) {
    uint32_t nrows = 0;
    for (uint32_t c = 0; c < ncols; c++) if (lengths[c] > nrows) nrows = lengths[c];
    uint32_t *widths = calloc(ncols ? ncols : 1, sizeof *widths);
    if (!widths) js_fatal("out of memory");
    for (uint32_t c = 0; c < ncols; c++) {
        widths[c] = js_string_length(head[c]);
        for (uint32_t r = 0; r < lengths[c]; r++)
            if (js_is_string(columns[c][r]) && js_string_length(columns[c][r]) > widths[c]) widths[c] = js_string_length(columns[c][r]);
    }
    char *out = NULL;
    size_t len = 0, cap = 0;
    JSValue empty = js_empty_string();
    for (int line = 0; line < 3; line++) {  /* top, below the head, bottom */
        static const char *const ends[3][3] = { { "┌", "┬", "┐" }, { "├", "┼", "┤" }, { "└", "┴", "┘" } };
        if (line == 2) {
            for (uint32_t r = 0; r < nrows; r++) {
                PUT("│ ");
                for (uint32_t c = 0; c < ncols; c++) {
                    JSValue cell = r < lengths[c] && js_is_string(columns[c][r]) ? columns[c][r] : empty;
                    put_cell(ctx, &out, &len, &cap, cell, widths[c]);
                    PUT(c + 1 < ncols ? " │ " : " │\n");
                }
            }
        }
        PUT(ends[line][0]);
        for (uint32_t c = 0; c < ncols; c++) {
            for (uint32_t k = 0; k < widths[c] + 2; k++) PUT("─");
            PUT(c + 1 < ncols ? ends[line][1] : ends[line][2]);
        }
        if (line < 2) PUT("\n");
        if (line == 0) {
            PUT("│ ");
            for (uint32_t c = 0; c < ncols; c++) {
                put_cell(ctx, &out, &len, &cap, head[c], widths[c]);
                PUT(c + 1 < ncols ? " │ " : " │\n");
            }
        }
    }
    emit(1, out, len);
    free(out);
    free(widths);
}

NATIVE(console_table) {
    UNUSED_ARGS;
    JSValue data = ARG(0), properties = ARG(1);
    if (!js_is_object(data)) return print_args(ctx, 1, 1, &data);
    JSValue keep = js_new_array(ctx, 0);
    if (js_is_exception(keep)) return keep;
    JSValue index_keys = js_own_keys(ctx, js_as_object(data));
    if (js_is_exception(index_keys)) return index_keys;
    JSValueArray *ik = (JSValueArray *)js_as_cell(index_keys);
    /* the rows: Object.keys(data) */
    uint32_t nrows = 0;
    JSValue *rows = malloc((ik->cell.aux + 1) * sizeof *rows);
    if (!rows) js_fatal("out of memory");
    for (uint32_t i = 0; i < ik->cell.aux; i++) {
        JSPropertyDescriptor d;
        if (js_is_symbol(ik->values[i])) continue;
        int has = js_get_own_property(ctx, js_as_object(data), ik->values[i], &d);
        if (has < 0) goto fail_rows;
        if (has && (d.attrs & JS_PROP_ENUMERABLE)) rows[nrows++] = ik->values[i];
    }
    {
        /* columns: (index), each property in first-seen order, then Values */
        uint32_t cap = 8, ncols = 1;
        JSValue *head = malloc(cap * sizeof *head);
        JSValue **columns = malloc(cap * sizeof *columns);
        uint32_t *lengths = calloc(cap, sizeof *lengths);
        JSValue *values = calloc(nrows + 1, sizeof *values);
        bool has_values = false;
        JSValue result = JS_UNDEFINED;
        if (!head || !columns || !lengths || !values) js_fatal("out of memory");
        head[0] = kept(ctx, keep, js_new_string_cstr(ctx, "(index)"));
        columns[0] = malloc((nrows + 1) * sizeof **columns);
        if (!columns[0]) js_fatal("out of memory");
        for (uint32_t r = 0; r < nrows; r++) {
            columns[0][r] = js_is_number(rows[r]) ? kept(ctx, keep, js_number_to_string(ctx, rows[r])) : rows[r];
            values[r] = JS_UNDEFINED;
        }
        lengths[0] = nrows;
        for (uint32_t r = 0; r < nrows && !js_is_exception(result); r++) {
            JSValue item = kept(ctx, keep, js_get_value(ctx, data, rows[r]));
            if (js_is_exception(item)) {
                result = item;
                break;
            }
            bool primitive = !js_is_object(item);
            if (js_is_undefined(properties) && primitive) {
                has_values = true;
                values[r] = table_cell(ctx, keep, item);
                if (js_is_exception(values[r])) result = values[r];
                continue;
            }
            JSValue keys = js_is_undefined(properties) ? kept(ctx, keep, js_own_keys(ctx, js_as_object(item))) : JS_UNDEFINED;
            if (js_is_exception(keys)) {
                result = keys;
                break;
            }
            uint32_t nkeys = js_is_undefined(properties) ? ((JSValueArray *)js_as_cell(keys))->cell.aux
                                                          : (js_is_array(properties) ? js_array_length(js_as_object(properties)) : 0);
            for (uint32_t k = 0; k < nkeys; k++) {
                JSValue key;
                if (js_is_undefined(properties)) {
                    key = ((JSValueArray *)js_as_cell(keys))->values[k];
                    JSPropertyDescriptor d;
                    if (js_is_symbol(key)) continue;
                    int has = js_get_own_property(ctx, js_as_object(item), key, &d);
                    if (has < 0) { result = JS_EXCEPTION; break; }
                    if (!has || !(d.attrs & JS_PROP_ENUMERABLE)) continue;
                } else {
                    key = js_get_elem(ctx, properties, js_index_key(k));
                    if (!js_is_exception(key)) key = kept(ctx, keep, js_to_property_key(ctx, key));
                    if (js_is_exception(key)) { result = key; break; }
                }
                JSValue name = kept(ctx, keep, js_is_number(key) ? js_number_to_string(ctx, key) : js_is_string(key) ? key : js_to_string(ctx, key));
                if (js_is_exception(name)) { result = name; break; }
                uint32_t c = 1;
                while (c < ncols && !js_string_equals(ctx, head[c], name)) c++;
                if (c == ncols) {
                    if (ncols == cap) {
                        cap *= 2;
                        head = realloc(head, cap * sizeof *head);
                        columns = realloc(columns, cap * sizeof *columns);
                        lengths = realloc(lengths, cap * sizeof *lengths);
                        if (!head || !columns || !lengths) js_fatal("out of memory");
                    }
                    head[ncols] = name;
                    columns[ncols] = malloc((nrows + 1) * sizeof **columns);
                    if (!columns[ncols]) js_fatal("out of memory");
                    for (uint32_t i = 0; i < nrows; i++) columns[ncols][i] = JS_UNDEFINED;
                    lengths[ncols] = 0;
                    ncols++;
                }
                JSValue cell = js_empty_string();
                JSPropertyDescriptor d;
                int has = primitive ? 0 : js_get_own_property(ctx, js_as_object(item), key, &d);
                if (has < 0) { result = JS_EXCEPTION; break; }
                if (has) {
                    JSValue v = kept(ctx, keep, js_get_value(ctx, item, key));
                    cell = js_is_exception(v) ? v : table_cell(ctx, keep, v);
                    if (js_is_exception(cell)) { result = cell; break; }
                }
                columns[c][r] = cell;
                if (lengths[c] < r + 1) lengths[c] = r + 1;
            }
        }
        if (!js_is_exception(result)) {
            if (has_values) {
                if (ncols == cap) {
                    cap++;
                    head = realloc(head, cap * sizeof *head);
                    columns = realloc(columns, cap * sizeof *columns);
                    lengths = realloc(lengths, cap * sizeof *lengths);
                    if (!head || !columns || !lengths) js_fatal("out of memory");
                }
                head[ncols] = kept(ctx, keep, js_new_string_cstr(ctx, "Values"));
                columns[ncols] = values;
                lengths[ncols] = nrows;
                values = NULL;
                ncols++;
            }
            render_table(ctx, head, ncols, columns, lengths);
        }
        for (uint32_t c = 0; c < ncols; c++) if (columns[c] != values) free(columns[c]);
        free(values);
        free(head);
        free(columns);
        free(lengths);
        free(rows);
        js_keep_alive(keep);
        return result;
    }
fail_rows:
    free(rows);
    return JS_EXCEPTION;
}

/* console.clear: Node clears a terminal and leaves a file or pipe alone; visaljs doesn't
 * clear terminals yet */
NATIVE(console_clear) {
    UNUSED_ARGS;
    (void)ctx, (void)argc, (void)argv;
    return JS_UNDEFINED;
}

JSValue js_new_console(JSContext *ctx) {
    JSValue console = js_new_object(ctx);
    if (js_is_exception(console)) return console;
    /* the methods the program names (js_core.def, in Node's order) */
    js_install_core_on(ctx, JS_CORE_CONSOLE, js_as_object(console));
    return console;
}

/* ---- The test host's print, and uncaught errors ----------------------------------------- */

JSValue js_print(JSContext *ctx, JSValue callee, JSValue this_val,
                 uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return JS_EXCEPTION;
    js_write_output(ctx, 1, s);
    fputc('\n', stdout);
    return JS_UNDEFINED;
}

void js_report_error(JSContext *ctx, const char *prefix, JSValue e) {
    fflush(stdout);
    /* An error prints as "Name: message" (no frames: visaljs records none), other
     * objects as their ToString, primitives as console.log prints them. */
    JSValue s = js_is_error(e) ? js_error_to_string(ctx, e) : js_is_object(e) ? js_to_string(ctx, e) : js_format(ctx, 1, &e);
    if (js_is_exception(s)) {
        (void)js_take_exception(ctx);
        fprintf(stderr, "%sexception\n", prefix);
    } else {
        fputs(prefix, stderr);
        js_write_output(ctx, 2, s);
        fputc('\n', stderr);
    }
    fflush(stderr);
}

static int uncaught(JSContext *ctx, const char *prefix, JSValue error, JSValue promise) {
    JSRuntime *rt = ctx->rt;
    int status = rt->on_uncaught ? rt->on_uncaught(ctx, error, promise) : -1;
    if (status < 0) {
        js_report_error(ctx, prefix, error);
        status = 1;
    }
    return status ? (rt->failure = (uint8_t)status) : 0;
}

int js_report_uncaught(JSContext *ctx) {
    return uncaught(ctx, "Uncaught ", js_take_exception(ctx), JS_UNDEFINED);
}

int js_report_rejection(JSContext *ctx, JSValue promise, JSValue reason) {
    return uncaught(ctx, "Uncaught (in promise) ", reason, promise);
}
