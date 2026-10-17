/* RegExp (ECMAScript §22.2), the regexp component.
 *
 * The engine is QuickJS's libregexp (third_party/quickjs-regexp): a pattern compiles to bytecode,
 * and lre_exec runs it straight on a string's Latin-1 or UTF-16 characters. Literals arrive
 * compiled (the compiler runs the same library when it builds the program); `new RegExp`
 * compiles at run time. The built-ins follow QuickJS's, which follow the spec: the String
 * methods call @@match/@@replace/@@search/@@split, which call RegExpExec, which calls the
 * object's `exec` (the built-in one directly when it hasn't been replaced). Messages are V8's. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_function.h"
#include "js_ops.h"
#include "js_regexp.h"
#include "js_symbol.h"
#include "jscontext.h"
#include "jsstring.h"
#include "cutils.h"
#include "libregexp.h"
#include "libunicode.h"
#include "regexp_anchor.h"
#include "regexp_message.h"

typedef struct RegExpObject {
    JSObject       obj;
    JSValue        source;    /* [[OriginalSource]]: a string */
    const uint8_t *bytecode;  /* [[RegExpMatcher]]; its flags are [[OriginalFlags]] */
    bool           owned;     /* malloc'd (compiled at run time): the finalizer frees it */
    bool           one_class; /* the pattern is one character class: `units` (see find_class) */
    bool           negated;   /* ...that matches every unit from U+0100 up */
    uint32_t       units[8];  /* its units below U+0100, a bit each */
    bool           analyzed;  /* `prefilter` is set (see analyze) */
    struct Prefilter *prefilter;  /* where a match can start, or NULL: malloc'd */
} RegExpObject;

static void free_prefilter(RegExpObject *re);

static void regexp_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((RegExpObject *)c)->source); }

static void regexp_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    RegExpObject *re = (RegExpObject *)c;
    if (re->owned) free((void *)re->bytecode);
    free_prefilter(re);
}

static const JSClass regexp_class = { "RegExp", sizeof(RegExpObject), NULL, NULL, NULL, NULL, regexp_visit, regexp_finalize, NULL };

static RegExpObject *as_regexp(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &regexp_class ? (RegExpObject *)js_as_object(v) : NULL;
}

/* ---- libregexp's host hooks ------------------------------------------------------------- */

int lre_check_stack_overflow(void *opaque, size_t alloca_size) {
    JSContext *ctx = opaque;
    return ctx && JS_FRAME_ADDRESS() - alloca_size < ctx->stack_limit;
}

int lre_check_timeout(void *opaque) {
    (void)opaque;
    return 0;  /* no timeout, as in Node */
}

void *lre_realloc(void *opaque, void *ptr, size_t size) {
    (void)opaque;
    if (size == 0) {
        free(ptr);
        return NULL;
    }
    return realloc(ptr, size);
}

/* ---- Small helpers ---------------------------------------------------------------------- */

static JSValue throw_incompatible(JSContext *ctx, const char *method, JSValue v) {
    char what[64];
    js_describe_value(ctx, v, what, sizeof what);
    return js_throw_type_error(ctx, "Method RegExp.prototype.%s called on incompatible receiver %s", method, what);
}

/* ToLength (§7.1.20) */
static int to_length(JSContext *ctx, JSValue v, double *out) {
    double d;
    if (js_to_integer_or_infinity(ctx, &d, v) < 0) return -1;
    *out = d <= 0 ? 0 : d > JS_MAX_SAFE_INTEGER ? JS_MAX_SAFE_INTEGER : d;
    return 0;
}

static JSValue get_last_index(JSContext *ctx, JSValue rx, double *out) {
    JSValue v = js_get_value(ctx, rx, JS_ATOM(lastIndex));
    if (js_is_exception(v)) return v;
    return to_length(ctx, v, out) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

static int set_last_index(JSContext *ctx, JSValue rx, double index) {
    return js_set_value(ctx, rx, JS_ATOM(lastIndex), js_number(index), true);
}

/* AdvanceStringIndex (§22.2.7.3) */
static double advance_index(JSContext *ctx, JSValue s, double index, bool unicode) {
    JSStrView v = js_string_view(ctx, s);
    if (!unicode || index + 1 >= v.length) return index + 1;
    uint32_t c = js_view_at(v, (uint32_t)index), d = js_view_at(v, (uint32_t)index + 1);
    return index + (c >= 0xD800 && c <= 0xDBFF && d >= 0xDC00 && d <= 0xDFFF ? 2 : 1);
}

static bool has_unit(JSContext *ctx, JSValue s, uint32_t unit) {
    JSStrView v = js_string_view(ctx, s);
    for (uint32_t i = 0; i < v.length; i++)
        if (js_view_at(v, i) == unit) return true;
    return false;
}

/* SpeciesConstructor(o, %RegExp%) (§7.3.22) */
static JSValue species_constructor(JSContext *ctx, JSValue o) {
    JSValue dflt = ctx->intrinsics[JS_INTRINSIC_REGEXP];
    JSValue c = js_get_value(ctx, o, JS_ATOM(constructor));
    if (js_is_exception(c)) return c;
    if (js_is_undefined(c)) return dflt;
    if (!js_is_object(c)) return js_throw_type_error(ctx, "object.constructor is not an object");
    JSValue s = js_get_value(ctx, c, JS_SYMBOL(species));
    if (js_is_exception(s)) return s;
    if (js_is_nullish(s)) return dflt;
    if (!js_is_constructor(s)) return js_throw_type_error(ctx, "object.constructor[Symbol.species] is not a constructor");
    return s;
}

/* IsRegExp (§7.2.8) */
static int is_regexp(JSContext *ctx, JSValue v) {
    if (!js_is_object(v)) return 0;
    JSValue matcher = js_get_value(ctx, v, JS_SYMBOL(match));
    if (js_is_exception(matcher)) return -1;
    if (!js_is_undefined(matcher)) return js_truthy(matcher);
    return as_regexp(v) != NULL;
}

/* ---- Compiling ------------------------------------------------------------------------- */

static const char flag_chars[] = "dgimsuvy";
static const int flag_bits[] = { LRE_FLAG_INDICES, LRE_FLAG_GLOBAL, LRE_FLAG_IGNORECASE, LRE_FLAG_MULTILINE,
                                 LRE_FLAG_DOTALL, LRE_FLAG_UNICODE, LRE_FLAG_UNICODE_SETS, LRE_FLAG_STICKY };

/* The flags string's LRE_FLAG_* bits, or -1 when it isn't valid (unknown, repeated, u with v). */
static int parse_flags(JSStrView v) {
    int flags = 0;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        const char *p = c && c < 128 ? strchr(flag_chars, (int)c) : NULL;
        if (!p) return -1;
        int bit = flag_bits[p - flag_chars];
        if (flags & bit) return -1;
        flags |= bit;
    }
    if ((flags & LRE_FLAG_UNICODE) && (flags & LRE_FLAG_UNICODE_SETS)) return -1;
    return flags;
}

/* "dgimsuvy" order, as the flags getter would build it from the flag getters. */
static size_t flags_string(int flags, char out[9]) {
    size_t n = 0;
    for (int i = 0; i < 8; i++)
        if (flags & flag_bits[i]) out[n++] = flag_chars[i];
    out[n] = '\0';
    return n;
}

/* The pattern as libregexp reads it: UTF-8, or CESU-8 (each surrogate on its own) without the
 * u and v flags, as QuickJS passes it. NUL-terminated; malloc'd. */
static char *encode_pattern(JSStrView v, bool unicode, size_t *len) {
    char *out = malloc((size_t)v.length * 3 + 1);
    if (!out) js_fatal("out of memory compiling a regular expression");
    size_t n = 0;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (unicode && c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length) {
            uint32_t d = js_view_at(v, i + 1);
            if (d >= 0xDC00 && d <= 0xDFFF) {
                c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
                i++;
            }
        }
        if (c < 0x80) {
            out[n++] = (char)c;
        } else if (c < 0x800) {
            out[n++] = (char)(0xC0 | (c >> 6));
            out[n++] = (char)(0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            out[n++] = (char)(0xE0 | (c >> 12));
            out[n++] = (char)(0x80 | ((c >> 6) & 0x3F));
            out[n++] = (char)(0x80 | (c & 0x3F));
        } else {
            out[n++] = (char)(0xF0 | (c >> 18));
            out[n++] = (char)(0x80 | ((c >> 12) & 0x3F));
            out[n++] = (char)(0x80 | ((c >> 6) & 0x3F));
            out[n++] = (char)(0x80 | (c & 0x3F));
        }
    }
    out[n] = '\0';
    *len = n;
    return out;
}

/* Compiles source with flags (LRE_FLAG_*): the malloc'd bytecode, or NULL with a SyntaxError
 * (a RangeError when the pattern nests too deeply). */
static uint8_t *compile(JSContext *ctx, JSValue source, int flags) {
    size_t len;
    char *pattern = encode_pattern(js_string_view(ctx, source), (flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0, &len);
    char error[64];
    int bc_len;
    uint8_t *bc = lre_compile(&bc_len, error, sizeof error, pattern, len, flags, ctx);
    free(pattern);
    if (bc) {
        js_regexp_anchor(bc, bc_len);
        return bc;
    }
    if (strcmp(error, "stack overflow") == 0) {
        js_discard(js_throw_stack_overflow(ctx));
        return NULL;
    }
    char text[256], f[9], buf[64];
    size_t n = js_view_to_utf8(js_string_view(ctx, source), text, sizeof text - 1);
    text[n < sizeof text - 1 ? n : sizeof text - 1] = '\0';
    flags_string(flags & ~LRE_FLAG_NAMED_GROUPS, f);
    js_discard(js_throw_syntax_error(ctx, "Invalid regular expression: /%s/%s: %s", text, f, js_regexp_message(error, buf, sizeof buf)));
    return NULL;
}

/* ---- Creating ---------------------------------------------------------------------------- */

static JSValue regexp_new(JSContext *ctx, JSValue proto) {
    RegExpObject *re = (RegExpObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &regexp_class, proto, 1));
    re->source = js_empty_string();
    re->bytecode = NULL;
    re->owned = false;
    re->one_class = false;
    re->analyzed = false;
    re->prefilter = NULL;
    js_define_data(ctx, &re->obj, JS_ATOM(lastIndex), JS_UNDEFINED, JS_PROP_WRITABLE);
    return js_object_value(&re->obj);
}

/* RegExpAlloc (§22.2.3.2): lastIndex defined, no matcher yet. */
static JSValue regexp_alloc(JSContext *ctx, JSValue new_target) {
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_REGEXP_PROTOTYPE);
    return js_is_exception(proto) ? proto : regexp_new(ctx, proto);
}

/* ---- One character class, matched without the engine ---------------------------------------
 *
 * A pattern that is a single character, or a single class of characters below U+0100, matches
 * one code unit: builtin_exec scans for it in place of lre_exec (React's and escape-html's
 * /["'&<>]/, a split on /[,;]/). Without i, u or v only: case folding and code points change what
 * a character matches. The source is parsed conservatively: anything else keeps the engine. */

typedef struct {
    JSStrView v;
    uint32_t  at;
} Source;

static int peek(const Source *s) { return s->at < s->v.length ? (int)js_view_at(s->v, s->at) : -1; }

static void add_range(uint32_t units[8], int lo, int hi) {
    for (int c = lo; c <= hi; c++) units[c >> 5] |= 1u << (c & 31);
}

enum { NOT_ONE = -1, DIGITS = -2, WORD = -3 };

static int hex_digit(int c) {
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

/* The unit an escape stands for (after its backslash), DIGITS or WORD for \d and \w, or NOT_ONE. */
static int escape_unit(Source *s, bool in_class) {
    int c = peek(s);
    if (c < 0) return NOT_ONE;
    s->at++;
    switch (c) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'f': return '\f';
    case 'v': return '\v';
    case 'd': return DIGITS;
    case 'w': return WORD;
    case 'b': return in_class ? '\b' : NOT_ONE;
    case '0': {
        int d = peek(s);
        return d >= '0' && d <= '9' ? NOT_ONE : 0;
    }
    case 'x': {
        int h = s->at + 1 < s->v.length ? hex_digit(peek(s)) : -1;
        int l = h >= 0 ? hex_digit((int)js_view_at(s->v, s->at + 1)) : -1;
        if (l < 0) return NOT_ONE;
        s->at += 2;
        return h * 16 + l;
    }
    }
    return c < 0x80 && strchr("^$\\.*+?()[]{}|/-", c) ? c : NOT_ONE;  /* a syntax character, escaped */
}

/* A class's unit (after reading it), or DIGITS / WORD (added to `units`), or NOT_ONE. */
static int class_unit(Source *s, uint32_t units[8]) {
    int c = peek(s);
    s->at++;
    if (c != '\\') return c;
    c = escape_unit(s, true);
    if (c == DIGITS) add_range(units, '0', '9');
    if (c == WORD) add_range(units, '0', '9'), add_range(units, 'A', 'Z'), add_range(units, 'a', 'z'), add_range(units, '_', '_');
    return c;
}

static void find_class(JSContext *ctx, RegExpObject *re) {
    re->one_class = false;
    if (lre_get_flags(re->bytecode) & (LRE_FLAG_IGNORECASE | LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS | LRE_FLAG_NAMED_GROUPS)) return;
    Source s = { js_string_view(ctx, re->source), 0 };
    uint32_t units[8] = { 0 };
    bool negated = false;
    int c = peek(&s);
    if (c < 0) return;
    s.at++;
    if (c == '[') {
        negated = peek(&s) == '^';
        if (negated) s.at++;
        for (;;) {
            c = peek(&s);
            if (c < 0) return;
            if (c == ']') break;
            int lo = class_unit(&s, units);
            if (lo == NOT_ONE || lo >= 0x100) return;
            if (peek(&s) == '-' && s.at + 1 < s.v.length && js_view_at(s.v, s.at + 1) != ']') {
                s.at++;
                int hi = class_unit(&s, units);
                if (lo < 0 || hi < lo || hi >= 0x100) return;  /* a class escape in a range: Annex B's */
                add_range(units, lo, hi);
            } else if (lo >= 0) {
                add_range(units, lo, lo);
            }
        }
        s.at++;
        if (negated)
            for (int i = 0; i < 8; i++) units[i] = ~units[i];
    } else if (c == '\\') {
        Source t = { s.v, s.at - 1 };  /* from the backslash */
        c = class_unit(&t, units);
        s.at = t.at;
        if (c == NOT_ONE || c == '\b' || c >= 0x100) return;  /* \b outside a class: a word boundary */
        if (c >= 0) add_range(units, c, c);
    } else {
        if (c >= 0x100 || (c < 0x80 && strchr("^$.*+?()[]{}|/", c))) return;
        add_range(units, c, c);
    }
    if (s.at != s.v.length) return;  /* more than the one class */
    memcpy(re->units, units, sizeof units);
    re->negated = negated;
    re->one_class = true;
}

/* The first unit from `from` (only there, sticky) in the class: 1 with capture 0 set, as lre_exec. */
static int scan_class(const RegExpObject *re, const uint8_t *buf, int shift, uint32_t from, uint32_t length, bool sticky,
                      uint8_t **capture) {
    uint32_t end = sticky && from < length ? from + 1 : length;
    for (uint32_t i = from; i < end; i++) {
        uint32_t c = shift ? ((const uint16_t *)buf)[i] : buf[i];
        if (c < 0x100 ? (re->units[c >> 5] >> (c & 31)) & 1 : re->negated) {
            capture[0] = (uint8_t *)buf + ((size_t)i << shift);
            capture[1] = capture[0] + ((size_t)1 << shift);
            return 1;
        }
    }
    return 0;
}

/* ---- Where a match can start ----------------------------------------------------------------
 *
 * A pattern that isn't anchored or sticky compiles to a loop that tries every position in turn
 * (split_goto_first +6; any; goto -11; save_start 0; ...): each failed attempt costs a trip
 * through the interpreter. When the first units of a match can only be a few (a literal,
 * /foo|bar/, /[cgt]gggtaaa/i, /\s+/), analyze reads them off the bytecode: the units each of
 * the first PREFIX positions can hold, over every alternative. The search then looks for a
 * position where they all fit (memchr for one first unit) and runs a copy of the bytecode whose
 * loop is a goto there: one attempt each. The sets may hold more than can match, never less. */

#define PREFIX 4

typedef struct {
    uint32_t units[8];  /* below U+0100, a bit each */
    bool     high;      /* and any unit from U+0100 up */
} UnitSet;

typedef struct Prefilter {
    int      depth;     /* the positions known: 1..PREFIX */
    int      single;    /* at[0]'s one unit below U+0100, without high, else -1 */
    UnitSet  at[PREFIX];
    uint8_t *once;      /* the bytecode without its loop: an attempt at the start index only */
} Prefilter;

/* lre_canonicalize of the units below U+0100, without and with u/v: char_i and range_i compare
 * the canonical unit. */
static uint32_t canonical[2][256];

static void free_prefilter(RegExpObject *re) {
    if (re->prefilter) free(re->prefilter->once);
    free(re->prefilter);
    re->prefilter = NULL;
    re->analyzed = false;
}

/* The bytecode's size: header, code, then the group names (NUL-terminated, each with a trailer). */
static size_t bytecode_size(const uint8_t *bc) {
    size_t size = 8 + (size_t)(bc[4] | bc[5] << 8 | bc[6] << 16 | (uint32_t)bc[7] << 24);
    const char *names = lre_get_groupnames(bc);
    if (names) {
        for (int i = 1; i < lre_get_capture_count(bc); i++) names += strlen(names) + LRE_GROUP_NAME_TRAILER_LEN;
        size = (size_t)((const uint8_t *)names - bc);
    }
    return size;
}

static void add_unit(UnitSet *u, uint32_t c) {
    if (c < 0x100) u->units[c >> 5] |= 1u << (c & 31);
    else u->high = true;
}

static bool has_unit_in(const UnitSet *u, uint32_t c) {
    return c < 0x100 ? (u->units[c >> 5] >> (c & 31)) & 1 : u->high;
}

static uint32_t get_u16_le(const uint8_t *p) { return p[0] | (uint32_t)p[1] << 8; }
static uint32_t get_u32_le(const uint8_t *p) { return p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }

typedef struct {
    const uint8_t *code;
    uint32_t       length;
    bool           unicode;
    int            limit;  /* every path consumes at least this many units first (PREFIX at most) */
    int            steps;
    UnitSet        at[PREFIX];
} Walk;

/* A class op (range, range32 and their _i forms) at p: the units below U+0100 it takes. */
static void add_ranges(Walk *w, UnitSet *u, const uint8_t *p, bool wide, bool fold) {
    uint32_t n = get_u16_le(p + 1), size = wide ? 8 : 4;
    for (uint32_t c = 0; c < 0x100; c++) {
        uint32_t k = fold ? canonical[w->unicode][c] : c;
        for (uint32_t i = 0; i < n; i++) {
            const uint8_t *r = p + 3 + i * size;
            uint32_t lo = wide ? get_u32_le(r) : get_u16_le(r), hi = wide ? get_u32_le(r + 4) : get_u16_le(r + 2);
            if (k >= lo && k <= hi) {
                add_unit(u, c);
                break;
            }
        }
    }
    const uint8_t *last = p + 3 + (n - 1) * size;
    if (fold || wide || get_u16_le(last + 2) >= 0x100) u->high = true;
}

/* The units the paths from pc can take at positions d.. (until w->limit). */
static void walk(Walk *w, uint32_t pc, int d) {
    while (d < w->limit) {
        if (++w->steps > 1000 || pc >= w->length) {
            w->limit = 0;
            return;
        }
        const uint8_t *p = w->code + pc;
        UnitSet *u = &w->at[d];
        switch (p[0]) {
        case JS_REOP_char:
        case JS_REOP_char32: {
            uint32_t c = p[0] == JS_REOP_char ? get_u16_le(p + 1) : get_u32_le(p + 1);
            add_unit(u, c);  /* from U+10000 up: a high surrogate first */
            pc += p[0] == JS_REOP_char ? 3 : 5;
            d++;
            break;
        }
        case JS_REOP_char_i:
        case JS_REOP_char32_i: {
            uint32_t c = p[0] == JS_REOP_char_i ? get_u16_le(p + 1) : get_u32_le(p + 1);
            for (uint32_t k = 0; k < 0x100; k++)
                if (canonical[w->unicode][k] == c) add_unit(u, k);
            u->high = true;  /* units from U+0100 up may fold to it too */
            pc += p[0] == JS_REOP_char_i ? 3 : 5;
            d++;
            break;
        }
        case JS_REOP_range:
        case JS_REOP_range_i:
            add_ranges(w, u, p, false, p[0] == JS_REOP_range_i);
            pc += 3 + get_u16_le(p + 1) * 4;
            d++;
            break;
        case JS_REOP_range32:
        case JS_REOP_range32_i:
            add_ranges(w, u, p, true, p[0] == JS_REOP_range32_i);
            pc += 3 + get_u16_le(p + 1) * 8;
            d++;
            break;
        case JS_REOP_space:
        case JS_REOP_not_space:
            for (uint32_t k = 0; k < 0x100; k++)
                if (lre_is_space(k) == (p[0] == JS_REOP_space)) add_unit(u, k);
            u->high = true;
            pc++;
            d++;
            break;
        case JS_REOP_dot:
            for (uint32_t k = 0; k < 0x100; k++)
                if (k != '\n' && k != '\r') add_unit(u, k);
            u->high = true;
            pc++;
            d++;
            break;
        case JS_REOP_goto:
            pc += 5 + get_u32_le(p + 1);
            break;
        case JS_REOP_split_goto_first:
        case JS_REOP_split_next_first:
            walk(w, pc + 5, d);
            walk(w, pc + 5 + get_u32_le(p + 1), d);
            return;
        case JS_REOP_save_start:
        case JS_REOP_save_end:
            pc += 2;
            break;
        case JS_REOP_save_reset:
            pc += 3;
            break;
        case JS_REOP_line_start:
        case JS_REOP_line_start_m:
        case JS_REOP_line_end:
        case JS_REOP_line_end_m:
        case JS_REOP_word_boundary:
        case JS_REOP_word_boundary_i:
        case JS_REOP_not_word_boundary:
        case JS_REOP_not_word_boundary_i:
            pc++;  /* zero-width: the next op's unit is at the same position */
            break;
        default:  /* any, match, loops, lookarounds, back references: anything from here on */
            w->limit = d;
            return;
        }
    }
}

/* The share of printable ASCII the sets let through, roughly: a filter that lets most
 * positions through only adds a call per position. */
static double selectivity(const Prefilter *f) {
    double share = 1;
    for (int k = 0; k < f->depth; k++) {
        int n = 0;
        for (uint32_t c = 0x20; c < 0x7F; c++) n += has_unit_in(&f->at[k], c);
        share *= n / 95.0;
    }
    return share;
}

/* The prefilter of re's bytecode, made at its first long search; NULL when it has none. */
static Prefilter *analyze(RegExpObject *re) {
    re->analyzed = true;
    const uint8_t *bc = re->bytecode;
    uint32_t code_length = (uint32_t)(bytecode_size(bc) - JS_RE_HEADER_LEN);
    const uint8_t *p = bc + JS_RE_HEADER_LEN;
    /* the search loop, as js_regexp_anchor reads it (an anchored pattern has a goto instead) */
    if (code_length < 13 || p[0] != JS_REOP_split_goto_first || p[5] != JS_REOP_any || p[6] != JS_REOP_goto || p[11] != JS_REOP_save_start)
        return NULL;
    Walk w = { .code = p, .length = code_length, .unicode = (lre_get_flags(bc) & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0,
               .limit = PREFIX };
    walk(&w, 11, 0);
    if (w.limit == 0) return NULL;
    Prefilter *f = calloc(1, sizeof *f);
    if (!f) js_fatal("out of memory analyzing a regular expression");
    f->depth = w.limit;
    memcpy(f->at, w.at, sizeof f->at);
    if (selectivity(f) > 0.2) {
        free(f);
        return NULL;
    }
    f->single = -1;
    if (!f->at[0].high) {
        int n = 0;
        for (int c = 0; c < 0x100; c++)
            if (has_unit_in(&f->at[0], (uint32_t)c)) f->single = n++ ? -1 : c;
        if (n != 1) f->single = -1;
    }
    size_t size = bytecode_size(bc);
    f->once = malloc(size);
    if (!f->once) js_fatal("out of memory analyzing a regular expression");
    memcpy(f->once, bc, size);
    f->once[JS_RE_HEADER_LEN] = JS_REOP_goto;  /* same offset: straight to save_start */
    return f;
}

/* The first position from `from` where the prefilter's units all fit, or UINT32_MAX. */
static uint32_t next_start(const Prefilter *f, const uint8_t *buf, int shift, uint32_t from, uint32_t length) {
    if (length < (uint32_t)f->depth) return UINT32_MAX;
    uint32_t last = length - (uint32_t)f->depth;  /* a match starts no later */
    for (uint32_t i = from; i <= last; i++) {
        if (!shift && f->single >= 0) {
            const uint8_t *hit = memchr(buf + i, f->single, last - i + 1);
            if (!hit) return UINT32_MAX;
            i = (uint32_t)(hit - buf);
        }
        int k = 0;
        for (; k < f->depth; k++) {
            uint32_t c = shift ? ((const uint16_t *)buf)[i + k] : buf[i + k];
            if (!has_unit_in(&f->at[k], c)) break;
        }
        if (k == f->depth) return i;
    }
    return UINT32_MAX;
}

/* Runs re's matcher on the string from `from` (at most its length): 1 with capture[] set (from
 * lre_exec's alloc count), 0 for no match, or LRE_RET_* < 0. */
static int run(JSContext *ctx, RegExpObject *re, JSStrView v, uint32_t from, uint8_t **capture) {
    const uint8_t *buf = v.chars;
    int shift = v.latin1 ? 0 : 1;
    int flags = lre_get_flags(re->bytecode);
    if (re->one_class) return scan_class(re, buf, shift, from, v.length, (flags & LRE_FLAG_STICKY) != 0, capture);
    /* surrogate pairs: lre_exec steps over them as code points, the scan doesn't */
    bool pairs = !v.latin1 && (flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS));
    if (!re->analyzed && v.length - from >= 64 && !pairs) re->prefilter = analyze(re);
    const Prefilter *f = re->prefilter;
    if (!f || pairs) return lre_exec(capture, re->bytecode, buf, (int)from, (int)v.length, shift, ctx);
    for (uint32_t i = from;; i++) {
        i = next_start(f, buf, shift, i, v.length);
        if (i == UINT32_MAX) return 0;
        int rc = lre_exec(capture, f->once, buf, (int)i, (int)v.length, shift, ctx);
        if (rc != 0) return rc;
    }
}

static void set_matcher(JSContext *ctx, RegExpObject *re, JSValue source, const uint8_t *bytecode, bool owned) {
    if (re->owned) free((void *)re->bytecode);
    free_prefilter(re);
    js_store(ctx, &re->obj.cell, &re->source, source);
    re->bytecode = bytecode;
    re->owned = owned;
    find_class(ctx, re);
}

/* RegExpInitialize (§22.2.3.3) */
static JSValue regexp_initialize(JSContext *ctx, JSValue obj, JSValue pattern, JSValue flags) {
    JSValue p = js_is_undefined(pattern) ? js_empty_string() : js_to_string(ctx, pattern);
    if (js_is_exception(p)) return p;
    JSValue f = js_is_undefined(flags) ? js_empty_string() : js_to_string(ctx, flags);
    if (js_is_exception(f)) return f;
    int bits = parse_flags(js_string_view(ctx, f));
    if (bits < 0) {
        char text[64];
        JSStrView v = js_string_view(ctx, f);
        size_t n = js_view_to_utf8(v, text, sizeof text - 1);
        text[n < sizeof text - 1 ? n : sizeof text - 1] = '\0';
        return js_throw_syntax_error(ctx, "Invalid flags supplied to RegExp constructor '%s'", text);
    }
    uint8_t *bc = compile(ctx, p, bits);
    if (!bc) return JS_EXCEPTION;
    set_matcher(ctx, as_regexp(obj), p, bc, true);
    if (set_last_index(ctx, obj, 0) < 0) return JS_EXCEPTION;
    return obj;
}

/* A copy of another RegExp's matcher: static bytecode is shared, malloc'd bytecode copied. */
static void copy_matcher(JSContext *ctx, RegExpObject *to, const RegExpObject *from) {
    if (!from->owned) {
        set_matcher(ctx, to, from->source, from->bytecode, false);
        return;
    }
    const uint8_t *bc = from->bytecode;
    size_t size = bytecode_size(bc);
    uint8_t *copy = malloc(size);
    if (!copy) js_fatal("out of memory copying a regular expression");
    memcpy(copy, bc, size);
    set_matcher(ctx, to, from->source, copy, true);
}

JSValue js_regexp_literal(JSContext *ctx, const JSRegExpLiteral *lit) {
    JSValue obj = regexp_new(ctx, ctx->intrinsics[JS_INTRINSIC_REGEXP_PROTOTYPE]);
    RegExpObject *re = as_regexp(obj);
    JSValue source = lit->source ? js_cell((JSCell *)lit->source) : js_empty_string();
    if (lit->bytecode) {
        set_matcher(ctx, re, source, lit->bytecode, false);
    } else {
        uint8_t *bc = compile(ctx, source, lit->flags);
        if (!bc) return JS_EXCEPTION;
        set_matcher(ctx, re, source, bc, true);
    }
    js_define_data(ctx, &re->obj, JS_ATOM(lastIndex), js_int32(0), JS_PROP_WRITABLE);
    return obj;
}

/* RegExp(pattern, flags) (§22.2.4.1) */
BUILTIN(regexp_ctor) {
    (void)this_val;
    JSValue pattern = ARG(0), flags = ARG(1);
    int pattern_is_regexp = is_regexp(ctx, pattern);
    if (pattern_is_regexp < 0) return JS_EXCEPTION;
    if (js_is_undefined(new_target)) {
        new_target = callee;
        if (pattern_is_regexp && js_is_undefined(flags)) {
            JSValue c = js_get_value(ctx, pattern, JS_ATOM(constructor));
            if (js_is_exception(c)) return c;
            if (js_same_value(ctx, c, new_target)) return pattern;
        }
    }
    RegExpObject *from = as_regexp(pattern);
    JSValue p, f;
    if (from) {
        if (js_is_undefined(flags)) {  /* the same matcher: no compilation */
            JSValue obj = regexp_alloc(ctx, new_target);
            if (js_is_exception(obj)) return obj;
            copy_matcher(ctx, as_regexp(obj), as_regexp(pattern));
            if (set_last_index(ctx, obj, 0) < 0) return JS_EXCEPTION;
            return obj;
        }
        p = from->source;
        f = flags;
    } else if (pattern_is_regexp) {
        p = js_get_value(ctx, pattern, JS_ATOM(source));
        if (js_is_exception(p)) return p;
        f = flags;
        if (js_is_undefined(flags)) {
            f = js_get_value(ctx, pattern, JS_ATOM(flags));
            if (js_is_exception(f)) return f;
        }
    } else {
        p = pattern;
        f = flags;
    }
    JSValue obj = regexp_alloc(ctx, new_target);
    if (js_is_exception(obj)) return obj;
    return regexp_initialize(ctx, obj, p, f);
}

/* RegExp.prototype.compile(pattern, flags) (Annex B.2.4.1) */
BUILTIN(regexp_compile) {
    (void)callee, (void)new_target;
    RegExpObject *re = as_regexp(this_val);
    if (!re) return throw_incompatible(ctx, "compile", this_val);
    JSValue pattern = ARG(0), flags = ARG(1);
    RegExpObject *from = as_regexp(pattern);
    if (from) {
        if (!js_is_undefined(flags)) return js_throw_type_error(ctx, "Cannot supply flags when constructing one RegExp from another");
        copy_matcher(ctx, re, from);
        if (set_last_index(ctx, this_val, 0) < 0) return JS_EXCEPTION;
        return this_val;
    }
    return regexp_initialize(ctx, this_val, pattern, flags);
}

BUILTIN(regexp_species) {
    UNUSED_ARGS;
    return this_val;
}

/* RegExp.escape(string) (§22.2.5.1) */
BUILTIN(regexp_escape) {
    UNUSED_ARGS;
    JSValue s = ARG(0);
    if (!js_is_string(s)) return js_throw_type_error(ctx, "RegExp.escape requires a string");
    JSStrView v = js_string_view(ctx, s);
    uint16_t *out = malloc(((size_t)v.length * 6 + 1) * sizeof *out);
    if (!out) js_fatal("out of memory escaping a string");
    size_t n = 0;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        char hex[16] = "";
        if (c < 33) {
            if (c >= 9 && c <= 13) {
                out[n++] = '\\';
                out[n++] = (uint16_t)"tnvfr"[c - 9];
                continue;
            }
            snprintf(hex, sizeof hex, "\\x%02x", c);
        } else if (c < 128) {
            bool alnum = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
            if ((alnum && i == 0) || (!alnum && strchr(",-=<>#&!%:;@~'`\"", (int)c))) {
                snprintf(hex, sizeof hex, "\\x%02x", c);
            } else {
                if (!alnum && c != '_') out[n++] = '\\';
                out[n++] = (uint16_t)c;
                continue;
            }
        } else if (c < 256) {
            snprintf(hex, sizeof hex, "\\x%02x", c);
        } else if ((c >= 0xD800 && c <= 0xDFFF) || lre_is_space(c)) {
            if (c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length && js_view_at(v, i + 1) >= 0xDC00 && js_view_at(v, i + 1) <= 0xDFFF) {
                out[n++] = (uint16_t)c;  /* a pair is a code point, kept */
                out[n++] = (uint16_t)js_view_at(v, ++i);
                continue;
            }
            snprintf(hex, sizeof hex, "\\u%04x", c);
        } else {
            out[n++] = (uint16_t)c;
            continue;
        }
        for (const char *h = hex; *h; h++) out[n++] = (uint16_t)*h;
    }
    JSValue r = js_new_string_utf16(ctx, out, (uint32_t)n);
    free(out);
    return r;
}

/* ---- Accessors -------------------------------------------------------------------------- */

static JSValue flag_getter(JSContext *ctx, JSValue this_val, int bit, const char *name) {
    RegExpObject *re = as_regexp(this_val);
    if (re) return js_bool((lre_get_flags(re->bytecode) & bit) != 0);
    if (js_is_object(this_val) && js_same_value(ctx, this_val, ctx->intrinsics[JS_INTRINSIC_REGEXP_PROTOTYPE])) return JS_UNDEFINED;
    return js_throw_type_error(ctx, "RegExp.prototype.%s getter called on non-RegExp object", name);
}

#define FLAG_GETTER(fn, bit, name)                                  \
    BUILTIN(fn) {                                                   \
        UNUSED_ARGS;                                                \
        return flag_getter(ctx, this_val, bit, name);               \
    }
FLAG_GETTER(regexp_has_indices, LRE_FLAG_INDICES, "hasIndices")
FLAG_GETTER(regexp_global, LRE_FLAG_GLOBAL, "global")
FLAG_GETTER(regexp_ignore_case, LRE_FLAG_IGNORECASE, "ignoreCase")
FLAG_GETTER(regexp_multiline, LRE_FLAG_MULTILINE, "multiline")
FLAG_GETTER(regexp_dot_all, LRE_FLAG_DOTALL, "dotAll")
FLAG_GETTER(regexp_unicode, LRE_FLAG_UNICODE, "unicode")
FLAG_GETTER(regexp_unicode_sets, LRE_FLAG_UNICODE_SETS, "unicodeSets")
FLAG_GETTER(regexp_sticky, LRE_FLAG_STICKY, "sticky")

static const char *const flag_names[] = { "hasIndices", "global", "ignoreCase", "multiline", "dotAll", "unicode", "unicodeSets", "sticky" };

/* get RegExp.prototype.flags (§22.2.6.4): from the flag getters, observably. */
BUILTIN(regexp_flags) {
    UNUSED_ARGS;
    if (!js_is_object(this_val)) {
        char what[64];
        js_describe_value(ctx, this_val, what, sizeof what);
        return js_throw_type_error(ctx, "RegExp.prototype.flags getter called on non-object %s", what);
    }
    char out[9];
    size_t n = 0;
    for (int i = 0; i < 8; i++) {
        JSValue v = js_get_value(ctx, this_val, js_atom_from_cstr(ctx, flag_names[i]));
        if (js_is_exception(v)) return v;
        if (js_truthy(v)) out[n++] = flag_chars[i];
    }
    return js_new_string_latin1(ctx, (const uint8_t *)out, (uint32_t)n);
}

/* EscapeRegExpPattern (§22.2.6.13.1): / and line terminators escaped, as QuickJS and V8 do. */
static JSValue escape_source(JSContext *ctx, JSValue source) {
    JSStrView v = js_string_view(ctx, source);
    if (v.length == 0) return js_new_string_cstr(ctx, "(?:)");
    uint16_t *out = malloc(((size_t)v.length * 6 + 1) * sizeof *out);
    if (!out) js_fatal("out of memory escaping a pattern");
    size_t n = 0;
    bool in_class = false;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c == '\\' && i + 1 < v.length) {
            out[n++] = '\\';
            c = js_view_at(v, ++i);
            if (c == '\n' || c == '\r' || c == 0x2028 || c == 0x2029) goto line;
            out[n++] = (uint16_t)c;
            continue;
        }
        if (c == '[') in_class = true;
        else if (c == ']') in_class = false;
        else if (c == '/' && !in_class) {
            out[n++] = '\\';
        } else if (c == '\n' || c == '\r' || c == 0x2028 || c == 0x2029) {
            out[n++] = '\\';
        line:
            if (c == '\n') out[n++] = 'n';
            else if (c == '\r') out[n++] = 'r';
            else {
                const char *u = c == 0x2028 ? "u2028" : "u2029";
                for (; *u; u++) out[n++] = (uint16_t)*u;
            }
            continue;
        }
        out[n++] = (uint16_t)c;
    }
    JSValue r = js_new_string_utf16(ctx, out, (uint32_t)n);
    free(out);
    return r;
}

BUILTIN(regexp_source) {
    UNUSED_ARGS;
    RegExpObject *re = as_regexp(this_val);
    if (re) return escape_source(ctx, re->source);
    if (js_is_object(this_val) && js_same_value(ctx, this_val, ctx->intrinsics[JS_INTRINSIC_REGEXP_PROTOTYPE])) return js_new_string_cstr(ctx, "(?:)");
    return js_throw_type_error(ctx, "RegExp.prototype.source getter called on non-RegExp object");
}

/* RegExp.prototype.toString (§22.2.6.17) */
BUILTIN(regexp_to_string) {
    UNUSED_ARGS;
    if (!js_is_object(this_val)) return throw_incompatible(ctx, "toString", this_val);
    JSValue source = js_get_value(ctx, this_val, JS_ATOM(source));
    JSValue s = js_is_exception(source) ? source : js_to_string(ctx, source);
    if (js_is_exception(s)) return s;
    JSValue flags = js_get_value(ctx, this_val, JS_ATOM(flags));
    JSValue f = js_is_exception(flags) ? flags : js_to_string(ctx, flags);
    if (js_is_exception(f)) return f;
    JSValue r = js_concat(ctx, js_char_string('/'), s);
    if (js_is_exception(r)) return r;
    r = js_concat(ctx, r, js_char_string('/'));
    return js_is_exception(r) ? r : js_concat(ctx, r, f);
}

/* ---- Matching ---------------------------------------------------------------------------- */

static JSValue throw_exec_failure(JSContext *ctx, int rc) {
    (void)rc;  /* LRE_RET_MEMORY_ERROR: the backtracking stack couldn't grow */
    return js_throw_range_error(ctx, "Maximum call stack size exceeded");
}

/* RegExpBuiltinExec (§22.2.7.2): the match array, or null. */
static JSValue builtin_exec(JSContext *ctx, JSValue rx, JSValue s) {
    RegExpObject *re = as_regexp(rx);
    double last_index;
    if (js_is_exception(get_last_index(ctx, rx, &last_index))) return JS_EXCEPTION;
    const uint8_t *bc = re->bytecode;
    int flags = lre_get_flags(bc);
    bool global_or_sticky = (flags & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) != 0;
    if (!global_or_sticky) last_index = 0;
    JSStrView v = js_string_view(ctx, s);
    int alloc_count = lre_get_alloc_count(bc), capture_count = lre_get_capture_count(bc);
    uint8_t *small[32], **capture = alloc_count <= 32 ? small : malloc(sizeof *capture * (size_t)alloc_count);
    if (!capture) js_fatal("out of memory matching a regular expression");
    int shift = v.latin1 ? 0 : 1;
    const uint8_t *buf = v.chars;
    int rc = last_index > v.length ? 2 : run(ctx, re, v, (uint32_t)last_index, capture);
    JSValue result = JS_NULL;
    if (rc < 0) {
        result = throw_exec_failure(ctx, rc);
    } else if (rc != 1) {
        if (global_or_sticky && set_last_index(ctx, rx, 0) < 0) result = JS_EXCEPTION;
    } else {
        uint32_t end = (uint32_t)((capture[1] - buf) >> shift);
        if (global_or_sticky && set_last_index(ctx, rx, end) < 0) {
            result = JS_EXCEPTION;
            goto out;
        }
        /* user code ran (a lastIndex setter): s is the same string, but read positions now */
        uint32_t starts[256], ends[256], *st = starts, *en = ends;
        if (capture_count > 256) {
            st = malloc(sizeof *st * (size_t)capture_count * 2);
            if (!st) js_fatal("out of memory matching a regular expression");
            en = st + capture_count;
        }
        for (int i = 0; i < capture_count; i++) {
            bool set = capture[2 * i] && capture[2 * i + 1];
            st[i] = set ? (uint32_t)((capture[2 * i] - buf) >> shift) : UINT32_MAX;
            en[i] = set ? (uint32_t)((capture[2 * i + 1] - buf) >> shift) : UINT32_MAX;
        }
        uint32_t match_start = st[0];
        const char *names = lre_get_groupnames(bc);
        JSValue a = js_new_array(ctx, (uint32_t)capture_count);
        JSValue groups = names ? js_new_object_proto(ctx, JS_NULL, 4) : JS_UNDEFINED;
        bool has_indices = (flags & LRE_FLAG_INDICES) != 0;
        JSValue indices = has_indices ? js_new_array(ctx, (uint32_t)capture_count) : JS_UNDEFINED;
        JSValue index_groups = has_indices && names ? js_new_object_proto(ctx, JS_NULL, 4) : JS_UNDEFINED;
        for (int i = 0; i < capture_count; i++) {
            JSValue name = JS_EMPTY;
            if (names && i > 0) {
                if (*names) name = js_atom_from_cstr(ctx, names);
                names += strlen(names) + LRE_GROUP_NAME_TRAILER_LEN;
            }
            JSValue val = st[i] == UINT32_MAX ? JS_UNDEFINED : js_substring(ctx, s, st[i], en[i]);
            if (js_is_exception(val) || js_array_push(ctx, js_as_object(a), val) < 0) {
                result = JS_EXCEPTION;
                break;
            }
            JSValue pair = JS_UNDEFINED;
            if (has_indices) {
                if (st[i] != UINT32_MAX) {
                    JSValue p[2] = { js_number(st[i]), js_number(en[i]) };
                    pair = js_new_array_from(ctx, p, 2);
                }
                if (js_array_push(ctx, js_as_object(indices), pair) < 0) {
                    result = JS_EXCEPTION;
                    break;
                }
            }
            if (!js_is_empty(name)) {
                /* duplicate names (in different alternatives): the one that matched */
                int had = js_has_property(ctx, js_as_object(groups), name);
                if (!js_is_undefined(val) || had == 0) js_define_data(ctx, js_as_object(groups), name, val, JS_PROP_DEFAULT);
                if (has_indices && (!js_is_undefined(pair) || had == 0)) js_define_data(ctx, js_as_object(index_groups), name, pair, JS_PROP_DEFAULT);
            }
        }
        if (st != starts) free(st);
        if (!js_is_exception(result)) {
            JSObject *o = js_as_object(a);
            js_define_data(ctx, o, JS_ATOM(index), js_number(match_start), JS_PROP_DEFAULT);
            js_define_data(ctx, o, JS_ATOM(input), s, JS_PROP_DEFAULT);
            js_define_data(ctx, o, JS_ATOM(groups), groups, JS_PROP_DEFAULT);
            if (has_indices) {
                js_define_data(ctx, js_as_object(indices), JS_ATOM(groups), index_groups, JS_PROP_DEFAULT);
                js_define_data(ctx, o, js_atom_from_cstr(ctx, "indices"), indices, JS_PROP_DEFAULT);
            }
            result = a;
        }
    }
out:
    if (capture != small) free(capture);
    return result;
}

/* RegExpExec (§22.2.7.1): the object's exec, or the built-in one. */
static JSValue regexp_exec(JSContext *ctx, JSValue rx, JSValue s) {
    JSValue exec = js_get_value(ctx, rx, JS_ATOM(exec));
    if (js_is_exception(exec)) return exec;
    if (js_same_value(ctx, exec, ctx->intrinsics[JS_INTRINSIC_REGEXP_EXEC]) && as_regexp(rx)) return builtin_exec(ctx, rx, s);
    if (js_is_callable(exec)) {
        JSValue r = js_call(ctx, exec, rx, 1, &s);
        if (js_is_exception(r)) return r;
        if (!js_is_object(r) && !js_is_null(r)) return js_throw_type_error(ctx, "RegExp exec method returned something other than an Object or null");
        return r;
    }
    if (!as_regexp(rx)) return throw_incompatible(ctx, "exec", rx);
    return builtin_exec(ctx, rx, s);
}

BUILTIN(regexp_proto_exec) {
    UNUSED_ARGS;
    if (!as_regexp(this_val)) return throw_incompatible(ctx, "exec", this_val);
    JSValue s = js_to_string(ctx, ARG(0));
    return js_is_exception(s) ? s : builtin_exec(ctx, this_val, s);
}

/* ---- Unmodified RegExps --------------------------------------------------------------------
 *
 * The methods below follow the spec step by step: Get(rx, "flags") through the flag getters,
 * RegExpExec through `exec`, lastIndex read and written as a property, a match array for every
 * match. For a RegExp as created, on a RegExp.prototype whose methods are the originals, none of
 * that is observable: test, @@match, @@replace, @@search and @@split then run the matcher
 * directly and make only what they return (V8 does the same). Checked at every call, after the
 * steps that can run code (ToString of the arguments). */

static const JSNativeFn flag_fns[] = { regexp_has_indices, regexp_global, regexp_ignore_case, regexp_multiline,
                                       regexp_dot_all, regexp_unicode, regexp_unicode_sets, regexp_sticky };

static bool is_builtin(JSValue f, JSNativeFn fn) { return js_is_function(f) && js_as_function(f)->entry == fn; }

/* o's own `key` is a data property holding the built-in fn, or (getter) an accessor whose getter is. */
static bool own_builtin(JSObject *o, JSValue key, JSNativeFn fn, bool getter) {
    uint8_t attrs;
    int32_t slot = js_shape_find(o->shape, key, &attrs);
    if (slot < 0 || ((attrs & JS_PROP_ACCESSOR) != 0) != getter) return false;
    JSValue v = *js_object_slot(o, (uint32_t)slot);
    return is_builtin(getter ? ((JSAccessorPair *)js_as_cell(v))->get : v, fn);
}

/* rx, when it's a RegExp whose one own property is lastIndex, writable and a number, on the
 * realm's RegExp.prototype with the original exec: RegExpExec is then RegExpBuiltinExec, and
 * lastIndex reads and writes as its slot. Else NULL. */
static RegExpObject *unmodified(JSContext *ctx, JSValue rx) {
    RegExpObject *re = as_regexp(rx);
    if (!re) return NULL;
    JSShape *s = re->obj.shape;
    JSValue proto = ctx->intrinsics[JS_INTRINSIC_REGEXP_PROTOTYPE];
    if (s->prop_count != 1 || (s->flags & JS_SHAPE_DICTIONARY) || !js_same_bits(s->proto, proto) ||
        !js_same_bits(s->key, JS_ATOM(lastIndex)) || s->attrs != JS_PROP_WRITABLE || !js_is_number(*js_object_slot(&re->obj, 0)))
        return NULL;
    return own_builtin(js_as_object(proto), JS_ATOM(exec), regexp_proto_exec, false) ? re : NULL;
}

/* Get(rx, "flags") on an unmodified RegExp runs the original getters only: its flags are its
 * bytecode's. */
static bool flags_unmodified(JSContext *ctx) {
    JSObject *p = js_as_object(ctx->intrinsics[JS_INTRINSIC_REGEXP_PROTOTYPE]);
    if (!own_builtin(p, JS_ATOM(flags), regexp_flags, true)) return false;
    for (int i = 0; i < 8; i++)
        if (!own_builtin(p, js_atom_from_cstr(ctx, flag_names[i]), flag_fns[i], true)) return false;
    return true;
}

static double slot_last_index(JSContext *ctx, RegExpObject *re) {
    double d;
    if (to_length(ctx, *js_object_slot(&re->obj, 0), &d) < 0) js_fatal("ToLength of a number");
    return d;
}

static void store_last_index(JSContext *ctx, RegExpObject *re, double index) {
    js_store(ctx, &re->obj.cell, js_object_slot(&re->obj, 0), js_number(index));
}

/* The index in v of a position lre_exec gave. */
static uint32_t index_of(JSStrView v, const uint8_t *p) {
    return (uint32_t)((p - (const uint8_t *)v.chars) >> (v.latin1 ? 0 : 1));
}

/* lre_exec's capture[] for bc: `small`, or malloc'd (free it when it isn't `small`). */
static uint8_t **capture_buffer(const uint8_t *bc, uint8_t **small) {
    int n = lre_get_alloc_count(bc);
    if (n <= 32) return small;
    uint8_t **capture = malloc(sizeof *capture * (size_t)n);
    if (!capture) js_fatal("out of memory matching a regular expression");
    return capture;
}

/* test(s) (§22.2.6.16) on an unmodified RegExp: RegExpBuiltinExec without the match array. */
static JSValue test_unmodified(JSContext *ctx, RegExpObject *re, JSValue s) {
    int flags = lre_get_flags(re->bytecode);
    bool global_or_sticky = (flags & (LRE_FLAG_GLOBAL | LRE_FLAG_STICKY)) != 0;
    double from = global_or_sticky ? slot_last_index(ctx, re) : 0;
    JSStrView v = js_string_view(ctx, s);
    uint8_t *small[32], **capture = capture_buffer(re->bytecode, small);
    int rc = from > v.length ? 0 : run(ctx, re, v, (uint32_t)from, capture);
    if (rc > 0 && global_or_sticky) store_last_index(ctx, re, index_of(v, capture[1]));
    if (rc == 0 && global_or_sticky) store_last_index(ctx, re, 0);
    if (capture != small) free(capture);
    return rc < 0 ? throw_exec_failure(ctx, rc) : js_bool(rc > 0);
}

/* @@match with the g flag on an unmodified RegExp: the matched strings, or null. */
static JSValue match_global_unmodified(JSContext *ctx, RegExpObject *re, JSValue s) {
    bool unicode = (lre_get_flags(re->bytecode) & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
    uint8_t *small[32], **capture = capture_buffer(re->bytecode, small);
    JSValue a = js_new_array(ctx, 0), result;
    double i = 0;
    for (;;) {
        JSStrView v = js_string_view(ctx, s);
        int rc = i > v.length ? 0 : run(ctx, re, v, (uint32_t)i, capture);
        if (rc < 0) {
            store_last_index(ctx, re, i);
            result = throw_exec_failure(ctx, rc);
            break;
        }
        if (rc == 0) {
            store_last_index(ctx, re, 0);
            result = js_array_length(js_as_object(a)) ? a : JS_NULL;
            break;
        }
        uint32_t start = index_of(v, capture[0]), end = index_of(v, capture[1]);
        JSValue m = js_substring(ctx, s, start, end);
        if (js_is_exception(m) || js_array_push(ctx, js_as_object(a), m) < 0) {
            result = JS_EXCEPTION;
            break;
        }
        i = end == start ? advance_index(ctx, s, end, unicode) : end;
    }
    if (capture != small) free(capture);
    return result;
}

/* @@search on an unmodified RegExp: lastIndex ends as it was, so it's left alone. */
static JSValue search_unmodified(JSContext *ctx, RegExpObject *re, JSValue s) {
    JSStrView v = js_string_view(ctx, s);
    uint8_t *small[32], **capture = capture_buffer(re->bytecode, small);
    int rc = run(ctx, re, v, 0, capture);
    double index = rc > 0 ? (double)index_of(v, capture[0]) : -1;
    if (capture != small) free(capture);
    return rc < 0 ? throw_exec_failure(ctx, rc) : js_number(index);
}

BUILTIN(regexp_test) {
    UNUSED_ARGS;
    if (!js_is_object(this_val)) return throw_incompatible(ctx, "test", this_val);
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    RegExpObject *re = unmodified(ctx, this_val);
    if (re) return test_unmodified(ctx, re, s);
    JSValue r = regexp_exec(ctx, this_val, s);
    return js_is_exception(r) ? r : js_bool(!js_is_null(r));
}

/* The string at match[0], for the global loops. */
static JSValue match_string(JSContext *ctx, JSValue result) {
    JSValue m = js_get_value(ctx, result, js_int32(0));
    return js_is_exception(m) ? m : js_to_string(ctx, m);
}

/* After an empty match: lastIndex moves on by a character. */
static int step_past_empty(JSContext *ctx, JSValue rx, JSValue s, bool unicode) {
    double this_index;
    if (js_is_exception(get_last_index(ctx, rx, &this_index))) return -1;
    return set_last_index(ctx, rx, advance_index(ctx, s, this_index, unicode));
}

/* RegExp.prototype[@@match](string) (§22.2.6.8) */
BUILTIN(regexp_symbol_match) {
    UNUSED_ARGS;
    JSValue rx = this_val;
    if (!js_is_object(rx)) return throw_incompatible(ctx, "@@match", rx);
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    RegExpObject *re = unmodified(ctx, rx);
    if (re && flags_unmodified(ctx))
        return lre_get_flags(re->bytecode) & LRE_FLAG_GLOBAL ? match_global_unmodified(ctx, re, s) : builtin_exec(ctx, rx, s);
    JSValue flags = js_get_value(ctx, rx, JS_ATOM(flags));
    JSValue f = js_is_exception(flags) ? flags : js_to_string(ctx, flags);
    if (js_is_exception(f)) return f;
    if (!has_unit(ctx, f, 'g')) return regexp_exec(ctx, rx, s);
    bool unicode = has_unit(ctx, f, 'u') || has_unit(ctx, f, 'v');
    if (set_last_index(ctx, rx, 0) < 0) return JS_EXCEPTION;
    JSValue a = js_new_array(ctx, 0);
    for (uint32_t n = 0;; n++) {
        JSValue result = regexp_exec(ctx, rx, s);
        if (js_is_exception(result)) return result;
        if (js_is_null(result)) return n == 0 ? JS_NULL : a;
        JSValue m = match_string(ctx, result);
        if (js_is_exception(m) || js_array_push(ctx, js_as_object(a), m) < 0) return JS_EXCEPTION;
        if (js_string_length(m) == 0 && step_past_empty(ctx, rx, s, unicode) < 0) return JS_EXCEPTION;
    }
}

/* ---- matchAll's iterator (§22.2.9) ------------------------------------------------------- */

typedef struct RegExpStringIterator {
    JSObject obj;
    JSValue  regexp;
    JSValue  string;
    bool     global, unicode, done;
} RegExpStringIterator;

static void iterator_visit(JSCell *c, JSTracer *trc) {
    RegExpStringIterator *it = (RegExpStringIterator *)c;
    js_trace_value(trc, it->regexp);
    js_trace_value(trc, it->string);
}

static const JSClass iterator_class = { "RegExp String Iterator", sizeof(RegExpStringIterator), NULL, NULL, NULL, NULL, iterator_visit, NULL, NULL };

BUILTIN(regexp_string_iterator_next) {
    UNUSED_ARGS;
    if (!js_is_object(this_val) || js_as_object(this_val)->shape->cls != &iterator_class) {
        char what[64];
        js_describe_value(ctx, this_val, what, sizeof what);
        return js_throw_type_error(ctx, "Method %%RegExpStringIterator%%.prototype.next called on incompatible receiver %s", what);
    }
    RegExpStringIterator *it = (RegExpStringIterator *)js_as_object(this_val);
    if (it->done) return js_iter_result(ctx, JS_UNDEFINED, true);
    JSValue match = regexp_exec(ctx, it->regexp, it->string);
    if (js_is_exception(match)) return match;
    if (js_is_null(match)) {
        it->done = true;
        return js_iter_result(ctx, JS_UNDEFINED, true);
    }
    if (!it->global) {
        it->done = true;
        return js_iter_result(ctx, match, false);
    }
    JSValue m = match_string(ctx, match);
    if (js_is_exception(m)) return m;
    if (js_string_length(m) == 0 && step_past_empty(ctx, it->regexp, it->string, it->unicode) < 0) return JS_EXCEPTION;
    return js_iter_result(ctx, match, false);
}

/* RegExp.prototype[@@matchAll](string) (§22.2.6.9) */
BUILTIN(regexp_symbol_match_all) {
    UNUSED_ARGS;
    JSValue r = this_val;
    if (!js_is_object(r)) return throw_incompatible(ctx, "@@matchAll", r);
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    JSValue c = species_constructor(ctx, r);
    if (js_is_exception(c)) return c;
    JSValue flags = js_get_value(ctx, r, JS_ATOM(flags));
    JSValue f = js_is_exception(flags) ? flags : js_to_string(ctx, flags);
    if (js_is_exception(f)) return f;
    JSValue args[2] = { r, f };
    JSValue matcher = js_construct(ctx, c, 2, args, c, NULL);
    if (js_is_exception(matcher)) return matcher;
    double last_index;
    if (js_is_exception(get_last_index(ctx, r, &last_index))) return JS_EXCEPTION;
    if (set_last_index(ctx, matcher, last_index) < 0) return JS_EXCEPTION;
    JSShape *shape = js_shape_root(ctx, &iterator_class, ctx->intrinsics[JS_INTRINSIC_REGEXP_STRING_ITERATOR_PROTOTYPE], 0);
    RegExpStringIterator *it = (RegExpStringIterator *)js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    js_store(ctx, &it->obj.cell, &it->regexp, matcher);
    js_store(ctx, &it->obj.cell, &it->string, s);
    it->global = has_unit(ctx, f, 'g');
    it->unicode = has_unit(ctx, f, 'u') || has_unit(ctx, f, 'v');
    it->done = false;
    return js_object_value(&it->obj);
}

/* ---- @@replace ------------------------------------------------------------------------------ */

/* A growable UTF-16 buffer. */
typedef struct {
    uint16_t *units;
    size_t length, cap;
} Builder;

static void reserve(Builder *b, size_t more) {
    if (b->length + more <= b->cap) return;
    size_t cap = b->cap ? b->cap * 2 : 64;
    while (cap < b->length + more) cap *= 2;
    uint16_t *u = realloc(b->units, cap * sizeof *u);
    if (!u) js_fatal("out of memory building a string");
    b->units = u;
    b->cap = cap;
}

static void put_view(Builder *b, JSStrView v, uint32_t start, uint32_t end) {
    if (end <= start) return;
    reserve(b, end - start);
    for (uint32_t i = start; i < end; i++) b->units[b->length++] = (uint16_t)js_view_at(v, i);
}

static void put_string(Builder *b, JSContext *ctx, JSValue s) {
    JSStrView v = js_string_view(ctx, s);
    put_view(b, v, 0, v.length);
}

static JSValue finish(JSContext *ctx, Builder *b) {
    if (b->length > JS_STRING_MAX_LENGTH) {
        free(b->units);
        return js_throw_range_error(ctx, "Invalid string length");
    }
    JSValue s = js_new_string_utf16(ctx, b->units, (uint32_t)b->length);
    free(b->units);
    return s;
}

/* GetSubstitution (§22.1.3.19.1): the replacement template with $$, $&, $`, $', $n, $nn and
 * $<name> expanded. captures[i] is capture i + 1: a string or undefined. 0, or -1. */
static int get_substitution(JSContext *ctx, Builder *b, JSValue matched, JSValue str, uint32_t position, const JSValue *captures,
                            uint32_t m, JSValue named, JSValue replacement) {
    JSStrView r = js_string_view(ctx, replacement);
    uint32_t match_length = js_string_length(matched);
    uint32_t str_length = js_string_length(str);
    for (uint32_t i = 0; i < r.length; i++) {
        uint32_t c = js_view_at(r, i);
        if (c != '$' || i + 1 >= r.length) {
            reserve(b, 1);
            b->units[b->length++] = (uint16_t)c;
            continue;
        }
        uint32_t d = js_view_at(r, i + 1);
        JSStrView sv;
        if (d == '$') {
            reserve(b, 1);
            b->units[b->length++] = '$';
            i++;
        } else if (d == '&') {
            put_string(b, ctx, matched);
            i++;
        } else if (d == '`') {
            sv = js_string_view(ctx, str);
            put_view(b, sv, 0, position);
            i++;
        } else if (d == '\'') {
            uint32_t tail = position + match_length;
            sv = js_string_view(ctx, str);
            if (tail < str_length) put_view(b, sv, tail, str_length);
            i++;
        } else if (d >= '0' && d <= '9') {
            uint32_t digits = i + 2 < r.length && js_view_at(r, i + 2) >= '0' && js_view_at(r, i + 2) <= '9' ? 2 : 1;
            uint32_t index = digits == 2 ? (d - '0') * 10 + (js_view_at(r, i + 2) - '0') : d - '0';
            if (index > m && digits == 2) {
                digits = 1;
                index = d - '0';
            }
            if (index >= 1 && index <= m) {
                JSValue cap = captures[index - 1];
                if (!js_is_undefined(cap)) put_string(b, ctx, cap);
                i += digits;
            } else {
                reserve(b, 1);
                b->units[b->length++] = '$';
            }
        } else if (d == '<' && !js_is_undefined(named)) {
            uint32_t close = i + 2;
            while (close < r.length && js_view_at(r, close) != '>') close++;
            if (close >= r.length) {
                reserve(b, 1);
                b->units[b->length++] = '$';
                continue;
            }
            JSValue name = js_substring(ctx, replacement, i + 2, close);
            JSValue key = js_is_exception(name) ? name : js_to_property_key(ctx, name);
            if (js_is_exception(key)) return -1;
            JSValue cap = js_get_value(ctx, named, key);
            if (js_is_exception(cap)) return -1;
            if (!js_is_undefined(cap)) {
                JSValue cs = js_to_string(ctx, cap);
                if (js_is_exception(cs)) return -1;
                put_string(b, ctx, cs);
            }
            r = js_string_view(ctx, replacement);  /* user code ran */
            i = close;
        } else {
            reserve(b, 1);
            b->units[b->length++] = '$';
        }
    }
    return 0;
}

/* @@replace on an unmodified RegExp without named groups, of at most 32 captures. Every match is
 * found before a replacement function first runs, as in the spec, which collects the match
 * arrays first: positions only here, the strings made as each replacement needs them. */
static JSValue replace_unmodified(JSContext *ctx, RegExpObject *re, JSValue s, JSValue replace_value, bool functional) {
    const uint8_t *bc = re->bytecode;
    int flags = lre_get_flags(bc);
    uint32_t ncap = (uint32_t)lre_get_capture_count(bc);
    bool global = (flags & LRE_FLAG_GLOBAL) != 0, sticky = (flags & LRE_FLAG_STICKY) != 0;
    bool unicode = (flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
    uint32_t *pos = NULL;  /* each match's captures: start and end, UINT32_MAX when unset */
    size_t count = 0, cap = 0;
    uint8_t *small[32], **capture = capture_buffer(bc, small);
    double i = global || !sticky ? 0 : slot_last_index(ctx, re);
    int rc;
    for (;;) {
        JSStrView v = js_string_view(ctx, s);
        rc = i > v.length ? 0 : run(ctx, re, v, (uint32_t)i, capture);
        if (rc <= 0) break;
        if (count == cap) {
            cap = cap ? cap * 2 : 8;
            uint32_t *grown = realloc(pos, cap * 2 * ncap * sizeof *pos);
            if (!grown) js_fatal("out of memory replacing");
            pos = grown;
        }
        uint32_t *m = pos + count++ * 2 * ncap;
        for (uint32_t k = 0; k < ncap; k++) {
            bool set = capture[2 * k] && capture[2 * k + 1];
            m[2 * k] = set ? index_of(v, capture[2 * k]) : UINT32_MAX;
            m[2 * k + 1] = set ? index_of(v, capture[2 * k + 1]) : UINT32_MAX;
        }
        if (!global) break;
        i = m[1] == m[0] ? advance_index(ctx, s, m[1], unicode) : m[1];
    }
    if (capture != small) free(capture);
    if (global) store_last_index(ctx, re, rc < 0 ? i : 0);
    else if (sticky && rc >= 0) store_last_index(ctx, re, rc ? pos[1] : 0);
    if (rc < 0) {
        free(pos);
        return throw_exec_failure(ctx, rc);
    }
    bool dollar = !functional && has_unit(ctx, replace_value, '$');
    Builder b = { 0 };
    uint32_t next = 0;
    for (size_t j = 0; j < count; j++) {
        const uint32_t *m = pos + j * 2 * ncap;
        if (m[0] > next) put_view(&b, js_string_view(ctx, s), next, m[0]);
        if (!functional && !dollar) {
            put_string(&b, ctx, replace_value);
        } else {
            JSValue args[34];  /* the match, its captures, the position, the string */
            for (uint32_t k = 0; k < ncap; k++) {
                args[k] = m[2 * k] == UINT32_MAX ? JS_UNDEFINED : js_substring(ctx, s, m[2 * k], m[2 * k + 1]);
                if (js_is_exception(args[k])) goto fail;
            }
            if (functional) {
                args[ncap] = js_number(m[0]);
                args[ncap + 1] = s;
                JSValue r = js_call(ctx, replace_value, JS_UNDEFINED, ncap + 2, args);
                JSValue replacement = js_is_exception(r) ? r : js_to_string(ctx, r);
                if (js_is_exception(replacement)) goto fail;
                put_string(&b, ctx, replacement);
            } else if (get_substitution(ctx, &b, args[0], s, m[0], args + 1, ncap - 1, JS_UNDEFINED, replace_value) < 0) {
                goto fail;
            }
        }
        next = m[1];
    }
    uint32_t length = js_string_length(s);
    if (next < length) put_view(&b, js_string_view(ctx, s), next, length);
    free(pos);
    return finish(ctx, &b);
fail:
    free(pos);
    free(b.units);
    return JS_EXCEPTION;
}

/* RegExp.prototype[@@replace](string, replaceValue) (§22.2.6.11) */
BUILTIN(regexp_symbol_replace) {
    UNUSED_ARGS;
    JSValue rx = this_val, replace_value = ARG(1);
    if (!js_is_object(rx)) return throw_incompatible(ctx, "@@replace", rx);
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    uint32_t length = js_string_length(s);
    bool functional = js_is_callable(replace_value);
    if (!functional) {
        replace_value = js_to_string(ctx, replace_value);
        if (js_is_exception(replace_value)) return replace_value;
    }
    RegExpObject *re = unmodified(ctx, rx);
    if (re && lre_get_capture_count(re->bytecode) <= 32 && !lre_get_groupnames(re->bytecode) && flags_unmodified(ctx))
        return replace_unmodified(ctx, re, s, replace_value, functional);
    JSValue flags = js_get_value(ctx, rx, JS_ATOM(flags));
    JSValue f = js_is_exception(flags) ? flags : js_to_string(ctx, flags);
    if (js_is_exception(f)) return f;
    bool global = has_unit(ctx, f, 'g'), unicode = false;
    if (global) {
        unicode = has_unit(ctx, f, 'u') || has_unit(ctx, f, 'v');
        if (set_last_index(ctx, rx, 0) < 0) return JS_EXCEPTION;
    }
    JSValue results = js_new_array(ctx, 1);  /* the matches, in a GC-visible array */
    for (;;) {
        JSValue result = regexp_exec(ctx, rx, s);
        if (js_is_exception(result)) return result;
        if (js_is_null(result)) break;
        if (js_array_push(ctx, js_as_object(results), result) < 0) return JS_EXCEPTION;
        if (!global) break;
        JSValue m = match_string(ctx, result);
        if (js_is_exception(m)) return m;
        if (js_string_length(m) == 0 && step_past_empty(ctx, rx, s, unicode) < 0) return JS_EXCEPTION;
    }
    Builder b = { 0 };
    uint32_t next_source_position = 0;
    uint32_t count = js_array_length(js_as_object(results));
    for (uint32_t j = 0; j < count; j++) {
        JSValue result = js_get_value(ctx, results, js_int32((int32_t)j));
        double n_captures;
        if (js_length_of_array_like(ctx, result, &n_captures) < 0) goto fail;
        n_captures = n_captures > 1 ? n_captures - 1 : 0;
        JSValue matched = match_string(ctx, result);
        if (js_is_exception(matched)) goto fail;
        JSValue pos = js_get_value(ctx, result, JS_ATOM(index));
        double position;
        if (js_is_exception(pos) || js_to_integer_or_infinity(ctx, &position, pos) < 0) goto fail;
        position = position < 0 ? 0 : position > length ? length : position;
        /* the captures (and, for a function, position, string and groups after them) */
        JSValue args = js_new_array(ctx, (uint32_t)n_captures + 4);
        if (js_array_push(ctx, js_as_object(args), matched) < 0) goto fail;
        for (double n = 1; n <= n_captures; n++) {
            JSValue cap = js_get_value(ctx, result, js_index_key_of(ctx, n));
            if (js_is_exception(cap)) goto fail;
            if (!js_is_undefined(cap)) {
                cap = js_to_string(ctx, cap);
                if (js_is_exception(cap)) goto fail;
            }
            if (js_array_push(ctx, js_as_object(args), cap) < 0) goto fail;
        }
        JSValue named = js_get_value(ctx, result, JS_ATOM(groups));
        if (js_is_exception(named)) goto fail;
        JSValue replacement;
        if (functional) {
            if (js_array_push(ctx, js_as_object(args), js_number(position)) < 0 || js_array_push(ctx, js_as_object(args), s) < 0) goto fail;
            if (!js_is_undefined(named) && js_array_push(ctx, js_as_object(args), named) < 0) goto fail;
            JSObject *a = js_as_object(args);
            uint32_t argc2 = js_array_length(a);
            JSValue *list = malloc(sizeof *list * argc2);
            if (!list) js_fatal("out of memory replacing");
            for (uint32_t k = 0; k < argc2; k++) list[k] = js_get_value(ctx, args, js_int32((int32_t)k));
            JSValue r = js_call(ctx, replace_value, JS_UNDEFINED, argc2, list);
            free(list);
            replacement = js_is_exception(r) ? r : js_to_string(ctx, r);
            if (js_is_exception(replacement)) goto fail;
        } else {
            if (!js_is_undefined(named)) {
                named = js_to_object(ctx, named);
                if (js_is_exception(named)) goto fail;
            }
            uint32_t m = (uint32_t)n_captures;
            JSValue *caps = malloc(sizeof *caps * (m ? m : 1));
            if (!caps) js_fatal("out of memory replacing");
            for (uint32_t k = 0; k < m; k++) caps[k] = js_get_value(ctx, args, js_int32((int32_t)k + 1));
            Builder rb = { 0 };
            int ok = get_substitution(ctx, &rb, matched, s, (uint32_t)position, caps, m, named, replace_value);
            free(caps);
            if (ok < 0) {
                free(rb.units);
                goto fail;
            }
            replacement = finish(ctx, &rb);
            if (js_is_exception(replacement)) goto fail;
        }
        if (position >= next_source_position) {
            JSStrView sv = js_string_view(ctx, s);
            put_view(&b, sv, next_source_position, (uint32_t)position);
            put_string(&b, ctx, replacement);
            next_source_position = (uint32_t)position + js_string_length(matched);
        }
    }
    if (next_source_position < length) put_view(&b, js_string_view(ctx, s), next_source_position, length);
    return finish(ctx, &b);
fail:
    free(b.units);
    return JS_EXCEPTION;
}

/* ---- @@search, @@split -------------------------------------------------------------------- */

/* RegExp.prototype[@@search](string) (§22.2.6.12) */
BUILTIN(regexp_symbol_search) {
    UNUSED_ARGS;
    JSValue rx = this_val;
    if (!js_is_object(rx)) return throw_incompatible(ctx, "@@search", rx);
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    RegExpObject *re = unmodified(ctx, rx);
    if (re) return search_unmodified(ctx, re, s);
    JSValue previous = js_get_value(ctx, rx, JS_ATOM(lastIndex));
    if (js_is_exception(previous)) return previous;
    if (!js_same_value(ctx, previous, js_int32(0)) && set_last_index(ctx, rx, 0) < 0) return JS_EXCEPTION;
    JSValue result = regexp_exec(ctx, rx, s);
    if (js_is_exception(result)) return result;
    JSValue current = js_get_value(ctx, rx, JS_ATOM(lastIndex));
    if (js_is_exception(current)) return current;
    if (!js_same_value(ctx, current, previous) && js_set_value(ctx, rx, JS_ATOM(lastIndex), previous, true) < 0) return JS_EXCEPTION;
    if (js_is_null(result)) return js_int32(-1);
    return js_get_value(ctx, result, JS_ATOM(index));
}

/* @@split's splitter is new %RegExp%(rx, flags + "y") without running code when rx is unmodified,
 * RegExp.prototype's constructor and @@match and RegExp's @@species are the originals. */
static bool species_unmodified(JSContext *ctx) {
    JSObject *p = js_as_object(ctx->intrinsics[JS_INTRINSIC_REGEXP_PROTOTYPE]);
    JSValue c = ctx->intrinsics[JS_INTRINSIC_REGEXP];
    uint8_t attrs;
    int32_t slot = js_shape_find(p->shape, JS_ATOM(constructor), &attrs);
    return slot >= 0 && !(attrs & JS_PROP_ACCESSOR) && js_same_bits(*js_object_slot(p, (uint32_t)slot), c) &&
           own_builtin(p, JS_SYMBOL(match), regexp_symbol_match, false) && own_builtin(js_as_object(c), JS_SYMBOL(species), regexp_species, true);
}

/* @@split on an unmodified RegExp without the y, u or v flags. The spec's splitter tries a
 * sticky match at each position q in turn; a search from q finds the first q that matches, with
 * the same match there, and no splitter is made. */
static JSValue split_unmodified(JSContext *ctx, RegExpObject *re, JSValue s, uint32_t lim) {
    JSValue a = js_new_array(ctx, 0);
    if (lim == 0) return a;
    uint32_t ncap = (uint32_t)lre_get_capture_count(re->bytecode);
    uint8_t *small[32], **capture = capture_buffer(re->bytecode, small);
    uint32_t size = js_string_length(s), p = 0, q = 0;
    JSValue result = a;
    if (size == 0) {
        int rc = run(ctx, re, js_string_view(ctx, s), 0, capture);
        if (rc < 0) result = throw_exec_failure(ctx, rc);
        else if (rc == 0 && js_array_push(ctx, js_as_object(a), s) < 0) result = JS_EXCEPTION;
        goto out;
    }
    while (q < size) {
        JSStrView v = js_string_view(ctx, s);
        int rc = run(ctx, re, v, q, capture);
        if (rc < 0) {
            result = throw_exec_failure(ctx, rc);
            goto out;
        }
        if (rc == 0) break;
        uint32_t start = index_of(v, capture[0]), e = index_of(v, capture[1]);
        if (start >= size) break;  /* the spec's loop stops before trying the end */
        if (e == p) {  /* empty, where the last piece ended */
            q = start + 1;
            continue;
        }
        uint32_t bounds[64];  /* the captures, read before allocating */
        for (uint32_t k = 1; k < ncap && k < 33; k++) {
            bool set = capture[2 * k] && capture[2 * k + 1];
            bounds[2 * (k - 1)] = set ? index_of(v, capture[2 * k]) : UINT32_MAX;
            bounds[2 * (k - 1) + 1] = set ? index_of(v, capture[2 * k + 1]) : UINT32_MAX;
        }
        JSValue sub = js_substring(ctx, s, p, start);
        if (js_is_exception(sub) || js_array_push(ctx, js_as_object(a), sub) < 0) {
            result = JS_EXCEPTION;
            goto out;
        }
        if (js_array_length(js_as_object(a)) == lim) goto out;
        p = e;
        for (uint32_t k = 1; k < ncap; k++) {
            uint32_t lo = bounds[2 * (k - 1)], hi = bounds[2 * (k - 1) + 1];
            JSValue c = lo == UINT32_MAX ? JS_UNDEFINED : js_substring(ctx, s, lo, hi);
            if (js_is_exception(c) || js_array_push(ctx, js_as_object(a), c) < 0) {
                result = JS_EXCEPTION;
                goto out;
            }
            if (js_array_length(js_as_object(a)) == lim) goto out;
        }
        q = p;
    }
    {
        JSValue tail = js_substring(ctx, s, p < size ? p : size, size);
        if (js_is_exception(tail) || js_array_push(ctx, js_as_object(a), tail) < 0) result = JS_EXCEPTION;
    }
out:
    if (capture != small) free(capture);
    return result;
}

/* RegExp.prototype[@@split](string, limit) (§22.2.6.14) */
BUILTIN(regexp_symbol_split) {
    UNUSED_ARGS;
    JSValue rx = this_val;
    if (!js_is_object(rx)) return throw_incompatible(ctx, "@@split", rx);
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    RegExpObject *re = unmodified(ctx, rx);
    JSValue limit = ARG(1);
    if (re && !(lre_get_flags(re->bytecode) & (LRE_FLAG_STICKY | LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) &&
        (js_is_undefined(limit) || js_is_number(limit)) && flags_unmodified(ctx) && species_unmodified(ctx))
        return split_unmodified(ctx, re, s, js_is_undefined(limit) ? UINT32_MAX : (uint32_t)js_double_to_int32(js_as_number(limit)));
    JSValue c = species_constructor(ctx, rx);
    if (js_is_exception(c)) return c;
    JSValue flags = js_get_value(ctx, rx, JS_ATOM(flags));
    JSValue f = js_is_exception(flags) ? flags : js_to_string(ctx, flags);
    if (js_is_exception(f)) return f;
    bool unicode = has_unit(ctx, f, 'u') || has_unit(ctx, f, 'v');
    if (!has_unit(ctx, f, 'y')) {
        f = js_concat(ctx, f, js_char_string('y'));
        if (js_is_exception(f)) return f;
    }
    JSValue args[2] = { rx, f };
    JSValue splitter = js_construct(ctx, c, 2, args, c, NULL);
    if (js_is_exception(splitter)) return splitter;
    JSValue a = js_new_array(ctx, 0);
    uint32_t lim = UINT32_MAX;
    if (!js_is_undefined(ARG(1))) {
        double d;
        if (js_to_number(ctx, &d, ARG(1)) < 0) return JS_EXCEPTION;
        lim = (uint32_t)js_double_to_int32(d);
    }
    if (lim == 0) return a;
    uint32_t size = js_string_length(s);
    if (size == 0) {
        JSValue z = regexp_exec(ctx, splitter, s);
        if (js_is_exception(z)) return z;
        if (!js_is_null(z)) return a;
        return js_array_push(ctx, js_as_object(a), s) < 0 ? JS_EXCEPTION : a;
    }
    uint32_t p = 0;
    double q = 0;
    while (q < size) {
        if (set_last_index(ctx, splitter, q) < 0) return JS_EXCEPTION;
        JSValue z = regexp_exec(ctx, splitter, s);
        if (js_is_exception(z)) return z;
        if (js_is_null(z)) {
            q = advance_index(ctx, s, q, unicode);
            continue;
        }
        double e;
        if (js_is_exception(get_last_index(ctx, splitter, &e))) return JS_EXCEPTION;
        if (e > size) e = size;
        if (e == p) {
            q = advance_index(ctx, s, q, unicode);
            continue;
        }
        JSValue sub = js_substring(ctx, s, p, (uint32_t)q);
        if (js_is_exception(sub) || js_array_push(ctx, js_as_object(a), sub) < 0) return JS_EXCEPTION;
        if (js_array_length(js_as_object(a)) == lim) return a;
        p = (uint32_t)e;
        double captures;
        if (js_length_of_array_like(ctx, z, &captures) < 0) return JS_EXCEPTION;
        for (double i = 1; i < captures; i++) {
            JSValue cap = js_get_value(ctx, z, js_index_key_of(ctx, i));
            if (js_is_exception(cap) || js_array_push(ctx, js_as_object(a), cap) < 0) return JS_EXCEPTION;
            if (js_array_length(js_as_object(a)) == lim) return a;
        }
        q = p;
    }
    JSValue tail = js_substring(ctx, s, p < size ? p : size, size);
    if (js_is_exception(tail) || js_array_push(ctx, js_as_object(a), tail) < 0) return JS_EXCEPTION;
    return a;
}

/* ---- util.inspect ------------------------------------------------------------------------- */

static JSValue regexp_inspect(JSContext *ctx, JSValue v) {
    RegExpObject *re = as_regexp(v);
    if (!re) return JS_EMPTY;
    JSValue source = escape_source(ctx, re->source);
    char f[9];
    size_t n = flags_string(lre_get_flags(re->bytecode), f);
    JSValue r = js_concat(ctx, js_char_string('/'), source);
    if (js_is_exception(r)) return r;
    r = js_concat(ctx, r, js_char_string('/'));
    if (js_is_exception(r)) return r;
    return js_concat(ctx, r, js_new_string_latin1(ctx, (const uint8_t *)f, (uint32_t)n));
}

/* ---- Realm --------------------------------------------------------------------------------- */

static const JSBuiltin regexp_statics[] = {
    JS_BUILTIN_FN("escape", regexp_escape, 1),
    JS_BUILTIN_SYMBOL_GETTER(species, regexp_species),
};

static const JSBuiltin regexp_proto[] = {  /* V8's order */
    JS_BUILTIN_FN("exec", regexp_proto_exec, 1),
    JS_BUILTIN_GETTER("dotAll", regexp_dot_all),
    JS_BUILTIN_GETTER("flags", regexp_flags),
    JS_BUILTIN_GETTER("global", regexp_global),
    JS_BUILTIN_GETTER("hasIndices", regexp_has_indices),
    JS_BUILTIN_GETTER("ignoreCase", regexp_ignore_case),
    JS_BUILTIN_GETTER("multiline", regexp_multiline),
    JS_BUILTIN_GETTER("source", regexp_source),
    JS_BUILTIN_GETTER("sticky", regexp_sticky),
    JS_BUILTIN_GETTER("unicode", regexp_unicode),
    JS_BUILTIN_GETTER("unicodeSets", regexp_unicode_sets),
    JS_BUILTIN_FN("compile", regexp_compile, 2),
    JS_BUILTIN_FN("toString", regexp_to_string, 0),
    JS_BUILTIN_FN("test", regexp_test, 1),
    JS_BUILTIN_SYMBOL_FN(match, regexp_symbol_match, 1),
    JS_BUILTIN_SYMBOL_FN(matchAll, regexp_symbol_match_all, 1),
    JS_BUILTIN_SYMBOL_FN(replace, regexp_symbol_replace, 2),
    JS_BUILTIN_SYMBOL_FN(search, regexp_symbol_search, 1),
    JS_BUILTIN_SYMBOL_FN(split, regexp_symbol_split, 2),
};

static const JSBuiltin regexp_string_iterator_proto[] = {
    JS_BUILTIN_FN("next", regexp_string_iterator_next, 0),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "RegExp String Iterator", JS_PROP_CONFIGURABLE),
};

static void install_regexp(JSContext *ctx, JSObject *global) {
    for (uint32_t c = 0; c < 0x100; c++) {  /* the same in every realm */
        canonical[0][c] = (uint32_t)lre_canonicalize(c, 0);
        canonical[1][c] = (uint32_t)lre_canonicalize(c, 1);
    }
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 8);
    ctx->intrinsics[JS_INTRINSIC_REGEXP_PROTOTYPE] = proto;
    JSValue key = js_atom_from_cstr(ctx, "RegExp");
    JSValue c = js_new_native(ctx, regexp_ctor, key, 2, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_builtins(ctx, js_as_object(c), regexp_statics, JS_COUNTOF(regexp_statics));
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), regexp_proto, JS_COUNTOF(regexp_proto));
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
    ctx->intrinsics[JS_INTRINSIC_REGEXP] = c;
    ctx->intrinsics[JS_INTRINSIC_REGEXP_EXEC] = js_get_value(ctx, proto, JS_ATOM(exec));
    JSValue it = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_ITERATOR_PROTOTYPE], 2);
    js_define_builtins(ctx, js_as_object(it), regexp_string_iterator_proto, JS_COUNTOF(regexp_string_iterator_proto));
    ctx->intrinsics[JS_INTRINSIC_REGEXP_STRING_ITERATOR_PROTOTYPE] = it;
    ctx->rt->regexp_inspect = regexp_inspect;
}

const JSComponent js_component_regexp = { "regexp", install_regexp };
