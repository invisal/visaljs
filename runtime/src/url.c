/* URL and URLSearchParams (WHATWG URL), the url component, which needs nothing else.
 * The basic URL parser is the standard's state machine, in C, on code points; hosts go
 * through IDNA as Ada does it (runtime/third_party/ada-idna), so results match Node's, whose
 * URL is Ada (4.0.0 in Node v24). A record keeps each component serialized (ASCII): a
 * non-opaque path is its serialization, "/a/b", whose segments are what the slashes delimit.
 * The API is Node's: its errors, its inspection, and URLSearchParams' iteration. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "idna.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_console.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

/* ---- Buffers -------------------------------------------------------------------------------- */

typedef struct {  /* ASCII bytes, NUL-terminated when cap > 0 */
    char  *v;
    size_t n, cap;
} Buf;

typedef struct {  /* code points */
    uint32_t *v;
    size_t    n, cap;
} CPs;

static void *grow(void *p, size_t *cap, size_t need, size_t size) {
    if (need <= *cap) return p;
    size_t c = *cap ? *cap : 16;
    while (c < need) c *= 2;
    void *q = realloc(p, c * size);
    if (!q) js_fatal("out of memory in URL");
    *cap = c;
    return q;
}

/* memrchr and strncasecmp aren't standard C */
static const char *last_slash(const char *s, size_t n) {
    while (n-- > 0)
        if (s[n] == '/') return s + n;
    return NULL;
}

static const char *last_dot(const char *s, size_t n) {
    while (n-- > 0)
        if (s[n] == '.') return s + n;
    return NULL;
}

static bool ascii_ieq(const char *a, const char *b, size_t n) {
    for (size_t i = 0; i < n; i++) {
        char x = a[i] >= 'A' && a[i] <= 'Z' ? (char)(a[i] + 32) : a[i];
        if (x != b[i]) return false;
    }
    return true;
}

static void buf_push(Buf *b, char c) {
    b->v = grow(b->v, &b->cap, b->n + 2, 1);
    b->v[b->n++] = c;
    b->v[b->n] = '\0';
}

static void buf_append(Buf *b, const char *s, size_t n) {
    b->v = grow(b->v, &b->cap, b->n + n + 1, 1);
    memcpy(b->v + b->n, s, n);
    b->n += n;
    b->v[b->n] = '\0';
}

static void buf_cstr(Buf *b, const char *s) { buf_append(b, s, strlen(s)); }
static void buf_clear(Buf *b) { b->n = 0; if (b->cap) b->v[0] = '\0'; }
static void buf_set(Buf *b, const char *s, size_t n) { buf_clear(b); buf_append(b, s, n); }
static void buf_copy(Buf *dst, const Buf *src) { buf_set(dst, src->v ? src->v : "", src->n); }
static bool buf_eq(const Buf *b, const char *s) { return b->n == strlen(s) && (b->n == 0 || memcmp(b->v, s, b->n) == 0); }

static void cps_push(CPs *b, uint32_t c) {
    b->v = grow(b->v, &b->cap, b->n + 1, sizeof *b->v);
    b->v[b->n++] = c;
}

/* A string's code points, lone surrogates as U+FFFD (a USVString). */
static void cps_of(JSContext *ctx, JSValue s, CPs *out) {
    JSStrView v = js_string_view(ctx, s);
    out->n = 0;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length) {
            uint32_t d = js_view_at(v, i + 1);
            if (d >= 0xDC00 && d <= 0xDFFF) {
                cps_push(out, 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00));
                i++;
                continue;
            }
        }
        cps_push(out, c >= 0xD800 && c <= 0xDFFF ? 0xFFFD : c);
    }
}

/* ---- Percent-encoding (URL §1.3) ------------------------------------------------------------ */

enum { SET_C0, SET_FRAGMENT, SET_QUERY, SET_SPECIAL_QUERY, SET_PATH, SET_USERINFO, SET_COMPONENT, SET_FORM };

static bool in_set(int set, uint32_t c) {
    if (c < 0x20 || c > 0x7E) return true;
    switch (set) {
    case SET_FORM:
        if (c == '!' || c == '\'' || c == '(' || c == ')' || c == '~') return true;
        /* fallthrough */
    case SET_COMPONENT:
        if (c == '$' || c == '%' || c == '&' || c == '+' || c == ',') return true;
        /* fallthrough */
    case SET_USERINFO:
        if (c == '/' || c == ':' || c == ';' || c == '=' || c == '@' || (c >= '[' && c <= '^') || c == '|') return true;
        /* fallthrough */
    case SET_PATH:
        if (c == '?' || c == '^' || c == '`' || c == '{' || c == '}') return true;
        /* fallthrough */
    case SET_QUERY:
        return c == ' ' || c == '"' || c == '#' || c == '<' || c == '>';
    case SET_SPECIAL_QUERY:
        return c == ' ' || c == '"' || c == '#' || c == '<' || c == '>' || c == '\'';
    case SET_FRAGMENT:
        return c == ' ' || c == '"' || c == '<' || c == '>' || c == '`';
    default:
        return false;
    }
}

static const char HEX[] = "0123456789ABCDEF";

static void put_byte_escaped(Buf *b, uint8_t byte) {
    char e[3] = { '%', HEX[byte >> 4], HEX[byte & 15] };
    buf_append(b, e, 3);
}

static int utf8_encode(uint32_t c, uint8_t out[4]) {
    if (c < 0x80) {
        out[0] = (uint8_t)c;
        return 1;
    }
    if (c < 0x800) {
        out[0] = (uint8_t)(0xC0 | (c >> 6));
        out[1] = (uint8_t)(0x80 | (c & 0x3F));
        return 2;
    }
    if (c < 0x10000) {
        out[0] = (uint8_t)(0xE0 | (c >> 12));
        out[1] = (uint8_t)(0x80 | ((c >> 6) & 0x3F));
        out[2] = (uint8_t)(0x80 | (c & 0x3F));
        return 3;
    }
    out[0] = (uint8_t)(0xF0 | (c >> 18));
    out[1] = (uint8_t)(0x80 | ((c >> 12) & 0x3F));
    out[2] = (uint8_t)(0x80 | ((c >> 6) & 0x3F));
    out[3] = (uint8_t)(0x80 | (c & 0x3F));
    return 4;
}

/* UTF-8 percent-encode a code point with a set. */
static void put_encoded(Buf *b, uint32_t c, int set) {
    if (!in_set(set, c)) {
        buf_push(b, (char)c);
        return;
    }
    uint8_t bytes[4];
    int n = utf8_encode(c, bytes);
    for (int i = 0; i < n; i++) put_byte_escaped(b, bytes[i]);
}

static int hex_value(uint32_t c) {
    if (c >= '0' && c <= '9') return (int)(c - '0');
    if (c >= 'a' && c <= 'f') return (int)(c - 'a' + 10);
    if (c >= 'A' && c <= 'F') return (int)(c - 'A' + 10);
    return -1;
}

/* Percent-decode bytes (URL §1.3). */
static void percent_decode(const uint8_t *in, size_t n, Buf *out) {
    for (size_t i = 0; i < n; i++) {
        int h, l;
        if (in[i] == '%' && i + 2 < n && (h = hex_value(in[i + 1])) >= 0 && (l = hex_value(in[i + 2])) >= 0) {
            buf_push(out, (char)(h * 16 + l));
            i += 2;
        } else {
            buf_push(out, (char)in[i]);
        }
    }
}

/* UTF-8 decode without BOM (Encoding §4.1): invalid sequences become U+FFFD, the WHATWG way. */
static void utf8_decode(const uint8_t *p, size_t n, CPs *out) {
    uint32_t cp = 0;
    unsigned needed = 0, seen = 0;
    uint8_t lower = 0x80, upper = 0xBF;
    for (size_t i = 0; i < n;) {
        uint8_t b = p[i];
        if (needed == 0) {
            i++;
            if (b <= 0x7F) cps_push(out, b);
            else if (b >= 0xC2 && b <= 0xDF) needed = 1, cp = b & 0x1F;
            else if (b >= 0xE0 && b <= 0xEF) {
                if (b == 0xE0) lower = 0xA0;
                if (b == 0xED) upper = 0x9F;
                needed = 2, cp = b & 0xF;
            } else if (b >= 0xF0 && b <= 0xF4) {
                if (b == 0xF0) lower = 0x90;
                if (b == 0xF4) upper = 0x8F;
                needed = 3, cp = b & 7;
            } else cps_push(out, 0xFFFD);
            continue;
        }
        if (b < lower || b > upper) {
            needed = seen = 0, cp = 0, lower = 0x80, upper = 0xBF;
            cps_push(out, 0xFFFD);
            continue;
        }
        i++;
        lower = 0x80, upper = 0xBF;
        cp = cp << 6 | (b & 0x3F);
        if (++seen == needed) {
            cps_push(out, cp);
            needed = seen = 0, cp = 0;
        }
    }
    if (needed) cps_push(out, 0xFFFD);
}

/* ---- URL records ---------------------------------------------------------------------------- */

typedef struct URLRecord {
    Buf     scheme, username, password, host, path, query, fragment;
    bool    has_host, opaque_path, has_query, has_fragment;
    int32_t port;  /* -1: null */
} URLRecord;

static void record_free(URLRecord *u) {
    free(u->scheme.v), free(u->username.v), free(u->password.v), free(u->host.v);
    free(u->path.v), free(u->query.v), free(u->fragment.v);
    memset(u, 0, sizeof *u);
}

static int special_port(const Buf *scheme) {  /* -1: not special; 0: file (no default port) */
    if (buf_eq(scheme, "http") || buf_eq(scheme, "ws")) return 80;
    if (buf_eq(scheme, "https") || buf_eq(scheme, "wss")) return 443;
    if (buf_eq(scheme, "ftp")) return 21;
    if (buf_eq(scheme, "file")) return 0;
    return -1;
}

static bool is_special(const URLRecord *u) { return special_port(&u->scheme) >= 0; }
static bool includes_credentials(const URLRecord *u) { return u->username.n || u->password.n; }
static bool cannot_have_credentials(const URLRecord *u) { return !u->has_host || u->host.n == 0 || buf_eq(&u->scheme, "file"); }

static bool is_alpha(uint32_t c) { return (c | 32) >= 'a' && (c | 32) <= 'z'; }
static bool is_digit(uint32_t c) { return c >= '0' && c <= '9'; }

/* A Windows drive letter: a letter then ':' or '|' (normalized: ':'). */
static bool is_drive_letter(const uint32_t *s, size_t n, bool normalized) {
    return n == 2 && is_alpha(s[0]) && (s[1] == ':' || (!normalized && s[1] == '|'));
}

/* Whether code points s[0…n) start with a Windows drive letter (URL §4.2). */
static bool starts_with_drive_letter(const uint32_t *s, size_t n) {
    return n >= 2 && is_drive_letter(s, 2, false) && (n == 2 || s[2] == '/' || s[2] == '\\' || s[2] == '?' || s[2] == '#');
}

static size_t segment_count(const Buf *path) {
    size_t n = 0;
    for (size_t i = 0; i < path->n; i++) n += path->v[i] == '/';
    return n;
}

/* The first segment is a normalized Windows drive letter ("/c:…"). */
static bool first_segment_is_drive(const Buf *path) {
    return path->n >= 3 && path->v[0] == '/' && is_alpha((uint8_t)path->v[1]) && path->v[2] == ':' && (path->n == 3 || path->v[3] == '/');
}

/* Shorten a URL's path (URL §4.1). */
static void shorten_path(URLRecord *u) {
    if (buf_eq(&u->scheme, "file") && segment_count(&u->path) == 1 && first_segment_is_drive(&u->path)) return;
    const char *last = u->path.n ? last_slash(u->path.v, u->path.n) : NULL;
    if (last) {
        u->path.n = (size_t)(last - u->path.v);
        u->path.v[u->path.n] = '\0';
    }
}

/* Potentially strip trailing spaces from an opaque path (URL §4.1), once nothing follows it. */
static void strip_trailing_spaces(URLRecord *u) {
    if (!u->opaque_path || u->has_fragment || u->has_query) return;
    while (u->path.n && u->path.v[u->path.n - 1] == ' ') u->path.v[--u->path.n] = '\0';
}

static void path_append(URLRecord *u, const char *segment, size_t n) {
    buf_push(&u->path, '/');
    buf_append(&u->path, segment, n);
}

/* ---- Hosts (URL §3) ------------------------------------------------------------------------- */

static bool forbidden_host(uint32_t c) {
    return c == 0 || c == '\t' || c == '\n' || c == '\r' || c == ' ' || c == '#' || c == '/' || c == ':' || c == '<' ||
           c == '>' || c == '?' || c == '@' || c == '[' || c == '\\' || c == ']' || c == '^' || c == '|';
}

static bool forbidden_domain(uint32_t c) { return forbidden_host(c) || c <= 0x1F || c == '%' || c == 0x7F; }

/* The IPv4 number parser (URL §3.5): -1 on failure, else the value (which may exceed 2^32). */
static double ipv4_number(const char *s, size_t n) {
    if (n == 0) return -1;
    int radix = 10;
    if (n >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) radix = 16, s += 2, n -= 2;
    else if (n >= 2 && s[0] == '0') radix = 8, s += 1, n -= 1;
    double v = 0;
    for (size_t i = 0; i < n; i++) {
        int d = hex_value((uint8_t)s[i]);
        if (d < 0 || d >= radix) return -1;
        v = v * radix + d;
    }
    return v;
}

/* The ends-in-a-number checker (URL §3.5). */
static bool ends_in_number(const char *s, size_t n) {
    if (n && s[n - 1] == '.') n--;  /* a last, empty part goes (with one part, the string is "") */
    const char *dot = n ? last_dot(s, n) : NULL;
    const char *last = dot ? dot + 1 : s;
    size_t len = (size_t)(s + n - last);
    if (len == 0) return false;
    bool digits = true;
    for (size_t i = 0; i < len && digits; i++) digits = is_digit((uint8_t)last[i]);
    return digits || ipv4_number(last, len) >= 0;
}

/* The IPv4 parser, serialized into out: false on failure. */
static bool parse_ipv4(const char *s, size_t n, Buf *out) {
    double numbers[4];
    size_t count = 0;
    if (n && s[n - 1] == '.' && n > 1) n--;  /* a trailing dot, when there is more than it */
    for (size_t start = 0;;) {
        const char *dot = memchr(s + start, '.', n - start);
        size_t end = dot ? (size_t)(dot - s) : n;
        if (count == 4) return false;
        double v = ipv4_number(s + start, end - start);
        if (v < 0) return false;
        numbers[count++] = v;
        if (!dot) break;
        start = end + 1;
    }
    for (size_t i = 0; i + 1 < count; i++)
        if (numbers[i] > 255) return false;
    double limit = 1;
    for (size_t i = 0; i < 5 - count; i++) limit *= 256;
    if (numbers[count - 1] >= limit) return false;
    double ipv4 = numbers[count - 1];
    for (size_t i = 0; i + 1 < count; i++) {
        double m = 1;
        for (size_t k = 0; k < 3 - i; k++) m *= 256;
        ipv4 += numbers[i] * m;
    }
    uint32_t a = (uint32_t)ipv4;
    char text[16];
    snprintf(text, sizeof text, "%u.%u.%u.%u", a >> 24, (a >> 16) & 255, (a >> 8) & 255, a & 255);
    buf_set(out, text, strlen(text));
    return true;
}

/* The IPv6 parser and serializer (URL §3.5, §3.6), into out with brackets: false on failure. */
static bool parse_ipv6(const uint32_t *in, size_t n, Buf *out) {
    uint16_t address[8] = { 0 };
    int piece = 0, compress = -1;
    size_t p = 0;
#define C (p < n ? in[p] : 0xFFFFFFFFu)
    if (C == ':') {
        if (p + 1 >= n || in[p + 1] != ':') return false;
        p += 2;
        compress = ++piece;
    }
    while (C != 0xFFFFFFFFu) {
        if (piece == 8) return false;
        if (C == ':') {
            if (compress != -1) return false;
            p++;
            compress = ++piece;
            continue;
        }
        unsigned value = 0, length = 0;
        while (length < 4 && hex_value(C) >= 0) {
            value = value * 16 + (unsigned)hex_value(C);
            p++, length++;
        }
        if (C == '.') {
            if (length == 0) return false;
            p -= length;
            if (piece > 6) return false;
            int numbers_seen = 0;
            while (C != 0xFFFFFFFFu) {
                int ipv4_piece = -1;
                if (numbers_seen > 0) {
                    if (C == '.' && numbers_seen < 4) p++;
                    else return false;
                }
                if (!is_digit(C)) return false;
                while (is_digit(C)) {
                    int number = (int)(C - '0');
                    if (ipv4_piece == -1) ipv4_piece = number;
                    else if (ipv4_piece == 0) return false;
                    else ipv4_piece = ipv4_piece * 10 + number;
                    if (ipv4_piece > 255) return false;
                    p++;
                }
                address[piece] = (uint16_t)(address[piece] * 0x100 + ipv4_piece);
                numbers_seen++;
                if (numbers_seen == 2 || numbers_seen == 4) piece++;
            }
            if (numbers_seen != 4) return false;
            break;
        } else if (C == ':') {
            p++;
            if (C == 0xFFFFFFFFu) return false;
        } else if (C != 0xFFFFFFFFu) {
            return false;
        }
        address[piece++] = (uint16_t)value;
    }
#undef C
    if (compress != -1) {
        int swaps = piece - compress;
        piece = 7;
        while (piece != 0 && swaps > 0) {
            uint16_t t = address[piece];
            address[piece] = address[compress + swaps - 1];
            address[compress + swaps - 1] = t;
            piece--, swaps--;
        }
    } else if (piece != 8) {
        return false;
    }
    /* serialize: compress the first longest run of two or more zero pieces */
    int best = -1, best_len = 1;
    for (int i = 0; i < 8;) {
        if (address[i] != 0) {
            i++;
            continue;
        }
        int j = i;
        while (j < 8 && address[j] == 0) j++;
        if (j - i > best_len) best = i, best_len = j - i;
        i = j;
    }
    buf_clear(out);
    buf_push(out, '[');
    bool ignore0 = false;
    for (int i = 0; i < 8; i++) {
        if (ignore0 && address[i] == 0) continue;
        ignore0 = false;
        if (best == i) {
            buf_cstr(out, i == 0 ? "::" : ":");
            ignore0 = true;
            continue;
        }
        char h[8];
        snprintf(h, sizeof h, "%x", address[i]);
        buf_cstr(out, h);
        if (i != 7) buf_push(out, ':');
    }
    buf_push(out, ']');
    return true;
}

/* The host parser (URL §3.5), into out: false on failure. */
static bool parse_host(const uint32_t *in, size_t n, bool not_special, Buf *out) {
    if (n && in[0] == '[') {
        if (in[n - 1] != ']') return false;
        return parse_ipv6(in + 1, n - 2, out);
    }
    if (not_special) {  /* an opaque host */
        for (size_t i = 0; i < n; i++)
            if (forbidden_host(in[i])) return false;
        buf_clear(out);
        for (size_t i = 0; i < n; i++) put_encoded(out, in[i], SET_C0);
        return true;
    }
    /* domain = UTF-8 decode without BOM of the percent-decoding of the UTF-8 encoding */
    Buf bytes = { 0 }, decoded = { 0 };
    for (size_t i = 0; i < n; i++) {
        uint8_t u[4];
        int k = utf8_encode(in[i], u);
        buf_append(&bytes, (const char *)u, (size_t)k);
    }
    percent_decode((const uint8_t *)(bytes.v ? bytes.v : ""), bytes.n, &decoded);
    free(bytes.v);
    CPs domain = { 0 };
    utf8_decode((const uint8_t *)(decoded.v ? decoded.v : ""), decoded.n, &domain);
    free(decoded.v);
    size_t len = 0;
    char *ascii = domain.n ? idna_to_ascii(domain.v, domain.n, &len) : NULL;
    free(domain.v);
    if (!ascii) return false;
    for (size_t i = 0; i < len; i++)
        if (forbidden_domain((uint8_t)ascii[i])) {
            free(ascii);
            return false;
        }
    bool ok = true;
    if (ends_in_number(ascii, len)) ok = parse_ipv4(ascii, len, out);
    else buf_set(out, ascii, len);
    free(ascii);
    return ok;
}

/* ---- The basic URL parser (URL §4.4) -------------------------------------------------------- */

typedef enum {
    ST_NONE, ST_SCHEME_START, ST_SCHEME, ST_NO_SCHEME, ST_SPECIAL_RELATIVE_OR_AUTHORITY, ST_PATH_OR_AUTHORITY,
    ST_RELATIVE, ST_RELATIVE_SLASH, ST_SPECIAL_AUTHORITY_SLASHES, ST_SPECIAL_AUTHORITY_IGNORE_SLASHES, ST_AUTHORITY,
    ST_HOST, ST_HOSTNAME, ST_PORT, ST_FILE, ST_FILE_SLASH, ST_FILE_HOST, ST_PATH_START, ST_PATH, ST_OPAQUE_PATH,
    ST_QUERY, ST_FRAGMENT,
} State;

#define END 0xFFFFFFFFu

static bool is_single_dot(const Buf *b) { return buf_eq(b, ".") || (b->n == 3 && ascii_ieq(b->v, "%2e", 3)); }

static bool is_double_dot(const Buf *b) {
    if (buf_eq(b, "..")) return true;
    if (b->n == 4) return ascii_ieq(b->v, ".%2e", 4) || ascii_ieq(b->v, "%2e.", 4);
    return b->n == 6 && ascii_ieq(b->v, "%2e%2e", 6);
}

/* Runs the parser on in[0…n) into url (fresh, or the URL to change under a state override):
 * false on failure. */
static bool basic_parse(const uint32_t *in, size_t n, const URLRecord *base, URLRecord *url, State override) {
    State state = override ? override : ST_SCHEME_START;
    CPs buffer = { 0 };
    Buf pbuf = { 0 };  /* the path state's buffer: already percent-encoded */
    bool at_sign_seen = false, inside_brackets = false, password_token_seen = false, ok = true;
#define FAIL() do { ok = false; goto done; } while (0)
#define RETURN() goto done
    for (ptrdiff_t p = 0;; p++) {
        uint32_t c = p < (ptrdiff_t)n ? in[p] : END;
        const uint32_t *rest = in + p + 1;  /* the remaining code points, after c */
        size_t rest_n = p < (ptrdiff_t)n ? n - (size_t)p - 1 : 0;
        switch (state) {
        case ST_SCHEME_START:
            if (is_alpha(c)) {
                cps_push(&buffer, c | 32);
                state = ST_SCHEME;
            } else if (!override) {
                state = ST_NO_SCHEME;
                p--;
            } else FAIL();
            break;
        case ST_SCHEME:
            if (is_alpha(c) || is_digit(c) || c == '+' || c == '-' || c == '.') {
                cps_push(&buffer, is_alpha(c) ? c | 32 : c);
            } else if (c == ':') {
                Buf scheme = { 0 };
                for (size_t i = 0; i < buffer.n; i++) buf_push(&scheme, (char)buffer.v[i]);
                if (override) {
                    bool new_special = special_port(&scheme) >= 0;
                    if (is_special(url) != new_special || ((includes_credentials(url) || url->port >= 0) && buf_eq(&scheme, "file")) ||
                        (buf_eq(&url->scheme, "file") && url->has_host && url->host.n == 0)) {
                        free(scheme.v);
                        RETURN();
                    }
                }
                buf_copy(&url->scheme, &scheme);
                free(scheme.v);
                if (override) {
                    if (url->port >= 0 && url->port == special_port(&url->scheme)) url->port = -1;
                    RETURN();
                }
                buffer.n = 0;
                if (buf_eq(&url->scheme, "file")) {
                    state = ST_FILE;
                } else if (is_special(url) && base && buf_eq(&base->scheme, url->scheme.v)) {
                    state = ST_SPECIAL_RELATIVE_OR_AUTHORITY;
                } else if (is_special(url)) {
                    state = ST_SPECIAL_AUTHORITY_SLASHES;
                } else if (rest_n && rest[0] == '/') {
                    state = ST_PATH_OR_AUTHORITY;
                    p++;
                } else {
                    url->opaque_path = true;
                    buf_clear(&url->path);
                    state = ST_OPAQUE_PATH;
                }
            } else if (!override) {
                buffer.n = 0;
                state = ST_NO_SCHEME;
                p = -1;
            } else FAIL();
            break;
        case ST_NO_SCHEME:
            if (!base || (base->opaque_path && c != '#')) FAIL();
            if (base->opaque_path && c == '#') {
                buf_copy(&url->scheme, &base->scheme);
                buf_copy(&url->path, &base->path);
                url->opaque_path = true;
                buf_copy(&url->query, &base->query);
                url->has_query = base->has_query;
                buf_clear(&url->fragment);
                url->has_fragment = true;
                state = ST_FRAGMENT;
            } else {
                state = buf_eq(&base->scheme, "file") ? ST_FILE : ST_RELATIVE;
                p--;
            }
            break;
        case ST_SPECIAL_RELATIVE_OR_AUTHORITY:
            if (c == '/' && rest_n && rest[0] == '/') {
                state = ST_SPECIAL_AUTHORITY_IGNORE_SLASHES;
                p++;
            } else {
                state = ST_RELATIVE;
                p--;
            }
            break;
        case ST_PATH_OR_AUTHORITY:
            if (c == '/') state = ST_AUTHORITY;
            else {
                state = ST_PATH;
                p--;
            }
            break;
        case ST_RELATIVE:
            buf_copy(&url->scheme, &base->scheme);
            if (c == '/' || (is_special(url) && c == '\\')) {
                state = ST_RELATIVE_SLASH;
            } else {
                buf_copy(&url->username, &base->username);
                buf_copy(&url->password, &base->password);
                buf_copy(&url->host, &base->host);
                url->has_host = base->has_host;
                url->port = base->port;
                buf_copy(&url->path, &base->path);
                buf_copy(&url->query, &base->query);
                url->has_query = base->has_query;
                if (c == '?') {
                    buf_clear(&url->query);
                    url->has_query = true;
                    state = ST_QUERY;
                } else if (c == '#') {
                    buf_clear(&url->fragment);
                    url->has_fragment = true;
                    state = ST_FRAGMENT;
                } else if (c != END) {
                    url->has_query = false;
                    buf_clear(&url->query);
                    shorten_path(url);
                    state = ST_PATH;
                    p--;
                }
            }
            break;
        case ST_RELATIVE_SLASH:
            if (is_special(url) && (c == '/' || c == '\\')) {
                state = ST_SPECIAL_AUTHORITY_IGNORE_SLASHES;
            } else if (c == '/') {
                state = ST_AUTHORITY;
            } else {
                buf_copy(&url->username, &base->username);
                buf_copy(&url->password, &base->password);
                buf_copy(&url->host, &base->host);
                url->has_host = base->has_host;
                url->port = base->port;
                state = ST_PATH;
                p--;
            }
            break;
        case ST_SPECIAL_AUTHORITY_SLASHES:
            state = ST_SPECIAL_AUTHORITY_IGNORE_SLASHES;
            if (c == '/' && rest_n && rest[0] == '/') p++;
            else p--;
            break;
        case ST_SPECIAL_AUTHORITY_IGNORE_SLASHES:
            if (c != '/' && c != '\\') {
                state = ST_AUTHORITY;
                p--;
            }
            break;
        case ST_AUTHORITY:
            if (c == '@') {
                if (at_sign_seen) {  /* the earlier @ is part of the credentials */
                    CPs prefixed = { 0 };
                    cps_push(&prefixed, '%'), cps_push(&prefixed, '4'), cps_push(&prefixed, '0');
                    for (size_t i = 0; i < buffer.n; i++) cps_push(&prefixed, buffer.v[i]);
                    free(buffer.v);
                    buffer = prefixed;
                }
                at_sign_seen = true;
                for (size_t i = 0; i < buffer.n; i++) {
                    if (buffer.v[i] == ':' && !password_token_seen) {
                        password_token_seen = true;
                        continue;
                    }
                    /* the "%40" prefix is already encoded: % is not in the userinfo set */
                    put_encoded(password_token_seen ? &url->password : &url->username, buffer.v[i], SET_USERINFO);
                }
                buffer.n = 0;
            } else if (c == END || c == '/' || c == '?' || c == '#' || (is_special(url) && c == '\\')) {
                if (at_sign_seen && buffer.n == 0) FAIL();
                p -= (ptrdiff_t)buffer.n + 1;
                buffer.n = 0;
                state = ST_HOST;
            } else {
                cps_push(&buffer, c);
            }
            break;
        case ST_HOST:
        case ST_HOSTNAME:
            if (override && buf_eq(&url->scheme, "file")) {
                p--;
                state = ST_FILE_HOST;
            } else if (c == ':' && !inside_brackets) {
                if (buffer.n == 0) FAIL();
                if (override == ST_HOSTNAME) FAIL();
                if (!parse_host(buffer.v, buffer.n, !is_special(url), &url->host)) FAIL();
                url->has_host = true;
                buffer.n = 0;
                state = ST_PORT;
            } else if (c == END || c == '/' || c == '?' || c == '#' || (is_special(url) && c == '\\')) {
                p--;
                if (is_special(url) && buffer.n == 0) FAIL();
                if (override && buffer.n == 0 && (includes_credentials(url) || url->port >= 0)) FAIL();
                if (!parse_host(buffer.v, buffer.n, !is_special(url), &url->host)) FAIL();
                url->has_host = true;
                buffer.n = 0;
                state = ST_PATH_START;
                if (override) RETURN();
            } else {
                if (c == '[') inside_brackets = true;
                if (c == ']') inside_brackets = false;
                cps_push(&buffer, c);
            }
            break;
        case ST_PORT:
            if (is_digit(c)) {
                cps_push(&buffer, c);
            } else if (c == END || c == '/' || c == '?' || c == '#' || (is_special(url) && c == '\\') || override) {
                if (buffer.n) {
                    double port = 0;
                    for (size_t i = 0; i < buffer.n; i++) {
                        port = port * 10 + (buffer.v[i] - '0');
                        if (port > 65535) FAIL();
                    }
                    url->port = (int)port == special_port(&url->scheme) ? -1 : (int32_t)port;
                    buffer.n = 0;
                }
                if (override) RETURN();
                state = ST_PATH_START;
                p--;
            } else FAIL();
            break;
        case ST_FILE:
            buf_set(&url->scheme, "file", 4);
            buf_clear(&url->host);
            url->has_host = true;
            if (c == '/' || c == '\\') {
                state = ST_FILE_SLASH;
            } else if (base && buf_eq(&base->scheme, "file")) {
                buf_copy(&url->host, &base->host);
                url->has_host = base->has_host;
                buf_copy(&url->path, &base->path);
                buf_copy(&url->query, &base->query);
                url->has_query = base->has_query;
                if (c == '?') {
                    buf_clear(&url->query);
                    url->has_query = true;
                    state = ST_QUERY;
                } else if (c == '#') {
                    buf_clear(&url->fragment);
                    url->has_fragment = true;
                    state = ST_FRAGMENT;
                } else if (c != END) {
                    url->has_query = false;
                    buf_clear(&url->query);
                    if (!starts_with_drive_letter(in + p, n - (size_t)p)) shorten_path(url);
                    else buf_clear(&url->path);
                    state = ST_PATH;
                    p--;
                }
            } else {
                state = ST_PATH;
                p--;
            }
            break;
        case ST_FILE_SLASH:
            if (c == '/' || c == '\\') {
                state = ST_FILE_HOST;
            } else {
                if (base && buf_eq(&base->scheme, "file")) {
                    buf_copy(&url->host, &base->host);
                    url->has_host = base->has_host;
                    if (!starts_with_drive_letter(in + p, p < (ptrdiff_t)n ? n - (size_t)p : 0) && first_segment_is_drive(&base->path))
                        path_append(url, base->path.v + 1, 2);
                }
                state = ST_PATH;
                p--;
            }
            break;
        case ST_FILE_HOST:
            if (c == END || c == '/' || c == '\\' || c == '?' || c == '#') {
                p--;
                if (!override && is_drive_letter(buffer.v, buffer.n, false)) {
                    state = ST_PATH;  /* the buffer stays, for the path state */
                    for (size_t i = 0; i < buffer.n; i++) put_encoded(&pbuf, buffer.v[i], SET_PATH);
                    buffer.n = 0;
                } else if (buffer.n == 0) {
                    buf_clear(&url->host);
                    url->has_host = true;
                    if (override) RETURN();
                    state = ST_PATH_START;
                } else {
                    if (!parse_host(buffer.v, buffer.n, !is_special(url), &url->host)) FAIL();
                    url->has_host = true;
                    if (buf_eq(&url->host, "localhost")) buf_clear(&url->host);
                    if (override) RETURN();
                    buffer.n = 0;
                    state = ST_PATH_START;
                }
            } else {
                cps_push(&buffer, c);
            }
            break;
        case ST_PATH_START:
            if (is_special(url)) {
                state = ST_PATH;
                if (c != '/' && c != '\\') p--;
            } else if (!override && c == '?') {
                buf_clear(&url->query);
                url->has_query = true;
                state = ST_QUERY;
            } else if (!override && c == '#') {
                buf_clear(&url->fragment);
                url->has_fragment = true;
                state = ST_FRAGMENT;
            } else if (c != END) {
                state = ST_PATH;
                if (c != '/') p--;
            } else if (override && !url->has_host) {
                path_append(url, "", 0);
            }
            break;
        case ST_PATH:
            if (c == END || c == '/' || (is_special(url) && c == '\\') || (!override && (c == '?' || c == '#'))) {
                bool slash = c == '/' || (is_special(url) && c == '\\');
                if (is_double_dot(&pbuf)) {
                    shorten_path(url);
                    if (!slash) path_append(url, "", 0);
                } else if (is_single_dot(&pbuf) && !slash) {
                    path_append(url, "", 0);
                } else if (!is_single_dot(&pbuf)) {
                    if (buf_eq(&url->scheme, "file") && url->path.n == 0 && pbuf.n == 2 && is_alpha((uint8_t)pbuf.v[0]) &&
                        (pbuf.v[1] == ':' || pbuf.v[1] == '|'))
                        pbuf.v[1] = ':';
                    path_append(url, pbuf.v ? pbuf.v : "", pbuf.n);
                }
                buf_clear(&pbuf);
                if (c == '?') {
                    buf_clear(&url->query);
                    url->has_query = true;
                    state = ST_QUERY;
                }
                if (c == '#') {
                    buf_clear(&url->fragment);
                    url->has_fragment = true;
                    state = ST_FRAGMENT;
                }
            } else {
                put_encoded(&pbuf, c, SET_PATH);
            }
            break;
        case ST_OPAQUE_PATH:
            /* a space just before the query or fragment: %20, so the path doesn't end in one */
            if ((c == '?' || c == '#') && url->path.n && url->path.v[url->path.n - 1] == ' ') {
                url->path.v[--url->path.n] = '\0';
                buf_append(&url->path, "%20", 3);
            }
            if (c == '?') {
                buf_clear(&url->query);
                url->has_query = true;
                state = ST_QUERY;
            } else if (c == '#') {
                buf_clear(&url->fragment);
                url->has_fragment = true;
                state = ST_FRAGMENT;
            } else if (c != END) {
                put_encoded(&url->path, c, SET_C0);
            }
            break;
        case ST_QUERY:
            if ((!override && c == '#') || c == END) {
                if (c == '#') {
                    buf_clear(&url->fragment);
                    url->has_fragment = true;
                    state = ST_FRAGMENT;
                }
            } else {
                put_encoded(&url->query, c, is_special(url) ? SET_SPECIAL_QUERY : SET_QUERY);
            }
            break;
        case ST_FRAGMENT:
            if (c != END) put_encoded(&url->fragment, c, SET_FRAGMENT);
            break;
        default:
            break;
        }
        if (p >= (ptrdiff_t)n) break;  /* the pointer points to the EOF code point */
    }
done:
#undef FAIL
#undef RETURN
    free(buffer.v);
    free(pbuf.v);
    return ok;
}

/* The URL serializer (URL §4.5). */
static void serialize(const URLRecord *u, Buf *out, bool exclude_fragment) {
    buf_clear(out);
    buf_append(out, u->scheme.v ? u->scheme.v : "", u->scheme.n);
    buf_push(out, ':');
    if (u->has_host) {
        buf_cstr(out, "//");
        if (includes_credentials(u)) {
            buf_append(out, u->username.v ? u->username.v : "", u->username.n);
            if (u->password.n) {
                buf_push(out, ':');
                buf_append(out, u->password.v, u->password.n);
            }
            buf_push(out, '@');
        }
        buf_append(out, u->host.v ? u->host.v : "", u->host.n);
        if (u->port >= 0) {
            char port[16];
            snprintf(port, sizeof port, ":%d", u->port);
            buf_cstr(out, port);
        }
    }
    if (!u->has_host && !u->opaque_path && u->path.n >= 2 && u->path.v[0] == '/' && u->path.v[1] == '/') buf_cstr(out, "/.");
    buf_append(out, u->path.v ? u->path.v : "", u->path.n);
    if (u->has_query) {
        buf_push(out, '?');
        buf_append(out, u->query.v ? u->query.v : "", u->query.n);
    }
    if (!exclude_fragment && u->has_fragment) {
        buf_push(out, '#');
        buf_append(out, u->fragment.v ? u->fragment.v : "", u->fragment.n);
    }
}

/* Parses a string (the API's entry: leading and trailing C0 controls and spaces trimmed, tabs
 * and newlines removed) into a fresh record: false on failure. */
static bool parse_string(JSContext *ctx, JSValue s, const URLRecord *base, URLRecord *out) {
    CPs cps = { 0 }, clean = { 0 };
    cps_of(ctx, s, &cps);
    size_t start = 0, end = cps.n;
    while (start < end && cps.v[start] <= 0x20) start++;
    while (end > start && cps.v[end - 1] <= 0x20) end--;
    for (size_t i = start; i < end; i++)
        if (cps.v[i] != '\t' && cps.v[i] != '\n' && cps.v[i] != '\r') cps_push(&clean, cps.v[i]);
    memset(out, 0, sizeof *out);
    out->port = -1;
    bool ok = basic_parse(clean.v, clean.n, base, out, ST_NONE);
    free(cps.v);
    free(clean.v);
    if (!ok) record_free(out);
    return ok;
}

/* Runs a setter's parse (tabs and newlines removed, no trimming) on u. */
static void parse_override(JSContext *ctx, const uint32_t *in, size_t n, URLRecord *u, State state) {
    (void)ctx;
    CPs clean = { 0 };
    for (size_t i = 0; i < n; i++)
        if (in[i] != '\t' && in[i] != '\n' && in[i] != '\r') cps_push(&clean, in[i]);
    basic_parse(clean.v, clean.n, NULL, u, state);  /* in place: a failure keeps what was set before it */
    free(clean.v);
}

/* ---- application/x-www-form-urlencoded (URL §5) --------------------------------------------- */

/* The serializer's encoding of one string. */
static void form_encode(JSContext *ctx, JSValue s, Buf *out) {
    CPs cps = { 0 };
    cps_of(ctx, s, &cps);
    for (size_t i = 0; i < cps.n; i++) {
        if (cps.v[i] == ' ') buf_push(out, '+');
        else put_encoded(out, cps.v[i], SET_FORM);
    }
    free(cps.v);
}

static JSValue new_string_from_bytes(JSContext *ctx, const uint8_t *p, size_t n) {
    CPs cps = { 0 };
    utf8_decode(p, n, &cps);
    uint16_t *units = malloc((cps.n * 2 + 1) * sizeof *units);
    if (!units) js_fatal("out of memory in URLSearchParams");
    size_t k = 0;
    for (size_t i = 0; i < cps.n; i++) {
        uint32_t c = cps.v[i];
        if (c > 0xFFFF) {
            c -= 0x10000;
            units[k++] = (uint16_t)(0xD800 + (c >> 10));
            units[k++] = (uint16_t)(0xDC00 + (c & 0x3FF));
        } else {
            units[k++] = (uint16_t)c;
        }
    }
    free(cps.v);
    JSValue r = js_new_string_utf16(ctx, units, (uint32_t)k);
    free(units);
    return r;
}

/* ---- The objects ---------------------------------------------------------------------------- */

typedef struct URLObject {
    JSObject   obj;
    URLRecord *rec;
    JSValue    search_params;  /* EMPTY until url.searchParams is read */
} URLObject;

typedef struct ParamsObject {
    JSObject obj;
    JSValue *list;  /* name, value, name, value, … (strings) */
    uint32_t n, cap;
    JSValue  url;   /* the URLObject, or undefined */
} ParamsObject;

typedef struct ParamsIterator {
    JSObject obj;
    JSValue  params;
    uint32_t index;  /* into the list */
    uint8_t  kind;   /* 0 keys, 1 values, 2 entries */
} ParamsIterator;

static void url_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((URLObject *)c)->search_params); }
static void url_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    URLObject *u = (URLObject *)c;
    if (u->rec) record_free(u->rec);
    free(u->rec);
}
static void params_visit(JSCell *c, JSTracer *trc) {
    ParamsObject *p = (ParamsObject *)c;
    for (uint32_t i = 0; i < p->n; i++) js_trace_value(trc, p->list[i]);
    js_trace_value(trc, p->url);
}
static void params_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    free(((ParamsObject *)c)->list);
}
static void iterator_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((ParamsIterator *)c)->params); }

static const JSClass url_class = { "URL", sizeof(URLObject), NULL, NULL, NULL, NULL, url_visit, url_finalize, NULL };
static const JSClass params_class = { "URLSearchParams", sizeof(ParamsObject), NULL, NULL, NULL, NULL, params_visit, params_finalize, NULL };
static const JSClass iterator_class = { "URLSearchParams Iterator", sizeof(ParamsIterator), NULL, NULL, NULL, NULL, iterator_visit, NULL, NULL };

static URLObject *as_url(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &url_class ? (URLObject *)js_as_object(v) : NULL;
}
static ParamsObject *as_params(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &params_class ? (ParamsObject *)js_as_object(v) : NULL;
}

#define THIS_URL()                       \
    URLObject *u = as_url(this_val);      \
    if (!u) return js_throw_type_error(ctx, "Receiver must be an instance of class URL")
#define THIS_PARAMS()                         \
    ParamsObject *sp = as_params(this_val);    \
    if (!sp) return js_throw_invalid_this(ctx, "URLSearchParams")

static JSValue buf_string(JSContext *ctx, const char *s, size_t n) { return js_new_string_latin1(ctx, (const uint8_t *)(s ? s : ""), (uint32_t)n); }

/* Appends a name/value pair to a params list. */
static void params_append(JSContext *ctx, ParamsObject *p, JSValue name, JSValue value) {
    if (p->n + 2 > p->cap) {
        size_t cap = p->cap;
        p->list = grow(p->list, &cap, p->n + 2, sizeof *p->list);
        p->cap = (uint32_t)cap;
    }
    js_store(ctx, &p->obj.cell, &p->list[p->n++], name);
    js_store(ctx, &p->obj.cell, &p->list[p->n++], value);
}

/* The application/x-www-form-urlencoded parser (URL §5.1) into a params list. */
static int params_parse(JSContext *ctx, ParamsObject *p, const uint8_t *in, size_t n) {
    p->n = 0;
    for (size_t start = 0; start <= n;) {
        const uint8_t *amp = memchr(in + start, '&', n - start);
        size_t end = amp ? (size_t)(amp - in) : n;
        if (end > start) {
            const uint8_t *eq = memchr(in + start, '=', end - start);
            size_t name_end = eq ? (size_t)(eq - in) : end;
            Buf name = { 0 }, value = { 0 }, raw = { 0 };
            buf_append(&raw, (const char *)in + start, name_end - start);
            for (size_t i = 0; i < raw.n; i++) if (raw.v[i] == '+') raw.v[i] = ' ';
            percent_decode((const uint8_t *)(raw.v ? raw.v : ""), raw.n, &name);
            buf_clear(&raw);
            if (eq) buf_append(&raw, (const char *)eq + 1, end - name_end - 1);
            for (size_t i = 0; i < raw.n; i++) if (raw.v[i] == '+') raw.v[i] = ' ';
            percent_decode((const uint8_t *)(raw.v ? raw.v : ""), raw.n, &value);
            free(raw.v);
            JSValue ns = new_string_from_bytes(ctx, (const uint8_t *)(name.v ? name.v : ""), name.n);
            JSValue vs = js_is_exception(ns) ? ns : new_string_from_bytes(ctx, (const uint8_t *)(value.v ? value.v : ""), value.n);
            free(name.v);
            free(value.v);
            if (js_is_exception(vs)) return -1;
            params_append(ctx, p, ns, vs);
        }
        if (!amp) break;
        start = end + 1;
    }
    return 0;
}

/* The serializer (URL §5.2). */
static void params_serialize(JSContext *ctx, const ParamsObject *p, Buf *out) {
    buf_clear(out);
    for (uint32_t i = 0; i < p->n; i += 2) {
        if (i) buf_push(out, '&');
        form_encode(ctx, p->list[i], out);
        buf_push(out, '=');
        form_encode(ctx, p->list[i + 1], out);
    }
}

/* The URL's query changed: its search params follow (if url.searchParams exists). */
static int refresh_params(JSContext *ctx, URLObject *u) {
    ParamsObject *p = as_params(u->search_params);
    if (!p) return 0;
    if (!u->rec->has_query) {
        p->n = 0;
        return 0;
    }
    return params_parse(ctx, p, (const uint8_t *)(u->rec->query.v ? u->rec->query.v : ""), u->rec->query.n);
}

/* The params changed (URLSearchParams' update steps): their URL's query follows. */
static void update_url(JSContext *ctx, ParamsObject *p) {
    URLObject *u = as_url(p->url);
    if (!u) return;
    Buf q = { 0 };
    params_serialize(ctx, p, &q);
    buf_set(&u->rec->query, q.v ? q.v : "", q.n);
    u->rec->has_query = q.n != 0;
    strip_trailing_spaces(u->rec);
    free(q.v);
}

/* ToString, with lone surrogates as U+FFFD (toUSVString). */
static JSValue to_usv(JSContext *ctx, JSValue v) {
    JSValue s = js_to_string(ctx, v);
    if (js_is_exception(s)) return s;
    JSStrView view = js_string_view(ctx, s);
    if (view.latin1) return s;
    bool lone = false;
    for (uint32_t i = 0; i < view.length && !lone; i++) {
        uint32_t c = js_view_at(view, i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            if (i + 1 < view.length && js_view_at(view, i + 1) >= 0xDC00 && js_view_at(view, i + 1) <= 0xDFFF) i++;
            else lone = true;
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
            lone = true;
        }
    }
    if (!lone) return s;
    uint16_t *units = malloc(view.length * sizeof *units);
    if (!units) js_fatal("out of memory");
    for (uint32_t i = 0; i < view.length; i++) {
        uint32_t c = js_view_at(view, i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < view.length && js_view_at(view, i + 1) >= 0xDC00 && js_view_at(view, i + 1) <= 0xDFFF) {
            units[i] = (uint16_t)c;
            units[i + 1] = (uint16_t)js_view_at(view, i + 1);
            i++;
        } else {
            units[i] = (uint16_t)(c >= 0xD800 && c <= 0xDFFF ? 0xFFFD : c);
        }
    }
    JSValue r = js_new_string_utf16(ctx, units, view.length);
    free(units);
    return r;
}

static JSValue new_params(JSContext *ctx, JSValue proto) {
    ParamsObject *p = (ParamsObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &params_class, proto, 0));
    p->list = NULL;
    p->n = p->cap = 0;
    js_init_slot(&p->url, JS_UNDEFINED);
    return js_object_value(&p->obj);
}

/* ---- URL ------------------------------------------------------------------------------------ */

static JSValue throw_invalid_url(JSContext *ctx, JSValue input, JSValue base) {
    JSValue e = js_new_error(ctx, JS_TYPE_ERROR, js_new_string_cstr(ctx, "Invalid URL"));
    js_define_data(ctx, js_as_object(e), js_atom_from_cstr(ctx, "code"), js_new_string_cstr(ctx, "ERR_INVALID_URL"),
                   JS_PROP_WRITABLE | JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, js_as_object(e), js_atom_from_cstr(ctx, "input"), input, JS_PROP_DEFAULT);
    if (!js_is_undefined(base)) js_define_data(ctx, js_as_object(e), js_atom_from_cstr(ctx, "base"), base, JS_PROP_DEFAULT);
    return js_throw(ctx, e);
}

/* Parses the API's (input, base) into a record: 1, 0 on failure, -1 with an exception. Strings
 * are returned for the error. */
static int parse_args(JSContext *ctx, uint32_t argc, const JSValue *argv, URLRecord *out, JSValue *input, JSValue *base) {
    if (argc == 0) {
        js_discard(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS", "The \"url\" argument must be specified"));
        return -1;
    }
    *input = js_to_string(ctx, argv[0]);
    if (js_is_exception(*input)) return -1;
    *base = JS_UNDEFINED;
    if (argc > 1 && !js_is_undefined(argv[1])) {
        *base = js_to_string(ctx, argv[1]);
        if (js_is_exception(*base)) return -1;
    }
    URLRecord base_rec;
    if (!js_is_undefined(*base)) {
        if (!parse_string(ctx, *base, NULL, &base_rec)) return 0;
    }
    bool ok = parse_string(ctx, *input, js_is_undefined(*base) ? NULL : &base_rec, out);
    if (!js_is_undefined(*base)) record_free(&base_rec);
    return ok ? 1 : 0;
}

static JSValue new_url(JSContext *ctx, JSValue proto, URLRecord *rec) {
    URLRecord *r = malloc(sizeof *r);
    if (!r) js_fatal("out of memory in URL");
    *r = *rec;
    URLObject *u = (URLObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &url_class, proto, 0));
    u->rec = r;
    js_init_slot(&u->search_params, JS_EMPTY);
    return js_object_value(&u->obj);
}

/* new URL(input, base) */
BUILTIN(url_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "URL");
    URLRecord rec;
    JSValue input, base;
    int r = parse_args(ctx, argc, argv, &rec, &input, &base);
    if (r < 0) return JS_EXCEPTION;
    if (r == 0) return throw_invalid_url(ctx, input, base);
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_URL_PROTOTYPE);
    if (js_is_exception(proto)) {
        record_free(&rec);
        return proto;
    }
    return new_url(ctx, proto, &rec);
}

/* URL.canParse(input, base) */
BUILTIN(url_can_parse) {
    UNUSED_ARGS;
    URLRecord rec;
    JSValue input, base;
    int r = parse_args(ctx, argc, argv, &rec, &input, &base);
    if (r < 0) return JS_EXCEPTION;
    if (r) record_free(&rec);
    return js_bool(r == 1);
}

/* URL.parse(input, base): a URL, or null */
BUILTIN(url_parse) {
    UNUSED_ARGS;
    URLRecord rec;
    JSValue input, base;
    int r = parse_args(ctx, argc, argv, &rec, &input, &base);
    if (r < 0) return JS_EXCEPTION;
    if (r == 0) return JS_NULL;
    return new_url(ctx, ctx->intrinsics[JS_INTRINSIC_URL_PROTOTYPE], &rec);
}

static JSValue href_of(JSContext *ctx, const URLRecord *rec) {
    Buf b = { 0 };
    serialize(rec, &b, false);
    JSValue s = buf_string(ctx, b.v, b.n);
    free(b.v);
    return s;
}

JSValue js_parse_url_href(JSContext *ctx, JSValue input) {
    URLRecord rec;
    if (!parse_string(ctx, input, NULL, &rec)) return JS_UNDEFINED;
    JSValue href = href_of(ctx, &rec);
    record_free(&rec);
    return href;
}

BUILTIN(url_href) {
    UNUSED_ARGS;
    THIS_URL();
    return href_of(ctx, u->rec);
}

BUILTIN(url_set_href) {
    UNUSED_ARGS;
    THIS_URL();
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    URLRecord rec;
    if (!parse_string(ctx, s, NULL, &rec)) return throw_invalid_url(ctx, s, JS_UNDEFINED);
    record_free(u->rec);
    *u->rec = rec;
    return refresh_params(ctx, u) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

/* The origin's serialization (URL §4.6, HTML §7.5). */
static void origin_of(const URLRecord *rec, Buf *out) {
    buf_clear(out);
    if (buf_eq(&rec->scheme, "blob")) {
        URLRecord inner = { 0 };
        inner.port = -1;
        CPs cps = { 0 };
        for (size_t i = 0; i < rec->path.n; i++) cps_push(&cps, (uint8_t)rec->path.v[i]);
        bool ok = basic_parse(cps.v, cps.n, NULL, &inner, ST_NONE);  /* the path's serialization */
        free(cps.v);
        if (ok && (buf_eq(&inner.scheme, "http") || buf_eq(&inner.scheme, "https"))) origin_of(&inner, out);
        else buf_cstr(out, "null");
        record_free(&inner);
        return;
    }
    int port = special_port(&rec->scheme);
    if (port <= 0) {  /* not special, or file: opaque */
        buf_cstr(out, "null");
        return;
    }
    buf_append(out, rec->scheme.v, rec->scheme.n);
    buf_cstr(out, "://");
    buf_append(out, rec->host.v ? rec->host.v : "", rec->host.n);
    if (rec->port >= 0) {
        char text[16];
        snprintf(text, sizeof text, ":%d", rec->port);
        buf_cstr(out, text);
    }
}

BUILTIN(url_origin) {
    UNUSED_ARGS;
    THIS_URL();
    Buf b = { 0 };
    origin_of(u->rec, &b);
    JSValue s = buf_string(ctx, b.v, b.n);
    free(b.v);
    return s;
}

BUILTIN(url_protocol) {
    UNUSED_ARGS;
    THIS_URL();
    Buf b = { 0 };
    buf_copy(&b, &u->rec->scheme);
    buf_push(&b, ':');
    JSValue s = buf_string(ctx, b.v, b.n);
    free(b.v);
    return s;
}

/* A setter's value as code points (with the suffix a setter appends, if any). */
static int setter_input(JSContext *ctx, JSValue v, CPs *out) {
    JSValue s = js_to_string(ctx, v);
    if (js_is_exception(s)) return -1;
    cps_of(ctx, s, out);
    return 0;
}

BUILTIN(url_set_protocol) {
    UNUSED_ARGS;
    THIS_URL();
    CPs in = { 0 };
    if (setter_input(ctx, ARG(0), &in) < 0) return JS_EXCEPTION;
    cps_push(&in, ':');
    parse_override(ctx, in.v, in.n, u->rec, ST_SCHEME_START);
    free(in.v);
    return JS_UNDEFINED;
}

BUILTIN(url_username) {
    UNUSED_ARGS;
    THIS_URL();
    return buf_string(ctx, u->rec->username.v, u->rec->username.n);
}

BUILTIN(url_password) {
    UNUSED_ARGS;
    THIS_URL();
    return buf_string(ctx, u->rec->password.v, u->rec->password.n);
}

static JSValue set_credential(JSContext *ctx, URLObject *u, JSValue v, bool password) {
    CPs in = { 0 };
    if (setter_input(ctx, v, &in) < 0) return JS_EXCEPTION;
    if (!cannot_have_credentials(u->rec)) {
        Buf *b = password ? &u->rec->password : &u->rec->username;
        buf_clear(b);
        for (size_t i = 0; i < in.n; i++) put_encoded(b, in.v[i], SET_USERINFO);
    }
    free(in.v);
    return JS_UNDEFINED;
}

BUILTIN(url_set_username) {
    UNUSED_ARGS;
    THIS_URL();
    return set_credential(ctx, u, ARG(0), false);
}

BUILTIN(url_set_password) {
    UNUSED_ARGS;
    THIS_URL();
    return set_credential(ctx, u, ARG(0), true);
}

BUILTIN(url_host) {
    UNUSED_ARGS;
    THIS_URL();
    if (!u->rec->has_host || u->rec->host.n == 0) return js_empty_string();  /* Ada: an empty host shows no port */
    Buf b = { 0 };
    buf_copy(&b, &u->rec->host);
    if (u->rec->port >= 0) {
        char text[16];
        snprintf(text, sizeof text, ":%d", u->rec->port);
        buf_cstr(&b, text);
    }
    JSValue s = buf_string(ctx, b.v, b.n);
    free(b.v);
    return s;
}

BUILTIN(url_hostname) {
    UNUSED_ARGS;
    THIS_URL();
    return buf_string(ctx, u->rec->host.v, u->rec->has_host ? u->rec->host.n : 0);
}

static JSValue set_with_state(JSContext *ctx, URLObject *u, JSValue v, State state) {
    CPs in = { 0 };
    if (setter_input(ctx, v, &in) < 0) return JS_EXCEPTION;
    parse_override(ctx, in.v, in.n, u->rec, state);
    free(in.v);
    return JS_UNDEFINED;
}

BUILTIN(url_set_host) {
    UNUSED_ARGS;
    THIS_URL();
    if (u->rec->opaque_path) return js_is_exception(js_to_string(ctx, ARG(0))) ? JS_EXCEPTION : JS_UNDEFINED;
    return set_with_state(ctx, u, ARG(0), ST_HOST);
}

BUILTIN(url_set_hostname) {
    UNUSED_ARGS;
    THIS_URL();
    if (u->rec->opaque_path) return js_is_exception(js_to_string(ctx, ARG(0))) ? JS_EXCEPTION : JS_UNDEFINED;
    return set_with_state(ctx, u, ARG(0), ST_HOSTNAME);
}

BUILTIN(url_port) {
    UNUSED_ARGS;
    THIS_URL();
    if (u->rec->port < 0) return js_empty_string();
    char text[16];
    snprintf(text, sizeof text, "%d", u->rec->port);
    return js_new_string_cstr(ctx, text);
}

BUILTIN(url_set_port) {
    UNUSED_ARGS;
    THIS_URL();
    CPs in = { 0 };
    if (setter_input(ctx, ARG(0), &in) < 0) return JS_EXCEPTION;
    if (!cannot_have_credentials(u->rec)) {
        /* the empty string clears the port; anything else is parsed, its tabs and newlines removed
           first (only those: nothing changes) */
        if (in.n == 0) {
            u->rec->port = -1;
        } else {
            size_t k = 0;
            for (size_t i = 0; i < in.n; i++)
                if (in.v[i] != '\t' && in.v[i] != '\n' && in.v[i] != '\r') in.v[k++] = in.v[i];
            if (k) parse_override(ctx, in.v, k, u->rec, ST_PORT);
        }
    }
    free(in.v);
    return JS_UNDEFINED;
}

BUILTIN(url_pathname) {
    UNUSED_ARGS;
    THIS_URL();
    return buf_string(ctx, u->rec->path.v, u->rec->path.n);
}

BUILTIN(url_set_pathname) {
    UNUSED_ARGS;
    THIS_URL();
    CPs in = { 0 };
    if (setter_input(ctx, ARG(0), &in) < 0) return JS_EXCEPTION;
    if (!u->rec->opaque_path) {
        buf_clear(&u->rec->path);
        parse_override(ctx, in.v, in.n, u->rec, ST_PATH_START);
    }
    free(in.v);
    return JS_UNDEFINED;
}

BUILTIN(url_search) {
    UNUSED_ARGS;
    THIS_URL();
    if (!u->rec->has_query || u->rec->query.n == 0) return js_empty_string();
    Buf b = { 0 };
    buf_push(&b, '?');
    buf_append(&b, u->rec->query.v, u->rec->query.n);
    JSValue s = buf_string(ctx, b.v, b.n);
    free(b.v);
    return s;
}

BUILTIN(url_set_search) {
    UNUSED_ARGS;
    THIS_URL();
    CPs in = { 0 };
    if (setter_input(ctx, ARG(0), &in) < 0) return JS_EXCEPTION;
    if (in.n == 0) {
        u->rec->has_query = false;
        buf_clear(&u->rec->query);
        strip_trailing_spaces(u->rec);
    } else {
        size_t skip = in.v[0] == '?' ? 1 : 0;
        buf_clear(&u->rec->query);
        u->rec->has_query = true;
        parse_override(ctx, in.v + skip, in.n - skip, u->rec, ST_QUERY);
    }
    free(in.v);
    return refresh_params(ctx, u) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

BUILTIN(url_search_params) {
    UNUSED_ARGS;
    THIS_URL();
    if (js_is_empty(u->search_params)) {
        JSValue p = new_params(ctx, ctx->intrinsics[JS_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE]);
        js_store(ctx, &js_as_object(p)->cell, &((ParamsObject *)js_as_object(p))->url, this_val);
        js_store(ctx, &u->obj.cell, &u->search_params, p);
        if (refresh_params(ctx, u) < 0) return JS_EXCEPTION;
    }
    return u->search_params;
}

BUILTIN(url_hash) {
    UNUSED_ARGS;
    THIS_URL();
    if (!u->rec->has_fragment || u->rec->fragment.n == 0) return js_empty_string();
    Buf b = { 0 };
    buf_push(&b, '#');
    buf_append(&b, u->rec->fragment.v, u->rec->fragment.n);
    JSValue s = buf_string(ctx, b.v, b.n);
    free(b.v);
    return s;
}

BUILTIN(url_set_hash) {
    UNUSED_ARGS;
    THIS_URL();
    CPs in = { 0 };
    if (setter_input(ctx, ARG(0), &in) < 0) return JS_EXCEPTION;
    if (in.n == 0) {
        u->rec->has_fragment = false;
        buf_clear(&u->rec->fragment);
        strip_trailing_spaces(u->rec);
    } else {
        size_t skip = in.v[0] == '#' ? 1 : 0;
        buf_clear(&u->rec->fragment);
        u->rec->has_fragment = true;
        for (size_t i = skip; i < in.n; i++)
            if (in.v[i] != '\t' && in.v[i] != '\n' && in.v[i] != '\r') put_encoded(&u->rec->fragment, in.v[i], SET_FRAGMENT);
    }
    free(in.v);
    return JS_UNDEFINED;
}

BUILTIN(url_to_string) {
    UNUSED_ARGS;
    THIS_URL();
    return href_of(ctx, u->rec);
}

/* The name of a value's constructor, for Node's inspection: `URL`, or a subclass's. */
static void constructor_name(JSContext *ctx, JSValue v, const char *fallback, char *out, size_t cap) {
    snprintf(out, cap, "%s", fallback);
    JSValue c = js_get_value(ctx, v, JS_ATOM(constructor));
    if (js_is_exception(c)) {
        js_discard(js_take_exception(ctx));
        return;
    }
    if (!js_is_object(c)) return;
    JSValue n = js_get_value(ctx, c, JS_ATOM(name));
    if (js_is_exception(n)) {
        js_discard(js_take_exception(ctx));
        return;
    }
    if (js_is_string(n) && js_string_length(n) != 0) out[js_view_to_utf8(js_string_view(ctx, n), out, cap - 1)] = '\0';
}

/* Node's URL inspection: `URL { href: …, origin: …, … }`. */
BUILTIN(url_inspect) {
    UNUSED_ARGS;
    THIS_URL();
    if (js_is_number(ARG(0)) && js_as_number(ARG(0)) < 0) return this_val;
    JSInspectOptions o = js_inspect_defaults;
    if (js_is_object(ARG(1)) && js_inspect_options_from(ctx, ARG(1), &o) < 0) return JS_EXCEPTION;
    static const struct { const char *name; JSNativeFn get; } FIELDS[] = {
        { "href", url_href }, { "origin", url_origin }, { "protocol", url_protocol }, { "username", url_username },
        { "password", url_password }, { "host", url_host }, { "hostname", url_hostname }, { "port", url_port },
        { "pathname", url_pathname }, { "search", url_search }, { "searchParams", url_search_params }, { "hash", url_hash },
    };
    JSValue obj = js_new_object(ctx);
    for (size_t i = 0; i < JS_COUNTOF(FIELDS); i++) {
        JSValue v = FIELDS[i].get(ctx, JS_UNDEFINED, this_val, 0, NULL, JS_UNDEFINED);
        if (js_is_exception(v)) return v;
        js_define_data(ctx, js_as_object(obj), js_atom_from_cstr(ctx, FIELDS[i].name), v, JS_PROP_DEFAULT);
    }
    JSValue text = js_inspect_with(ctx, obj, &o);
    if (js_is_exception(text)) return text;
    char name[96];
    constructor_name(ctx, this_val, "URL", name, sizeof name);
    JSValue prefix = js_new_string_cstr(ctx, name);
    return js_concat(ctx, js_concat(ctx, prefix, js_char_string(' ')), text);
}

/* ---- URLSearchParams ------------------------------------------------------------------------ */

static int pair_from_iterable(JSContext *ctx, ParamsObject *p, JSValue pair) {
    if (js_is_array(pair)) {
        double len;
        if (js_length_of_array_like(ctx, pair, &len) < 0) return -1;
        if (len != 2) goto bad;
        JSValue name = js_get_value(ctx, pair, js_int32(0));
        if (js_is_exception(name) || js_is_exception(name = to_usv(ctx, name))) return -1;
        JSValue value = js_get_value(ctx, pair, js_int32(1));
        if (js_is_exception(value) || js_is_exception(value = to_usv(ctx, value))) return -1;
        params_append(ctx, p, name, value);
        return 0;
    }
    if (!js_is_object(pair)) goto bad;
    JSValue method = js_get_value(ctx, pair, JS_SYMBOL(iterator));
    if (js_is_exception(method)) return -1;
    if (!js_is_callable(method)) goto bad;
    JSValue rec = js_iter_start(ctx, pair);
    if (js_is_exception(rec)) return -1;
    uint32_t length = 0;
    for (;;) {
        JSValue e = js_iter_next(ctx, rec);
        if (js_is_exception(e)) return -1;
        if (js_is_empty(e)) break;
        e = to_usv(ctx, e);
        if (js_is_exception(e)) return -1;
        length++;
        if (p->n + 1 > p->cap) {
            size_t cap = p->cap;
            p->list = grow(p->list, &cap, p->n + 1, sizeof *p->list);
            p->cap = (uint32_t)cap;
        }
        js_store(ctx, &p->obj.cell, &p->list[p->n++], e);
    }
    if (length != 2) goto bad;
    return 0;
bad:
    js_discard(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_TUPLE", "Each query pair must be an iterable [name, value] tuple"));
    return -1;
}

/* new URLSearchParams(init) */
BUILTIN(params_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "URLSearchParams");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    JSValue self = new_params(ctx, proto);
    ParamsObject *p = (ParamsObject *)js_as_object(self);
    JSValue init = ARG(0);
    if (js_is_undefined(init)) return self;  /* null is the string "null" (Node 24, the standard) */
    if (js_is_object(init)) {
        ParamsObject *other = as_params(init);
        JSValue method = js_get_value(ctx, init, JS_SYMBOL(iterator));
        if (js_is_exception(method)) return method;
        if (other && js_same_bits(method, ctx->intrinsics[JS_INTRINSIC_URL_SEARCH_PARAMS_ENTRIES])) {
            for (uint32_t i = 0; i < other->n; i += 2) params_append(ctx, p, other->list[i], other->list[i + 1]);
            return self;
        }
        if (!js_is_nullish(method)) {  /* sequence<sequence<USVString>> */
            if (!js_is_callable(method))
                return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_ARG_NOT_ITERABLE", "Query pairs must be iterable");
            JSValue rec = js_iter_start(ctx, init);
            if (js_is_exception(rec)) return rec;
            for (;;) {
                JSValue pair = js_iter_next(ctx, rec);
                if (js_is_exception(pair)) return pair;
                if (js_is_empty(pair)) break;
                if (pair_from_iterable(ctx, p, pair) < 0) return JS_EXCEPTION;
            }
            return self;
        }
        /* record<USVString, USVString> */
        JSValue keys = js_own_keys(ctx, js_as_object(init));
        if (js_is_exception(keys)) return keys;
        JSValueArray *ka = (JSValueArray *)js_as_cell(keys);
        for (uint32_t i = 0; i < ka->cell.aux; i++) {
            JSValue key = ka->values[i];
            JSPropertyDescriptor d;
            int has = js_get_own_property(ctx, js_as_object(init), key, &d);
            if (has < 0) return JS_EXCEPTION;
            if (!has || !(d.attrs & JS_PROP_ENUMERABLE)) continue;
            JSValue name = to_usv(ctx, key);
            if (js_is_exception(name)) return name;
            JSValue value = js_get_value(ctx, init, key);
            if (js_is_exception(value) || js_is_exception(value = to_usv(ctx, value))) return JS_EXCEPTION;
            uint32_t k = 0;
            while (k < p->n && !js_string_equals(ctx, p->list[k], name)) k += 2;
            if (k < p->n) js_store(ctx, &p->obj.cell, &p->list[k + 1], value);
            else params_append(ctx, p, name, value);
        }
        return self;
    }
    JSValue s = to_usv(ctx, init);
    if (js_is_exception(s)) return s;
    Buf bytes = { 0 };
    JSStrView v = js_string_view(ctx, s);
    size_t n = js_view_to_utf8(v, NULL, 0);
    bytes.v = malloc(n + 1);
    if (!bytes.v) js_fatal("out of memory in URLSearchParams");
    js_view_to_utf8(v, bytes.v, n);
    size_t skip = n && bytes.v[0] == '?' ? 1 : 0;
    int r = params_parse(ctx, p, (const uint8_t *)bytes.v + skip, n - skip);
    free(bytes.v);
    return r < 0 ? JS_EXCEPTION : self;
}

static JSValue missing(JSContext *ctx, bool two) {
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS",
                               two ? "The \"name\" and \"value\" arguments must be specified" : "The \"name\" argument must be specified");
}

BUILTIN(params_size) {
    UNUSED_ARGS;
    THIS_PARAMS();
    return js_number(sp->n / 2);
}

BUILTIN(params_append_method) {
    UNUSED_ARGS;
    THIS_PARAMS();
    if (argc < 2) return missing(ctx, true);
    JSValue name = to_usv(ctx, argv[0]);
    if (js_is_exception(name)) return name;
    JSValue value = to_usv(ctx, argv[1]);
    if (js_is_exception(value)) return value;
    params_append(ctx, sp, name, value);
    update_url(ctx, sp);
    return JS_UNDEFINED;
}

/* delete(name, value) and has(name, value): a pair matches its name, and its value when given. */
static int matching(JSContext *ctx, uint32_t argc, const JSValue *argv, JSValue *name, JSValue *value) {
    if (argc < 1) {
        js_discard(missing(ctx, false));
        return -1;
    }
    *name = to_usv(ctx, argv[0]);
    if (js_is_exception(*name)) return -1;
    *value = JS_EMPTY;
    if (argc > 1 && !js_is_undefined(argv[1])) {
        *value = to_usv(ctx, argv[1]);
        if (js_is_exception(*value)) return -1;
    }
    return 0;
}

static bool pair_matches(JSContext *ctx, ParamsObject *p, uint32_t i, JSValue name, JSValue value) {
    return js_string_equals(ctx, p->list[i], name) && (js_is_empty(value) || js_string_equals(ctx, p->list[i + 1], value));
}

BUILTIN(params_delete) {
    UNUSED_ARGS;
    THIS_PARAMS();
    JSValue name, value;
    if (matching(ctx, argc, argv, &name, &value) < 0) return JS_EXCEPTION;
    uint32_t k = 0;
    for (uint32_t i = 0; i < sp->n; i += 2) {
        if (pair_matches(ctx, sp, i, name, value)) continue;
        sp->list[k++] = sp->list[i];  /* barrier: same owner */
        sp->list[k++] = sp->list[i + 1];  /* barrier: same owner */
    }
    sp->n = k;
    update_url(ctx, sp);
    return JS_UNDEFINED;
}

BUILTIN(params_get) {
    UNUSED_ARGS;
    THIS_PARAMS();
    if (argc < 1) return missing(ctx, false);
    JSValue name = to_usv(ctx, argv[0]);
    if (js_is_exception(name)) return name;
    for (uint32_t i = 0; i < sp->n; i += 2)
        if (js_string_equals(ctx, sp->list[i], name)) return sp->list[i + 1];
    return JS_NULL;
}

BUILTIN(params_get_all) {
    UNUSED_ARGS;
    THIS_PARAMS();
    if (argc < 1) return missing(ctx, false);
    JSValue name = to_usv(ctx, argv[0]);
    if (js_is_exception(name)) return name;
    JSValue a = js_new_array(ctx, 0);
    for (uint32_t i = 0; i < sp->n; i += 2)
        if (js_string_equals(ctx, sp->list[i], name) && js_array_push(ctx, js_as_object(a), sp->list[i + 1]) < 0) return JS_EXCEPTION;
    return a;
}

BUILTIN(params_has) {
    UNUSED_ARGS;
    THIS_PARAMS();
    JSValue name, value;
    if (matching(ctx, argc, argv, &name, &value) < 0) return JS_EXCEPTION;
    for (uint32_t i = 0; i < sp->n; i += 2)
        if (pair_matches(ctx, sp, i, name, value)) return JS_TRUE;
    return JS_FALSE;
}

BUILTIN(params_set) {
    UNUSED_ARGS;
    THIS_PARAMS();
    if (argc < 2) return missing(ctx, true);
    JSValue name = to_usv(ctx, argv[0]);
    if (js_is_exception(name)) return name;
    JSValue value = to_usv(ctx, argv[1]);
    if (js_is_exception(value)) return value;
    bool found = false;
    uint32_t k = 0;
    for (uint32_t i = 0; i < sp->n; i += 2) {
        if (js_string_equals(ctx, sp->list[i], name)) {
            if (found) continue;
            found = true;
            js_store(ctx, &sp->obj.cell, &sp->list[i + 1], value);
        }
        sp->list[k++] = sp->list[i];  /* barrier: same owner */
        sp->list[k++] = sp->list[i + 1];  /* barrier: same owner */
    }
    sp->n = k;
    if (!found) params_append(ctx, sp, name, value);
    update_url(ctx, sp);
    return JS_UNDEFINED;
}

/* sort(): stable, by name in code units */
BUILTIN(params_sort) {
    UNUSED_ARGS;
    THIS_PARAMS();
    for (uint32_t i = 2; i < sp->n; i += 2) {  /* insertion sort: stable, and lists are short */
        JSValue name = sp->list[i], value = sp->list[i + 1];
        uint32_t k = i;
        while (k > 0 && js_string_compare(ctx, sp->list[k - 2], name) > 0) {
            sp->list[k] = sp->list[k - 2];  /* barrier: same owner */
            sp->list[k + 1] = sp->list[k - 1];  /* barrier: same owner */
            k -= 2;
        }
        sp->list[k] = name;  /* barrier: same owner */
        sp->list[k + 1] = value;  /* barrier: same owner */
    }
    update_url(ctx, sp);
    return JS_UNDEFINED;
}

BUILTIN(params_to_string) {
    UNUSED_ARGS;
    THIS_PARAMS();
    Buf b = { 0 };
    params_serialize(ctx, sp, &b);
    JSValue s = buf_string(ctx, b.v, b.n);
    free(b.v);
    return s;
}

BUILTIN(params_for_each) {
    UNUSED_ARGS;
    THIS_PARAMS();
    if (!js_is_callable(ARG(0))) return js_throw_invalid_arg_type(ctx, "callback", "of type function", ARG(0));
    for (uint32_t i = 0; i < sp->n; i += 2) {  /* the list is live */
        JSValue args[3] = { sp->list[i + 1], sp->list[i], this_val };
        JSValue r = js_call(ctx, ARG(0), ARG(1), 3, args);
        if (js_is_exception(r)) return r;
    }
    return JS_UNDEFINED;
}

static JSValue new_iterator(JSContext *ctx, JSValue params, uint8_t kind) {
    ParamsIterator *it = (ParamsIterator *)js_alloc_object(ctx, JS_CELL_OBJECT,
        js_shape_root(ctx, &iterator_class, ctx->intrinsics[JS_INTRINSIC_URL_SEARCH_PARAMS_ITERATOR_PROTOTYPE], 0));
    js_init_slot(&it->params, params);
    it->index = 0;
    it->kind = kind;
    return js_object_value(&it->obj);
}

BUILTIN(params_entries) {
    UNUSED_ARGS;
    THIS_PARAMS();
    return new_iterator(ctx, this_val, 2);
}

BUILTIN(params_keys) {
    UNUSED_ARGS;
    THIS_PARAMS();
    return new_iterator(ctx, this_val, 0);
}

BUILTIN(params_values) {
    UNUSED_ARGS;
    THIS_PARAMS();
    return new_iterator(ctx, this_val, 1);
}

static ParamsIterator *as_iterator(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &iterator_class ? (ParamsIterator *)js_as_object(v) : NULL;
}

BUILTIN(iterator_next) {
    UNUSED_ARGS;
    ParamsIterator *it = as_iterator(this_val);
    if (!it) return js_throw_invalid_this(ctx, "URLSearchParamsIterator");
    ParamsObject *p = (ParamsObject *)js_as_object(it->params);
    if (it->index >= p->n) return js_iter_result(ctx, JS_UNDEFINED, true);
    JSValue name = p->list[it->index], value = p->list[it->index + 1];
    it->index += 2;
    if (it->kind == 0) return js_iter_result(ctx, name, false);
    if (it->kind == 1) return js_iter_result(ctx, value, false);
    JSValue pair[2] = { name, value };
    return js_iter_result(ctx, js_new_array_from(ctx, pair, 2), false);
}

/* The inspect options a custom inspector passes on, one level deeper. */
static int inner_options(JSContext *ctx, JSValue depth, JSValue opts, JSInspectOptions *o) {
    *o = js_inspect_defaults;
    if (js_is_object(opts) && js_inspect_options_from(ctx, opts, o) < 0) return -1;
    if (js_is_number(depth)) o->depth = js_as_number(depth) - 1;
    return 0;
}

/* Node's URLSearchParams inspection: `URLSearchParams { 'a' => '1', 'b' => '2' }`. */
BUILTIN(params_inspect) {
    UNUSED_ARGS;
    THIS_PARAMS();
    char name[96];
    if (js_is_number(ARG(0)) && js_as_number(ARG(0)) < 0) return js_new_string_cstr(ctx, "[Object]");
    JSInspectOptions o;
    if (inner_options(ctx, ARG(0), ARG(1), &o) < 0) return JS_EXCEPTION;
    constructor_name(ctx, this_val, "URLSearchParams", name, sizeof name);
    JSValue parts = js_new_array(ctx, 0);  /* the `'name' => 'value'` strings, kept alive */
    double length = -2;
    for (uint32_t i = 0; i < sp->n; i += 2) {
        JSValue k = js_inspect_with(ctx, sp->list[i], &o);
        if (js_is_exception(k)) return k;
        JSValue v = js_inspect_with(ctx, sp->list[i + 1], &o);
        if (js_is_exception(v)) return v;
        JSValue s = js_concat(ctx, js_concat(ctx, k, js_new_string_cstr(ctx, " => ")), v);
        if (js_is_exception(s) || js_array_push(ctx, js_as_object(parts), s) < 0) return JS_EXCEPTION;
        length += js_string_length(s) + 2;
    }
    uint32_t count = js_array_length(js_as_object(parts));
    JSInspectOptions caller = js_inspect_defaults;
    if (js_is_object(ARG(1)) && js_inspect_options_from(ctx, ARG(1), &caller) < 0) return JS_EXCEPTION;
    const char *open, *sep, *close;
    if (length > caller.break_length) open = " {\n  ", sep = ",\n  ", close = " }";
    else if (count) open = " { ", sep = ", ", close = " }";
    else return js_concat(ctx, js_new_string_cstr(ctx, name), js_new_string_cstr(ctx, " {}"));
    JSValue r = js_concat(ctx, js_new_string_cstr(ctx, name), js_new_string_cstr(ctx, open));
    for (uint32_t i = 0; i < count; i++) {
        if (i) r = js_concat(ctx, r, js_new_string_cstr(ctx, sep));
        r = js_concat(ctx, r, js_get_value(ctx, parts, js_int32((int32_t)i)));
        if (js_is_exception(r)) return r;
    }
    return js_concat(ctx, r, js_new_string_cstr(ctx, close));
}

/* Node's iterator inspection: `URLSearchParams Iterator { [ 'a', '1' ] }`, what remains. */
BUILTIN(iterator_inspect) {
    UNUSED_ARGS;
    ParamsIterator *it = as_iterator(this_val);
    if (!it) return js_throw_invalid_this(ctx, "URLSearchParamsIterator");
    if (js_is_number(ARG(0)) && js_as_number(ARG(0)) < 0) return js_new_string_cstr(ctx, "[Object]");
    JSInspectOptions o;
    if (inner_options(ctx, ARG(0), ARG(1), &o) < 0) return JS_EXCEPTION;
    ParamsObject *p = (ParamsObject *)js_as_object(it->params);
    JSValue output = js_new_array(ctx, 0);
    for (uint32_t i = it->index; i < p->n; i += 2) {
        JSValue item = it->kind == 0 ? p->list[i] : it->kind == 1 ? p->list[i + 1] : js_new_array_from(ctx, p->list + i, 2);
        if (js_array_push(ctx, js_as_object(output), item) < 0) return JS_EXCEPTION;
    }
    JSValue whole = js_inspect_with(ctx, output, &o);
    if (js_is_exception(whole)) return whole;
    bool break_lines = false;
    JSStrView wv = js_string_view(ctx, whole);
    for (uint32_t i = 0; i < wv.length && !break_lines; i++) break_lines = js_view_at(wv, i) == '\n';
    JSValue r = js_new_string_cstr(ctx, break_lines ? "URLSearchParams Iterator {\n  " : "URLSearchParams Iterator { ");
    uint32_t count = js_array_length(js_as_object(output));
    for (uint32_t i = 0; i < count; i++) {
        JSValue s = js_inspect_with(ctx, js_get_value(ctx, output, js_int32((int32_t)i)), &o);
        if (js_is_exception(s)) return s;
        if (i) r = js_concat(ctx, r, js_new_string_cstr(ctx, break_lines ? ",\n  " : ", "));
        r = js_concat(ctx, r, s);
        if (js_is_exception(r)) return r;
    }
    return js_concat(ctx, r, js_new_string_cstr(ctx, " }"));
}

/* ---- Realm ---------------------------------------------------------------------------------- */


static const JSBuiltin url_statics[] = {
    WEBIDL_OPERATION("parse", url_parse, 1),
    WEBIDL_OPERATION("canParse", url_can_parse, 1),
};

static const JSBuiltin url_proto[] = {
    WEBIDL_OPERATION("toString", url_to_string, 0),
    WEBIDL_ATTRIBUTE("href", url_href, url_set_href),
    WEBIDL_ATTRIBUTE("origin", url_origin, NULL),
    WEBIDL_ATTRIBUTE("protocol", url_protocol, url_set_protocol),
    WEBIDL_ATTRIBUTE("username", url_username, url_set_username),
    WEBIDL_ATTRIBUTE("password", url_password, url_set_password),
    WEBIDL_ATTRIBUTE("host", url_host, url_set_host),
    WEBIDL_ATTRIBUTE("hostname", url_hostname, url_set_hostname),
    WEBIDL_ATTRIBUTE("port", url_port, url_set_port),
    WEBIDL_ATTRIBUTE("pathname", url_pathname, url_set_pathname),
    WEBIDL_ATTRIBUTE("search", url_search, url_set_search),
    WEBIDL_ATTRIBUTE("searchParams", url_search_params, NULL),
    WEBIDL_ATTRIBUTE("hash", url_hash, url_set_hash),
    WEBIDL_OPERATION("toJSON", url_to_string, 0),
};

static const JSBuiltin params_proto[] = {
    WEBIDL_ATTRIBUTE("size", params_size, NULL),
    WEBIDL_OPERATION("append", params_append_method, 2),
    WEBIDL_OPERATION("delete", params_delete, 1),
    WEBIDL_OPERATION("get", params_get, 1),
    WEBIDL_OPERATION("getAll", params_get_all, 1),
    WEBIDL_OPERATION("has", params_has, 1),
    WEBIDL_OPERATION("set", params_set, 2),
    WEBIDL_OPERATION("sort", params_sort, 0),
    WEBIDL_OPERATION("entries", params_entries, 0),
    WEBIDL_OPERATION("forEach", params_for_each, 1),
    WEBIDL_OPERATION("keys", params_keys, 0),
    WEBIDL_OPERATION("values", params_values, 0),
    WEBIDL_OPERATION("toString", params_to_string, 0),
};

static const JSBuiltin iterator_proto[] = {
    WEBIDL_OPERATION("next", iterator_next, 0),
};

static void define_inspect(JSContext *ctx, JSValue proto, JSNativeFn fn, const char *tag) {
    JSValue key = js_symbol_for(ctx, js_new_string_cstr(ctx, "nodejs.util.inspect.custom"));
    JSValue f = js_new_native(ctx, fn, js_new_string_cstr(ctx, "[nodejs.util.inspect.custom]"), 2, JS_FN_STRICT);
    js_define_data(ctx, js_as_object(proto), key, f, JS_BUILTIN_METHOD_ATTRS);
    js_define_data(ctx, js_as_object(proto), JS_SYMBOL(toStringTag), js_new_string_cstr(ctx, tag), JS_PROP_CONFIGURABLE);
}

static JSValue define_class(JSContext *ctx, JSObject *global, const char *name, JSNativeFn ctor, uint32_t length, JSIntrinsic slot) {
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 16);
    ctx->intrinsics[slot] = proto;
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue c = js_new_native(ctx, ctor, key, length, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
    return c;
}

static void install_url(JSContext *ctx, JSObject *global) {
    JSValue url = define_class(ctx, global, "URL", url_ctor, 1, JS_INTRINSIC_URL_PROTOTYPE);
    js_define_builtins(ctx, js_as_object(url), url_statics, JS_COUNTOF(url_statics));
    JSValue proto = ctx->intrinsics[JS_INTRINSIC_URL_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(proto), url_proto, JS_COUNTOF(url_proto));
    define_inspect(ctx, proto, url_inspect, "URL");

    define_class(ctx, global, "URLSearchParams", params_ctor, 0, JS_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE);
    JSValue pp = ctx->intrinsics[JS_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(pp), params_proto, JS_COUNTOF(params_proto));
    define_inspect(ctx, pp, params_inspect, "URLSearchParams");
    JSPropertyDescriptor d;
    if (js_get_own_property(ctx, js_as_object(pp), js_atom_from_cstr(ctx, "entries"), &d) == 1) {
        ctx->intrinsics[JS_INTRINSIC_URL_SEARCH_PARAMS_ENTRIES] = d.value;
        js_define_data(ctx, js_as_object(pp), JS_SYMBOL(iterator), d.value, JS_BUILTIN_METHOD_ATTRS);
    }

    JSValue ip = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_ITERATOR_PROTOTYPE], 4);
    ctx->intrinsics[JS_INTRINSIC_URL_SEARCH_PARAMS_ITERATOR_PROTOTYPE] = ip;
    js_define_builtins(ctx, js_as_object(ip), iterator_proto, JS_COUNTOF(iterator_proto));
    define_inspect(ctx, ip, iterator_inspect, "URLSearchParams Iterator");
}

const JSComponent js_component_url = { "url", install_url };
