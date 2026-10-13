/* JSON (§25.5): an optional component, and the serializer util.format's %j uses.
 *
 * JSON.parse follows V8's parser closely enough to give its error messages: the same checks in
 * the same order, at the same positions ("Unexpected token '}', "[1,}" is not valid JSON",
 * "Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)"). It is
 * iterative, so nesting depth is bounded by memory, as in V8. With a reviver it keeps a parse
 * node per value, for the reviver's `context` argument (JSON.parse source text access, in
 * Node 22): a primitive's source text, while the value is unchanged.
 *
 * JSON.stringify is the spec's SerializeJSONProperty; a cycle's TypeError describes the
 * cycle as V8 does. JSON.rawJSON / isRawJSON are here too. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_symbol.h"
#include "jsnum.h"

/* ---- A growable UTF-16 buffer ------------------------------------------------------------- */

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

static void put_unit(Builder *b, uint32_t u) {
    reserve(b, 1);
    b->units[b->length++] = (uint16_t)u;
}

static void put_ascii(Builder *b, const char *s) {
    while (*s) put_unit(b, (uint8_t)*s++);
}

static void put_view(Builder *b, JSStrView v, uint32_t start, uint32_t end) {
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

/* ---- JSON.parse (§25.5.1) ----------------------------------------------------------------- */

typedef enum {
    TOK_STRING, TOK_NUMBER, TOK_LBRACE, TOK_RBRACE, TOK_LBRACK, TOK_RBRACK, TOK_TRUE, TOK_FALSE,
    TOK_NULL, TOK_COLON, TOK_COMMA, TOK_WHITESPACE, TOK_ILLEGAL, TOK_EOS,
} Token;

/* V8's one_char_json_tokens */
static Token token_of(uint32_t c) {
    switch (c) {
    case '"': return TOK_STRING;
    case '-': case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
        return TOK_NUMBER;
    case '{': return TOK_LBRACE;
    case '}': return TOK_RBRACE;
    case '[': return TOK_LBRACK;
    case ']': return TOK_RBRACK;
    case 't': return TOK_TRUE;
    case 'f': return TOK_FALSE;
    case 'n': return TOK_NULL;
    case ':': return TOK_COLON;
    case ',': return TOK_COMMA;
    case ' ': case '\t': case '\n': case '\r': return TOK_WHITESPACE;
    default: return TOK_ILLEGAL;
    }
}

typedef struct {
    JSContext *ctx;
    JSValue    source;      /* the string being parsed (rooted: the parser lives on the C stack) */
    JSStrView  s;
    uint32_t   pos;
    bool       failed;
} Parser;

static bool at_end(Parser *p) { return p->pos >= p->s.length; }
static uint32_t cur(Parser *p) { return at_end(p) ? 0xFFFFFFFFu : js_view_at(p->s, p->pos); }
static uint32_t next_char(Parser *p) {
    p->pos++;
    return cur(p);
}
static Token peek(Parser *p) { return at_end(p) ? TOK_EOS : token_of(cur(p)); }

static void skip_whitespace(Parser *p) {
    while (!at_end(p) && token_of(cur(p)) == TOK_WHITESPACE) p->pos++;
}

typedef enum {
    MSG_NONE, MSG_PROP_NAME_OR_RBRACE, MSG_COMMA_OR_RBRACK, MSG_COMMA_OR_RBRACE, MSG_COLON,
    MSG_DOUBLE_QUOTED_NAME, MSG_EXPONENT, MSG_UNTERMINATED_STRING, MSG_CONTROL, MSG_ESCAPE,
    MSG_UNICODE_ESCAPE, MSG_MINUS, MSG_FRACTION, MSG_NON_WHITESPACE, MSG_NUMBER, MSG_STRING,
} Msg;

static const char *msg_text(Msg m) {
    switch (m) {
    case MSG_PROP_NAME_OR_RBRACE: return "Expected property name or '}' in JSON";
    case MSG_COMMA_OR_RBRACK: return "Expected ',' or ']' after array element in JSON";
    case MSG_COMMA_OR_RBRACE: return "Expected ',' or '}' after property value in JSON";
    case MSG_COLON: return "Expected ':' after property name in JSON";
    case MSG_DOUBLE_QUOTED_NAME: return "Expected double-quoted property name in JSON";
    case MSG_EXPONENT: return "Exponent part is missing a number in JSON";
    case MSG_UNTERMINATED_STRING: return "Unterminated string in JSON";
    case MSG_CONTROL: return "Bad control character in string literal in JSON";
    case MSG_ESCAPE: return "Bad escaped character in JSON";
    case MSG_UNICODE_ESCAPE: return "Bad Unicode escape in JSON";
    case MSG_MINUS: return "No number after minus sign in JSON";
    case MSG_FRACTION: return "Unterminated fractional number in JSON";
    case MSG_NON_WHITESPACE: return "Unexpected non-whitespace character after JSON";
    case MSG_NUMBER: return "Unexpected number in JSON";
    case MSG_STRING: return "Unexpected string in JSON";
    case MSG_NONE: break;
    }
    return "";
}

static bool source_is(Parser *p, const char *text) {
    size_t n = strlen(text);
    if (p->s.length != n) return false;
    for (uint32_t i = 0; i < n; i++)
        if (js_view_at(p->s, i) != (uint8_t)text[i]) return false;
    return true;
}

#define CONTEXT_CHARS 10  /* V8's kMaxContextCharacters */

/* ReportUnexpectedToken: the SyntaxError V8 throws for `token` at the current position, with
 * `msg` if given, else the token's own message. */
static void report(Parser *p, Token token, Msg msg) {
    if (p->failed) return;
    p->failed = true;
    JSContext *ctx = p->ctx;
    uint32_t pos = p->pos;
    Builder b = { 0 };
    if (msg == MSG_NONE) {
        if (token == TOK_EOS) {
            put_ascii(&b, "Unexpected end of JSON input");
            goto throw;
        }
        if (token == TOK_NUMBER) msg = MSG_NUMBER;
        else if (token == TOK_STRING) msg = MSG_STRING;
    }
    if (msg == MSG_NONE) {
        if (source_is(p, "[object Object]") || source_is(p, "undefined") || source_is(p, "Infinity") || source_is(p, "NaN")) {
            put_unit(&b, '"');
            put_view(&b, p->s, 0, p->s.length);
            put_ascii(&b, "\" is not valid JSON");
            goto throw;
        }
        put_ascii(&b, "Unexpected token '");
        put_unit(&b, cur(p));
        put_ascii(&b, "', ");
        uint32_t len = p->s.length;
        if (len < 2 * CONTEXT_CHARS + 1) {
            put_unit(&b, '"');
            put_view(&b, p->s, 0, len);
            put_ascii(&b, "\" is not valid JSON");
        } else if (pos < CONTEXT_CHARS) {
            put_unit(&b, '"');
            put_view(&b, p->s, 0, pos + CONTEXT_CHARS);
            put_ascii(&b, "\"... is not valid JSON");
        } else if (pos < len - CONTEXT_CHARS) {
            put_ascii(&b, "...\"");
            put_view(&b, p->s, pos - CONTEXT_CHARS, pos + CONTEXT_CHARS);
            put_ascii(&b, "\"... is not valid JSON");
        } else {
            put_ascii(&b, "...\"");
            put_view(&b, p->s, pos - CONTEXT_CHARS, len);
            put_ascii(&b, "\" is not valid JSON");
        }
        goto throw;
    }
    /* "… in JSON at position 4 (line 1 column 5)": \r\n is one line break */
    uint32_t line = 1, line_start = 0;
    for (uint32_t i = 0; i < pos && i < p->s.length; i++) {
        uint32_t c = js_view_at(p->s, i);
        if (c == '\r' && i + 1 < pos && js_view_at(p->s, i + 1) == '\n') i++;
        if (c == '\r' || c == '\n') {
            line++;
            line_start = i + 1;
        }
    }
    char where[96];
    snprintf(where, sizeof where, " at position %u (line %u column %u)", pos, line, pos - line_start + 1);
    put_ascii(&b, msg_text(msg));
    put_ascii(&b, where);
throw:;
    JSValue text = finish(ctx, &b);
    if (js_is_exception(text)) return;
    js_discard(js_throw(ctx, js_new_error(ctx, JS_SYNTAX_ERROR, text)));
}

/* ReportUnexpectedCharacter */
static void report_char(Parser *p, uint32_t c) {
    report(p, c == 0xFFFFFFFFu ? TOK_EOS : token_of(c), MSG_NONE);
}

/* ScanLiteral: "true", "false", "null" (the first character matched already). */
static JSValue scan_literal(Parser *p, const char *text, JSValue value) {
    size_t n = strlen(text);
    uint32_t remaining = p->s.length - p->pos;
    uint32_t i = 1;
    for (; i < n && i < remaining; i++) {
        if (js_view_at(p->s, p->pos + i) != (uint8_t)text[i]) {
            p->pos += i;
            report_char(p, cur(p));
            return JS_EXCEPTION;
        }
    }
    p->pos += i;
    if (i < n) {
        report(p, TOK_EOS, MSG_NONE);
        return JS_EXCEPTION;
    }
    return value;
}

static bool is_digit(uint32_t c) { return c >= '0' && c <= '9'; }

static void skip_digits(Parser *p) {
    while (is_digit(cur(p))) p->pos++;
}

/* ParseJsonNumber */
static JSValue scan_number(Parser *p) {
    uint32_t start = p->pos;
    uint32_t c = cur(p);
    if (c == '-') c = next_char(p);
    if (c == '0') {
        c = next_char(p);
        if (is_digit(c)) {
            report(p, TOK_NUMBER, MSG_NONE);
            return JS_EXCEPTION;
        }
    } else {
        if (!is_digit(c)) {
            report(p, TOK_ILLEGAL, MSG_MINUS);
            return JS_EXCEPTION;
        }
        skip_digits(p);
    }
    if (cur(p) == '.') {
        if (!is_digit(next_char(p))) {
            report(p, TOK_ILLEGAL, MSG_FRACTION);
            return JS_EXCEPTION;
        }
        skip_digits(p);
    }
    if (cur(p) == 'e' || cur(p) == 'E') {
        c = next_char(p);
        if (c == '-' || c == '+') c = next_char(p);
        if (!is_digit(c)) {
            report(p, TOK_ILLEGAL, MSG_EXPONENT);
            return JS_EXCEPTION;
        }
        skip_digits(p);
    }
    char buf[64];
    uint32_t n = p->pos - start;
    if (n < sizeof buf) {
        for (uint32_t i = 0; i < n; i++) buf[i] = (char)js_view_at(p->s, start + i);
        buf[n] = '\0';
        return js_number(strtod(buf, NULL));
    }
    char *big = malloc(n + 1);
    if (!big) js_fatal("out of memory parsing JSON");
    for (uint32_t i = 0; i < n; i++) big[i] = (char)js_view_at(p->s, start + i);
    big[n] = '\0';
    double d = strtod(big, NULL);
    free(big);
    return js_number(d);
}

static int hex_value(uint32_t c) {
    if (c >= '0' && c <= '9') return (int)(c - '0');
    if (c >= 'a' && c <= 'f') return (int)(c - 'a' + 10);
    if (c >= 'A' && c <= 'F') return (int)(c - 'A' + 10);
    return -1;
}

/* ScanJsonString: at the opening quote. */
static JSValue scan_string(Parser *p) {
    uint32_t start = ++p->pos;
    /* the common case: no escapes, a substring */
    for (;;) {
        if (at_end(p)) {
            report(p, TOK_ILLEGAL, MSG_UNTERMINATED_STRING);
            return JS_EXCEPTION;
        }
        uint32_t c = cur(p);
        if (c == '"') {
            JSValue s = js_substring(p->ctx, p->source, start, p->pos);
            p->pos++;
            return s;
        }
        if (c == '\\') break;
        if (c < 0x20) {
            report(p, TOK_ILLEGAL, MSG_CONTROL);
            return JS_EXCEPTION;
        }
        p->pos++;
    }
    Builder b = { 0 };
    put_view(&b, p->s, start, p->pos);
    for (;;) {
        if (at_end(p)) {
            free(b.units);
            report(p, TOK_ILLEGAL, MSG_UNTERMINATED_STRING);
            return JS_EXCEPTION;
        }
        uint32_t c = cur(p);
        if (c == '"') {
            p->pos++;
            return finish(p->ctx, &b);
        }
        if (c < 0x20) {
            free(b.units);
            report(p, TOK_ILLEGAL, MSG_CONTROL);
            return JS_EXCEPTION;
        }
        if (c != '\\') {
            put_unit(&b, c);
            p->pos++;
            continue;
        }
        c = next_char(p);
        if (c > 0xFF) {  /* the end, or past Latin-1: V8 reports the character itself */
            free(b.units);
            report_char(p, c);
            return JS_EXCEPTION;
        }
        uint32_t out;
        switch (c) {
        case '"': case '\\': case '/': out = c; break;
        case 'b': out = '\b'; break;
        case 'f': out = '\f'; break;
        case 'n': out = '\n'; break;
        case 'r': out = '\r'; break;
        case 't': out = '\t'; break;
        case 'u': {
            out = 0;
            for (int i = 0; i < 4; i++) {
                int d = hex_value(next_char(p));
                if (d < 0) {
                    free(b.units);
                    report(p, TOK_ILLEGAL, MSG_UNICODE_ESCAPE);
                    return JS_EXCEPTION;
                }
                out = out * 16 + (uint32_t)d;
            }
            break;
        }
        default:
            free(b.units);
            report(p, TOK_ILLEGAL, MSG_ESCAPE);
            return JS_EXCEPTION;
        }
        put_unit(&b, out);
        p->pos++;
    }
}

/* Parse nodes, kept only with a reviver: a primitive's node is [value, source]; an object's
 * or array's is [container, children], children an object (by key) or an array (by index). */
static JSValue primitive_node(JSContext *ctx, Parser *p, JSValue v, uint32_t start) {
    JSValue src = js_substring(ctx, p->source, start, p->pos);
    JSValue pair[2] = { v, src };
    return js_new_array_from(ctx, pair, 2);
}

static JSValue container_node(JSContext *ctx, JSValue container) {
    JSValue children = js_is_array(container) ? js_new_array(ctx, 0) : js_new_object_proto(ctx, JS_NULL, JS_DEFAULT_INLINE_SLOTS);
    JSValue pair[2] = { container, children };
    return js_new_array_from(ctx, pair, 2);
}

static JSValue node_part(JSContext *ctx, JSValue node, int i) {
    return js_get_value(ctx, node, js_int32(i));
}

/* ParseJsonValue, iteratively: `stack` holds each open container and its node, and an
 * object's pending key. *node_out gets the root's parse node when `nodes` is set. */
static JSValue parse_value(Parser *p, bool nodes, JSValue *node_out) {
    JSContext *ctx = p->ctx;
    JSValue stack = js_new_array(ctx, 0);  /* [container, key or undefined, node or undefined]… */
    JSValue v = JS_UNDEFINED, node = JS_UNDEFINED;
    for (;;) {
        /* a value */
        skip_whitespace(p);
        uint32_t start = p->pos;
        Token t = peek(p);
        switch (t) {
        case TOK_STRING: v = scan_string(p); break;
        case TOK_NUMBER: v = scan_number(p); break;
        case TOK_TRUE: v = scan_literal(p, "true", JS_TRUE); break;
        case TOK_FALSE: v = scan_literal(p, "false", JS_FALSE); break;
        case TOK_NULL: v = scan_literal(p, "null", JS_NULL); break;
        case TOK_LBRACE: {
            p->pos++;
            JSValue o = js_new_object(ctx);
            skip_whitespace(p);
            if (peek(p) == TOK_RBRACE) {
                p->pos++;
                v = o;
                break;
            }
            if (peek(p) != TOK_STRING) {
                report(p, peek(p), MSG_PROP_NAME_OR_RBRACE);
                return JS_EXCEPTION;
            }
            JSValue key = scan_string(p);
            if (js_is_exception(key)) return key;
            skip_whitespace(p);
            if (peek(p) != TOK_COLON) {
                report(p, peek(p), MSG_COLON);
                return JS_EXCEPTION;
            }
            p->pos++;
            JSValue entry[3] = { o, key, nodes ? container_node(ctx, o) : JS_UNDEFINED };
            for (int i = 0; i < 3; i++)
                if (js_array_push(ctx, js_as_object(stack), entry[i]) < 0) return JS_EXCEPTION;
            continue;
        }
        case TOK_LBRACK: {
            p->pos++;
            JSValue a = js_new_array(ctx, 0);
            skip_whitespace(p);
            if (peek(p) == TOK_RBRACK) {
                p->pos++;
                v = a;
                break;
            }
            JSValue entry[3] = { a, JS_UNDEFINED, nodes ? container_node(ctx, a) : JS_UNDEFINED };
            for (int i = 0; i < 3; i++)
                if (js_array_push(ctx, js_as_object(stack), entry[i]) < 0) return JS_EXCEPTION;
            continue;
        }
        default:
            report(p, t, MSG_NONE);
            return JS_EXCEPTION;
        }
        if (js_is_exception(v)) return v;
        if (nodes) node = js_is_object(v) ? container_node(ctx, v) : primitive_node(ctx, p, v, start);

        /* close the containers this value completes */
        for (;;) {
            uint32_t depth = js_array_length(js_as_object(stack));
            if (depth == 0) {
                if (nodes) *node_out = node;
                return v;
            }
            JSValue container = js_get_value(ctx, stack, js_int32((int32_t)depth - 3));
            JSValue cnode = js_get_value(ctx, stack, js_int32((int32_t)depth - 1));
            skip_whitespace(p);
            if (js_is_array(container)) {
                if (js_array_push(ctx, js_as_object(container), v) < 0) return JS_EXCEPTION;
                if (nodes && js_array_push(ctx, js_as_object(node_part(ctx, cnode, 1)), node) < 0) return JS_EXCEPTION;
                if (peek(p) == TOK_COMMA) {
                    p->pos++;
                    break;
                }
                if (peek(p) != TOK_RBRACK) {
                    report(p, peek(p), MSG_COMMA_OR_RBRACK);
                    return JS_EXCEPTION;
                }
            } else {
                JSValue key = js_to_property_key(ctx, js_get_value(ctx, stack, js_int32((int32_t)depth - 2)));
                if (js_is_exception(key) || js_create_data_property(ctx, container, key, v) < 0) return JS_EXCEPTION;
                if (nodes && js_create_data_property(ctx, node_part(ctx, cnode, 1), key, node) < 0) return JS_EXCEPTION;
                if (peek(p) == TOK_COMMA) {
                    p->pos++;
                    skip_whitespace(p);
                    if (peek(p) != TOK_STRING) {
                        report(p, peek(p), MSG_DOUBLE_QUOTED_NAME);
                        return JS_EXCEPTION;
                    }
                    JSValue next = scan_string(p);
                    if (js_is_exception(next)) return next;
                    skip_whitespace(p);
                    if (peek(p) != TOK_COLON) {
                        report(p, peek(p), MSG_COLON);
                        return JS_EXCEPTION;
                    }
                    p->pos++;
                    if (js_set_value(ctx, stack, js_int32((int32_t)depth - 2), next, true) < 0) return JS_EXCEPTION;
                    break;
                }
                if (peek(p) != TOK_RBRACE) {
                    report(p, peek(p), MSG_COMMA_OR_RBRACE);
                    return JS_EXCEPTION;
                }
            }
            p->pos++;  /* the closing bracket */
            v = container;
            node = cnode;
            JSPropertyDescriptor len = js_data_descriptor(js_int32((int32_t)depth - 3), JS_PROP_WRITABLE);
            if (js_define_own_property(ctx, js_as_object(stack), JS_ATOM(length), &len, true) < 0) return JS_EXCEPTION;
        }
    }
}

/* InternalizeJSONProperty (§25.5.1.1, with the source text proposal's context). */
static JSValue internalize(JSContext *ctx, JSValue holder, JSValue name, JSValue reviver, JSValue node) {
    JS_CHECK_STACK(ctx);
    JSValue pname = js_to_property_key(ctx, name);
    if (js_is_exception(pname)) return pname;
    JSValue val = js_get_value(ctx, holder, pname);
    if (js_is_exception(val)) return val;
    JSValue children = JS_UNDEFINED;
    if (js_is_array(node) && js_is_object(val) && js_same_bits(node_part(ctx, node, 0), val)) children = node_part(ctx, node, 1);
    if (js_is_object(val)) {
        int is_array = js_is_array_spec(ctx, val);
        if (is_array < 0) return JS_EXCEPTION;
        if (is_array) {
            double len;
            if (js_length_of_array_like(ctx, val, &len) < 0) return JS_EXCEPTION;
            for (double i = 0; i < len; i++) {
                JSValue key = js_to_string(ctx, js_number(i));
                if (js_is_exception(key)) return key;
                JSValue child = js_is_array(children) && i < js_array_length(js_as_object(children)) ? js_get_value(ctx, children, js_number(i)) : JS_UNDEFINED;
                JSValue e = internalize(ctx, val, key, reviver, child);
                if (js_is_exception(e)) return e;
                JSValue k = js_index_key_of(ctx, i);
                if (js_is_undefined(e)) {
                    if (js_delete_property(ctx, js_as_object(val), k, false) < 0) return JS_EXCEPTION;
                } else if (js_create_data_property(ctx, val, k, e) < 0) {
                    js_discard(js_take_exception(ctx));  /* CreateDataProperty: a failure is ignored */
                }
            }
        } else {
            JSValue keys = js_get_own_enumerable_string_keys(ctx, val);
            if (js_is_exception(keys)) return keys;
            uint32_t n = js_array_length(js_as_object(keys));
            for (uint32_t i = 0; i < n; i++) {
                JSValue key = js_get_value(ctx, keys, js_int32((int32_t)i));
                JSValue pkey = js_to_property_key(ctx, key);
                if (js_is_exception(pkey)) return pkey;
                JSValue child = JS_UNDEFINED;
                if (js_is_object(children)) {
                    JSPropertyDescriptor d;
                    if (js_get_own_property(ctx, js_as_object(children), pkey, &d) == 1) child = d.value;
                }
                JSValue e = internalize(ctx, val, key, reviver, child);
                if (js_is_exception(e)) return e;
                if (js_is_undefined(e)) {
                    if (js_delete_property(ctx, js_as_object(val), pkey, false) < 0) return JS_EXCEPTION;
                } else if (js_create_data_property(ctx, val, pkey, e) < 0) {
                    js_discard(js_take_exception(ctx));
                }
            }
        }
    }
    JSValue context = js_new_object(ctx);
    if (js_is_array(node) && !js_is_object(val)) {
        JSValue parsed = node_part(ctx, node, 0);
        if (!js_is_object(parsed) && js_same_value(ctx, parsed, val) &&
            js_create_data_property(ctx, context, js_atom_from_cstr(ctx, "source"), node_part(ctx, node, 1)) < 0)
            return JS_EXCEPTION;
    }
    JSValue args[3] = { name, val, context };
    return js_call(ctx, reviver, holder, 3, args);
}

static JSValue json_parse(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    JSValue text = js_to_string(ctx, ARG(0));
    if (js_is_exception(text)) return text;
    Parser p = { ctx, text, js_string_view(ctx, text), 0, false };
    bool revive = js_is_callable(ARG(1));
    JSValue node = JS_UNDEFINED;
    JSValue v = parse_value(&p, revive, &node);
    if (js_is_exception(v)) return v;
    skip_whitespace(&p);
    if (!at_end(&p)) {
        report(&p, peek(&p), MSG_NON_WHITESPACE);
        return JS_EXCEPTION;
    }
    if (!revive) return v;
    JSValue root = js_new_object(ctx);
    if (js_create_data_property(ctx, root, js_empty_string(), v) < 0) return JS_EXCEPTION;
    return internalize(ctx, root, js_empty_string(), ARG(1), node);
}

JSValue js_json_parse(JSContext *ctx, JSValue text) { return json_parse(ctx, JS_UNDEFINED, JS_UNDEFINED, 1, &text, JS_UNDEFINED); }

/* ---- JSON.rawJSON / isRawJSON ------------------------------------------------------------- */

static const JSClass raw_json_class = { "RawJSON", sizeof(JSObject), NULL, NULL, NULL, NULL, NULL, NULL, NULL };

static bool is_raw_json(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &raw_json_class;
}

static JSValue json_raw_json(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    JSValue text = js_to_string(ctx, ARG(0));
    if (js_is_exception(text)) return text;
    Parser p = { ctx, text, js_string_view(ctx, text), 0, false };
    if (at_end(&p)) return js_throw_syntax_error(ctx, "Invalid value for JSON.rawJSON");
    JSValue v;
    switch (peek(&p)) {  /* ParseRawJson: one primitive, nothing around it */
    case TOK_STRING: v = scan_string(&p); break;
    case TOK_NUMBER: v = scan_number(&p); break;
    case TOK_TRUE: v = scan_literal(&p, "true", JS_TRUE); break;
    case TOK_FALSE: v = scan_literal(&p, "false", JS_FALSE); break;
    case TOK_NULL: v = scan_literal(&p, "null", JS_NULL); break;
    default:
        report_char(&p, cur(&p));
        return JS_EXCEPTION;
    }
    if (js_is_exception(v)) return v;
    if (!at_end(&p)) return js_throw_syntax_error(ctx, "Invalid value for JSON.rawJSON");
    JSShape *shape = js_shape_root(ctx, &raw_json_class, JS_NULL, 1);
    JSObject *o = js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    js_define_data(ctx, o, js_atom_from_cstr(ctx, "rawJSON"), text, JS_PROP_DEFAULT);
    if (js_freeze(ctx, o) < 0) return JS_EXCEPTION;
    return js_object_value(o);
}

static JSValue json_is_raw_json(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    return js_bool(is_raw_json(ARG(0)));
}

/* ---- JSON.stringify (§25.5.2) --------------------------------------------------------------- */

typedef struct {
    JSContext *ctx;
    Builder    b;
    JSValue    replacer;       /* a function, or undefined */
    JSValue    property_list;  /* an array of strings, or undefined */
    JSValue    gap;            /* a string, maybe empty */
    JSValue    stack;          /* [key, object]…: the objects being serialized, for cycles */
    uint32_t   depth;          /* indentation = gap × depth */
} Stringifier;

static void put_json_string(Builder *b, JSStrView s) {
    put_unit(b, '"');
    for (uint32_t i = 0; i < s.length; i++) {
        uint32_t c = js_view_at(s, i);
        switch (c) {
        case '"': put_ascii(b, "\\\""); continue;
        case '\\': put_ascii(b, "\\\\"); continue;
        case '\b': put_ascii(b, "\\b"); continue;
        case '\f': put_ascii(b, "\\f"); continue;
        case '\n': put_ascii(b, "\\n"); continue;
        case '\r': put_ascii(b, "\\r"); continue;
        case '\t': put_ascii(b, "\\t"); continue;
        }
        bool lone = false;
        if (c >= 0xD800 && c <= 0xDFFF) {
            uint32_t d = i + 1 < s.length ? js_view_at(s, i + 1) : 0;
            if (c <= 0xDBFF && d >= 0xDC00 && d <= 0xDFFF) {
                put_unit(b, c);
                put_unit(b, d);
                i++;
                continue;
            }
            lone = true;  /* well-formed JSON.stringify (ES2019) */
        }
        if (c < 0x20 || lone) {
            char esc[8];
            snprintf(esc, sizeof esc, "\\u%04x", c);
            put_ascii(b, esc);
        } else {
            put_unit(b, c);
        }
    }
    put_unit(b, '"');
}

static void put_indent(Stringifier *st) {
    put_unit(&st->b, '\n');
    for (uint32_t i = 0; i < st->depth; i++) put_string(&st->b, st->ctx, st->gap);
}

/* V8's JSReceiver::GetConstructorName, without side effects: a @@toStringTag string, or the
 * name of a `constructor` on the prototype chain, else the kind of object. */
static void put_constructor_name(Builder *b, JSContext *ctx, JSValue obj) {
    bool self = true;
    for (JSValue o = obj; js_is_object(o); o = js_get_prototype_of(js_as_object(o)), self = false) {
        JSPropertyDescriptor d;
        if (js_get_own_property(ctx, js_as_object(o), JS_SYMBOL(toStringTag), &d) == 1 && (d.has & JS_DESC_VALUE) && js_is_string(d.value)) {
            put_string(b, ctx, d.value);
            return;
        }
        if (self) continue;
        if (js_get_own_property(ctx, js_as_object(o), JS_ATOM(constructor), &d) == 1 && (d.has & JS_DESC_VALUE) && js_is_function(d.value)) {
            JSPropertyDescriptor n;
            if (js_get_own_property(ctx, js_as_object(d.value), JS_ATOM(name), &n) == 1 && (n.has & JS_DESC_VALUE) && js_is_string(n.value) &&
                js_string_length(n.value) != 0 && !js_string_equals(ctx, n.value, js_atom_from_cstr(ctx, "Object"))) {
                put_string(b, ctx, n.value);
                return;
            }
        }
    }
    if (js_is_array(obj)) put_ascii(b, "Array");
    else if (js_is_function(obj)) put_ascii(b, "Function");
    else if (js_is_error(obj)) put_ascii(b, "Error");
    else put_ascii(b, "Object");
}

static void put_cycle_key(Builder *b, JSContext *ctx, JSValue key) {
    if (js_is_number(key)) {
        char buf[32];
        snprintf(buf, sizeof buf, "index %.0f", js_as_number(key));
        put_ascii(b, buf);
    } else if (js_string_length(key) == 0) {
        put_ascii(b, "<anonymous>");
    } else {
        put_ascii(b, "property '");
        put_string(b, ctx, key);
        put_unit(b, '\'');
    }
}

/* V8's ConstructCircularStructureErrorMessage: the cycle from the object seen again, at most two
 * lines after the start and one before the end, "..." for the rest. */
static JSValue throw_circular(Stringifier *st, uint32_t start, JSValue closing_key) {
    JSContext *ctx = st->ctx;
    uint32_t n = js_array_length(js_as_object(st->stack)) / 2;
    Builder b = { 0 };
    put_ascii(&b, "Converting circular structure to JSON\n    --> starting at object with constructor '");
    put_constructor_name(&b, ctx, js_get_value(ctx, st->stack, js_int32((int32_t)(2 * start + 1))));
    put_unit(&b, '\'');
    uint32_t index = start + 1;
    uint32_t prefix_end = index + 2 < n ? index + 2 : n;
    for (int part = 0; part < 2; part++) {
        for (; index < prefix_end; index++) {
            put_ascii(&b, "\n    |     ");
            put_cycle_key(&b, ctx, js_get_value(ctx, st->stack, js_int32((int32_t)(2 * index))));
            put_ascii(&b, " -> object with constructor '");
            put_constructor_name(&b, ctx, js_get_value(ctx, st->stack, js_int32((int32_t)(2 * index + 1))));
            put_unit(&b, '\'');
        }
        if (part == 0) {
            if (n > index + 1) put_ascii(&b, "\n    |     ...");
            if (index < n - 1) index = n - 1;
            prefix_end = n;
        }
    }
    put_ascii(&b, "\n    --- ");
    put_cycle_key(&b, ctx, closing_key);
    put_ascii(&b, " closes the circle");
    JSValue text = finish(ctx, &b);
    if (js_is_exception(text)) return text;
    return js_throw(ctx, js_new_error(ctx, JS_TYPE_ERROR, text));
}

enum { SER_OK = 0, SER_UNDEFINED = 1, SER_ERROR = -1 };

static int serialize_property(Stringifier *st, JSValue key, JSValue holder, JSValue cycle_key);

/* A cycle check, then [key, value] onto the stack. */
static int enter(Stringifier *st, JSValue value, JSValue cycle_key) {
    JSContext *ctx = st->ctx;
    uint32_t n = js_array_length(js_as_object(st->stack));
    for (uint32_t i = 1; i < n; i += 2)
        if (js_same_bits(js_get_value(ctx, st->stack, js_int32((int32_t)i)), value)) {
            js_discard(throw_circular(st, i / 2, cycle_key));
            return SER_ERROR;
        }
    if (js_array_push(ctx, js_as_object(st->stack), cycle_key) < 0 || js_array_push(ctx, js_as_object(st->stack), value) < 0) return SER_ERROR;
    st->depth++;
    return SER_OK;
}

static int leave(Stringifier *st) {
    st->depth--;
    uint32_t n = js_array_length(js_as_object(st->stack));
    JSPropertyDescriptor len = js_data_descriptor(js_int32((int32_t)n - 2), JS_PROP_WRITABLE);
    return js_define_own_property(st->ctx, js_as_object(st->stack), JS_ATOM(length), &len, true) < 0 ? SER_ERROR : SER_OK;
}

/* SerializeJSONObject (§25.5.2.5) */
static int serialize_object(Stringifier *st, JSValue value, JSValue cycle_key) {
    JSContext *ctx = st->ctx;
    if (enter(st, value, cycle_key) < 0) return SER_ERROR;
    JSValue keys = st->property_list;
    if (js_is_undefined(keys)) keys = js_get_own_enumerable_string_keys(ctx, value);
    if (js_is_exception(keys)) return SER_ERROR;
    uint32_t n = js_array_length(js_as_object(keys));
    bool gap = js_string_length(st->gap) != 0;
    bool any = false;
    put_unit(&st->b, '{');
    for (uint32_t i = 0; i < n; i++) {
        JSValue key = js_get_value(ctx, keys, js_int32((int32_t)i));
        if (js_is_exception(key)) return SER_ERROR;
        size_t mark = st->b.length;
        if (any) put_unit(&st->b, ',');
        if (gap) put_indent(st);
        put_json_string(&st->b, js_string_view(ctx, key));
        put_unit(&st->b, ':');
        if (gap) put_unit(&st->b, ' ');
        int r = serialize_property(st, key, value, key);
        if (r == SER_ERROR) return SER_ERROR;
        if (r == SER_UNDEFINED) st->b.length = mark;
        else any = true;
    }
    if (leave(st) < 0) return SER_ERROR;
    if (any && gap) put_indent(st);
    put_unit(&st->b, '}');
    return SER_OK;
}

/* SerializeJSONArray (§25.5.2.6) */
static int serialize_array(Stringifier *st, JSValue value, JSValue cycle_key) {
    JSContext *ctx = st->ctx;
    if (enter(st, value, cycle_key) < 0) return SER_ERROR;
    double len;
    if (js_length_of_array_like(ctx, value, &len) < 0) return SER_ERROR;
    bool gap = js_string_length(st->gap) != 0;
    put_unit(&st->b, '[');
    for (double i = 0; i < len; i++) {
        if (i > 0) put_unit(&st->b, ',');
        if (gap) put_indent(st);
        JSValue key = js_to_string(ctx, js_number(i));
        if (js_is_exception(key)) return SER_ERROR;
        int r = serialize_property(st, key, value, js_number(i));
        if (r == SER_ERROR) return SER_ERROR;
        if (r == SER_UNDEFINED) put_ascii(&st->b, "null");
    }
    if (leave(st) < 0) return SER_ERROR;
    if (len > 0 && gap) put_indent(st);
    put_unit(&st->b, ']');
    return SER_OK;
}

/* SerializeJSONProperty (§25.5.2.2): the value of holder[key], appended. `cycle_key` is how a
 * cycle's message names the key (an array index is a number). */
static int serialize_property(Stringifier *st, JSValue key, JSValue holder, JSValue cycle_key) {
    JSContext *ctx = st->ctx;
    if (JS_FRAME_ADDRESS() < ctx->stack_limit) {
        js_discard(js_throw_stack_overflow(ctx));
        return SER_ERROR;
    }
    JSValue pkey = js_to_property_key(ctx, key);
    if (js_is_exception(pkey)) return SER_ERROR;
    JSValue value = js_get_value(ctx, holder, pkey);
    if (js_is_exception(value)) return SER_ERROR;
    if (js_is_object(value) || js_is_bigint(value)) {
        JSValue to_json = js_get_value(ctx, value, js_atom_from_cstr(ctx, "toJSON"));
        if (js_is_exception(to_json)) return SER_ERROR;
        if (js_is_callable(to_json)) {
            value = js_call(ctx, to_json, value, 1, &key);
            if (js_is_exception(value)) return SER_ERROR;
        }
    }
    if (!js_is_undefined(st->replacer)) {
        JSValue args[2] = { key, value };
        value = js_call(ctx, st->replacer, holder, 2, args);
        if (js_is_exception(value)) return SER_ERROR;
    }
    if (js_is_wrapper(value)) {  /* [[NumberData]], [[StringData]], [[BooleanData]] */
        JSValue prim = js_wrapped_value(value);
        if (js_is_number(prim)) {
            double d;
            if (js_to_number(ctx, &d, value) < 0) return SER_ERROR;
            value = js_number(d);
        } else if (js_is_string(prim)) {
            value = js_to_string(ctx, value);
            if (js_is_exception(value)) return SER_ERROR;
        } else if (js_is_bool(prim) || js_is_bigint(prim)) {
            value = prim;
        }
    }
    if (js_is_bigint(value)) {
        js_discard(js_throw_type_error(ctx, "Do not know how to serialize a BigInt"));
        return SER_ERROR;
    }
    if (is_raw_json(value)) {
        JSValue raw = js_get_value(ctx, value, js_atom_from_cstr(ctx, "rawJSON"));
        if (js_is_exception(raw)) return SER_ERROR;
        put_string(&st->b, ctx, raw);
        return SER_OK;
    }
    if (js_is_null(value)) put_ascii(&st->b, "null");
    else if (js_is_bool(value)) put_ascii(&st->b, js_as_bool(value) ? "true" : "false");
    else if (js_is_string(value)) put_json_string(&st->b, js_string_view(ctx, value));
    else if (js_is_number(value)) {
        double d = js_as_number(value);
        if (!isfinite(d)) {
            put_ascii(&st->b, "null");
        } else {
            char buf[64];
            js_num_to_cstr(buf, d);
            put_ascii(&st->b, buf);
        }
    } else if (js_is_object(value) && !js_is_callable(value)) {
        int is_array = js_is_array_spec(st->ctx, value);
        if (is_array < 0) return SER_ERROR;
        return is_array ? serialize_array(st, value, cycle_key) : serialize_object(st, value, cycle_key);
    } else {
        return SER_UNDEFINED;  /* undefined, symbols, functions */
    }
    return SER_OK;
}

JSValue js_json_stringify(JSContext *ctx, JSValue value, JSValue replacer, JSValue space, bool *circular) {
    Stringifier st = { ctx, { 0 }, JS_UNDEFINED, JS_UNDEFINED, js_empty_string(), js_new_array(ctx, 0), 0 };
    if (circular) *circular = false;
    int replacer_is_array = js_is_callable(replacer) ? 0 : js_is_array_spec(ctx, replacer);
    if (replacer_is_array < 0) return JS_EXCEPTION;
    if (js_is_callable(replacer)) {
        st.replacer = replacer;
    } else if (replacer_is_array) {  /* the property list: strings and numbers, once each */
        double len;
        if (js_length_of_array_like(ctx, replacer, &len) < 0) return JS_EXCEPTION;
        JSValue list = js_new_array(ctx, 0);
        JSValue seen = js_new_object_proto(ctx, JS_NULL, JS_DEFAULT_INLINE_SLOTS);
        for (double i = 0; i < len; i++) {
            JSValue v = js_get_value(ctx, replacer, js_index_key_of(ctx, i));
            if (js_is_exception(v)) return v;
            JSValue item = JS_UNDEFINED;
            if (js_is_string(v)) item = v;
            else if (js_is_number(v) || (js_is_wrapper(v) && (js_is_string(js_wrapped_value(v)) || js_is_number(js_wrapped_value(v))))) {
                item = js_to_string(ctx, v);
                if (js_is_exception(item)) return item;
            }
            if (js_is_undefined(item)) continue;
            JSValue k = js_to_property_key(ctx, item);
            if (js_is_exception(k)) return k;
            JSPropertyDescriptor d;
            if (js_get_own_property(ctx, js_as_object(seen), k, &d) == 1) continue;
            js_define_data(ctx, js_as_object(seen), k, JS_TRUE, JS_PROP_DEFAULT);
            if (js_array_push(ctx, js_as_object(list), item) < 0) return JS_EXCEPTION;
        }
        st.property_list = list;
    }
    if (js_is_wrapper(space)) {
        JSValue prim = js_wrapped_value(space);
        if (js_is_number(prim)) {
            double d;
            if (js_to_number(ctx, &d, space) < 0) return JS_EXCEPTION;
            space = js_number(d);
        } else if (js_is_string(prim)) {
            space = js_to_string(ctx, space);
            if (js_is_exception(space)) return space;
        }
    }
    if (js_is_number(space)) {
        double n;
        if (js_to_integer_or_infinity(ctx, &n, space) < 0) return JS_EXCEPTION;
        if (n > 10) n = 10;
        static const char spaces[] = "          ";
        st.gap = n >= 1 ? js_new_string_latin1(ctx, (const uint8_t *)spaces, (uint32_t)n) : js_empty_string();
    } else if (js_is_string(space)) {
        uint32_t n = js_string_length(space);
        st.gap = n > 10 ? js_substring(ctx, space, 0, 10) : space;
    }
    JSValue wrapper = js_new_object(ctx);
    if (js_create_data_property(ctx, wrapper, js_empty_string(), value) < 0) return JS_EXCEPTION;
    int r = serialize_property(&st, js_empty_string(), wrapper, js_empty_string());
    if (r == SER_ERROR) {
        free(st.b.units);
        if (circular) {
            /* tryStringify's check: a TypeError whose first line is the cycle message */
            JSValue e = js_take_exception(ctx);
            JSValue msg = js_is_error(e) ? js_get_value(ctx, e, JS_ATOM(message)) : JS_UNDEFINED;
            if (js_is_exception(msg)) msg = JS_UNDEFINED;
            static const char head[] = "Converting circular structure to JSON";
            if (js_is_string(msg)) {
                JSStrView m = js_string_view(ctx, msg);
                bool match = m.length >= sizeof head - 1 && (m.length == sizeof head - 1 || js_view_at(m, sizeof head - 1) == '\n');
                for (uint32_t i = 0; match && i < sizeof head - 1; i++) match = js_view_at(m, i) == (uint8_t)head[i];
                *circular = match && js_get_prototype_of(js_as_object(e)).bits == ctx->intrinsics[JS_INTRINSIC_TYPE_ERROR_PROTOTYPE].bits;
            }
            js_discard(js_throw(ctx, e));
        }
        return JS_EXCEPTION;
    }
    if (r == SER_UNDEFINED) {
        free(st.b.units);
        return JS_UNDEFINED;
    }
    return finish(ctx, &st.b);
}

static JSValue json_stringify(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    return js_json_stringify(ctx, ARG(0), ARG(1), ARG(2), NULL);
}

/* ---- The component ------------------------------------------------------------------------ */

static const JSBuiltin json_entries[] = {
    JS_BUILTIN_FN("parse", json_parse, 2),
    JS_BUILTIN_FN("stringify", json_stringify, 3),
    JS_BUILTIN_FN("rawJSON", json_raw_json, 1),
    JS_BUILTIN_FN("isRawJSON", json_is_raw_json, 1),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "JSON", JS_PROP_CONFIGURABLE),
};

static void install_json(JSContext *ctx, JSObject *global) {
    JSValue json = js_new_builtin_object(ctx, json_entries, JS_COUNTOF(json_entries));
    js_define_data(ctx, global, js_atom_from_cstr(ctx, "JSON"), json, JS_BUILTIN_METHOD_ATTRS);
}

const JSComponent js_component_json = { "json", install_json };
