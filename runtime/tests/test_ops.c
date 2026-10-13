/* The JS operators (runtime/src/ops.c): differential against Node's results. */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "js_builtins.h"
#include "js_ops.h"
#include "jstest.h"
#include "test_util.h"

static JSRuntime *rt;
static JSContext *ctx;

static uint16_t units[256];

static JSValue value_of(const char *tok) {
    switch (tok[0]) {
    case 'u': return JS_UNDEFINED;
    case 'n': return JS_NULL;
    case 't': return JS_TRUE;
    case 'f': return JS_FALSE;
    case 'd': {
        uint64_t bits = strtoull(tok + 2, NULL, 16);
        double d;
        memcpy(&d, &bits, 8);
        return js_number(d);
    }
    default: {
        uint32_t n = (uint32_t)(strlen(tok + 2) / 4);
        for (uint32_t i = 0; i < n; i++) {
            char h[5] = { 0 };
            memcpy(h, tok + 2 + 4 * i, 4);
            units[i] = (uint16_t)strtoul(h, NULL, 16);
        }
        JSValue s = js_new_string_utf16(ctx, units, n);
        return s;
    }
    }
}

/* Same JS value: numbers by value (and the sign of zero), strings by content.
 * `ulps`: allowed distance for results the spec leaves implementation-approximated. */
static bool same(JSValue a, JSValue b, int ulps) {
    if (js_is_number(a) && js_is_number(b)) {
        double x = js_as_number(a), y = js_as_number(b);
        if ((x != x && y != y) || (x == y && signbit(x) == signbit(y))) return true;
        for (int i = 0; i < ulps; i++) x = nextafter(x, y);
        return x == y;
    }
    if (js_is_string(a) && js_is_string(b)) return js_string_equals(ctx, a, b);
    return js_same_bits(a, b);
}

typedef JSValue (*Binary)(JSContext *, JSValue, JSValue);

static Binary binary_op(const char *name) {
    static const struct { const char *name; Binary fn; } ops[] = {
        { "add", js_add }, { "sub", js_sub }, { "mul", js_mul }, { "div", js_div }, { "mod", js_mod },
        { "exp", js_exp }, { "shl", js_shl }, { "sar", js_sar }, { "shr", js_shr }, { "bitand", js_bitand },
        { "bitor", js_bitor }, { "bitxor", js_bitxor }, { "eq", js_eq }, { "ne", js_ne },
        { "strict_eq", js_strict_eq }, { "strict_ne", js_strict_ne },
        { "lt", js_lt }, { "le", js_le }, { "gt", js_gt }, { "ge", js_ge },
    };
    for (size_t i = 0; i < sizeof ops / sizeof ops[0]; i++)
        if (strcmp(ops[i].name, name) == 0) return ops[i].fn;
    return NULL;
}

static JSValue unary_op(const char *name, JSValue a) {
    if (!strcmp(name, "neg")) return js_neg(ctx, a);
    if (!strcmp(name, "bitnot")) return js_bitnot(ctx, a);
    if (!strcmp(name, "to_number")) return js_to_number_value(ctx, a);
    if (!strcmp(name, "not")) return js_not(a);
    if (!strcmp(name, "to_boolean")) return js_to_boolean(a);
    if (!strcmp(name, "typeof")) return js_typeof(ctx, a);
    if (!strcmp(name, "is_nullish")) return js_is_nullish_value(a);
    JSValue n = js_to_numeric(ctx, a);  /* ++/-- apply to the ToNumeric'd operand */
    if (js_is_exception(n)) return n;
    if (!strcmp(name, "inc")) return js_inc(ctx, n);
    if (!strcmp(name, "dec")) return js_dec(ctx, n);
    return JS_EXCEPTION;
}

TEST(ops_node_fixture) {
    rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    ctx = js_context_new(rt);
    FILE *f = fopen(OPS_FIXTURE, "r");
    if (!f) {
        JST_FAIL_("cannot open %s", OPS_FIXTURE);
        return;
    }
    static char line[4096];
    int cases = 0, failures = 0;
    while (fgets(line, sizeof line, f)) {
        line[strcspn(line, "\n")] = '\0';
        char *field[5] = { 0 };
        int nf = 0;
        for (char *p = strtok(line, "\t"); p && nf < 5; p = strtok(NULL, "\t")) field[nf++] = p;
        cases++;
        JSValue got, want;
        if (field[0][0] == 'B') {
            Binary fn = binary_op(field[1]);
            got = fn ? fn(ctx, value_of(field[2]), value_of(field[3])) : JS_EXCEPTION;
            want = value_of(field[4]);
        } else {
            got = unary_op(field[1], value_of(field[2]));
            want = value_of(field[3]);
        }
        /* ** is implementation-approximated: glibc's pow is correctly rounded, V8's
         * fdlibm-derived pow can be 1 ulp off. */
        bool ok = !js_is_exception(got) && same(got, want, strcmp(field[1], "exp") == 0 ? 1 : 0);
        if (js_has_exception(ctx)) (void)js_take_exception(ctx);
        if (!ok && ++failures <= 25) {
            char g[64] = "?", w[64] = "?";
            if (js_is_number(got)) snprintf(g, sizeof g, "%.17g", js_as_number(got));
            else if (js_is_string(got)) g[js_view_to_utf8(js_string_view(ctx, got), g, 63)] = 0;
            else if (js_is_bool(got)) snprintf(g, sizeof g, "%s", js_as_bool(got) ? "true" : "false");
            if (js_is_number(want)) snprintf(w, sizeof w, "%.17g", js_as_number(want));
            else if (js_is_string(want)) w[js_view_to_utf8(js_string_view(ctx, want), w, 63)] = 0;
            else if (js_is_bool(want)) snprintf(w, sizeof w, "%s", js_as_bool(want) ? "true" : "false");
            fprintf(stderr, "  case %d (%s %s %s): got %s, want %s\n", cases, field[1], field[2],
                    field[0][0] == 'B' ? field[3] : "", g, w);
        }
    }
    fclose(f);
    if (failures) JST_FAIL_("%d of %d operator cases differ from Node", failures, cases);
    CHECK(cases > 10000);
    js_context_free(ctx);
    js_runtime_free(rt);
}

TEST(ops_errors) {
    rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    ctx = js_context_new(rt);
    CHECK(js_is_exception(js_check_tdz(ctx, JS_EMPTY, "x")));
    CHECK(strcmp(take_error_text(ctx), "ReferenceError: Cannot access 'x' before initialization") == 0);
    CHECK(js_same_bits(js_check_tdz(ctx, js_int32(1), "x"), js_int32(1)));
    CHECK(js_is_exception(js_global_name(ctx, "nope")));
    CHECK(strcmp(take_error_text(ctx), "ReferenceError: nope is not defined") == 0);
    CHECK(js_is_exception(js_throw_const_assign(ctx)));
    CHECK(strcmp(take_error_text(ctx), "TypeError: Assignment to constant variable.") == 0);
    CHECK_EQ_INT(js_double_to_int32(4294967296.0 + 5), 5);
    CHECK_EQ_INT(js_double_to_int32(-2147483649.0), 2147483647);
    CHECK_EQ_INT(js_double_to_int32(1e300), 0);
    js_context_free(ctx);
    js_runtime_free(rt);
}
