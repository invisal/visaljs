/*
 * A hand-written C program using the runtime API allocates millions of strings in a
 * loop with bounded memory.
 *
 * Roughly what the compiler will emit for:
 *
 *   let last = "";
 *   for (let i = 0; i < n; i++) last = "item " + i + " of " + n;
 *   console.log(last, last.length);
 *
 * n defaults to 3,000,000; GC-stress builds pass a small n (every allocation collects).
 */
#include <stdio.h>
#include <stdlib.h>

#include "js_builtins.h"
#include "js_runtime.h"

static JSValue globals[1];  /* module-level `last` */

static JSValue run(JSContext *ctx, int32_t n) {
    js_register_roots(ctx->rt, globals, 1);
    globals[0] = js_empty_string();
    JSValue item = js_atom_from_cstr(ctx, "item "), of = js_atom_from_cstr(ctx, " of ");
    JS_RETURN_IF_EXC(item);
    JS_RETURN_IF_EXC(of);
    size_t peak = 0;
    for (int32_t i = 0; i < n; i++) {
        JSValue s = js_concat(ctx, item, js_number_to_string(ctx, js_int32(i)));
        JS_RETURN_IF_EXC(s);
        s = js_concat(ctx, s, of);
        JS_RETURN_IF_EXC(s);
        s = js_concat(ctx, s, js_number_to_string(ctx, js_int32(n)));
        JS_RETURN_IF_EXC(s);
        globals[0] = s;
        if (js_heap_size(ctx->rt) > peak) peak = js_heap_size(ctx->rt);
    }
    JSValue args[] = { globals[0], js_int32((int32_t)js_string_length(globals[0])) };
    JSValue line = js_format(ctx, 2, args);  /* console.log's text */
    JS_RETURN_IF_EXC(line);
    js_write_output(ctx, 1, line);
    fputc('\n', stdout);
    fprintf(stderr, "collections: %zu, peak heap: %zu KiB\n", ctx->rt->heap.gc_count, peak >> 10);
    return peak <= 3 * JS_GC_MIN_HEAP ? JS_UNDEFINED : js_throw_range_error(ctx, "heap grew to %zu KiB", peak >> 10);
}

int main(int argc, char **argv) {
    int32_t n = argc > 1 ? (int32_t)atoi(argv[1]) : 3000000;
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    JSContext *ctx = js_context_new(rt);
    int status = js_is_exception(run(ctx, n)) ? js_report_uncaught(ctx) : 0;
    js_context_free(ctx);
    js_runtime_free(rt);
    return status;
}
