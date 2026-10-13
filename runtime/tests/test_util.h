/* Helpers shared by the runtime tests. */
#ifndef JS_TEST_UTIL_H
#define JS_TEST_UTIL_H

#include "js_error.h"

/* Takes the pending exception and renders it: an error as "Name: message", a string as is. */
static inline const char *take_error_text(JSContext *ctx) {
    static char buf[256];
    JSValue e = js_take_exception(ctx);
    JSValue s = js_is_error(e) ? js_error_to_string(ctx, e) : e;
    if (!js_is_string(s)) return "(not an error or string)";
    size_t n = js_view_to_utf8(js_string_view(ctx, s), buf, sizeof buf - 1);
    buf[n < sizeof buf ? n : sizeof buf - 1] = '\0';
    return buf;
}

#endif /* JS_TEST_UTIL_H */
