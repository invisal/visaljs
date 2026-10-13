/* UTS #46 domain to ASCII: a C port of Ada's IDNA (src/ada_idna.cpp of ada-url/ada 2.9.2, the
 * version Node v22 bundles; mapping.cpp, punycode.cpp, validity.cpp and to_ascii.cpp), kept
 * step for step, including Ada's quirks, so that hosts come out as Node's do. Copyright Yagiz
 * Nizipli and Daniel Lemire; MIT license (LICENSE-MIT). visaljs's changes: C instead of C++
 * (code point buffers instead of std::u32string), tables packed by convert.mjs, and
 * normalization by QuickJS's libunicode instead of Ada's own tables. */
#include "idna.h"

#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

#include "cutils.h"      /* libunicode.h expects it */
#include "libunicode.h"

enum { IDNA_IGNORED, IDNA_VALID, IDNA_DISALLOWED, IDNA_MAPPED };

enum idna_direction {
    DIR_NONE, DIR_BN, DIR_CS, DIR_ES, DIR_ON, DIR_EN, DIR_L, DIR_R, DIR_NSM, DIR_AL, DIR_AN, DIR_ET,
    DIR_WS, DIR_RLO, DIR_LRO, DIR_PDF, DIR_RLE, DIR_RLI, DIR_FSI, DIR_PDI, DIR_LRI, DIR_B, DIR_S, DIR_LRE,
};

#include "idna_tables.h"

/* ---- Buffers ------------------------------------------------------------------------------- */

typedef struct {
    uint32_t *v;
    size_t    n, cap;
} U32;

typedef struct {
    char  *v;
    size_t n, cap;
} Bytes;

static void *grow(void *p, size_t *cap, size_t need, size_t size) {
    if (need <= *cap) return p;
    size_t c = *cap ? *cap : 16;
    while (c < need) c *= 2;
    void *q = realloc(p, c * size);
    if (!q) abort();
    *cap = c;
    return q;
}

static void u32_push(U32 *b, uint32_t c) {
    b->v = grow(b->v, &b->cap, b->n + 1, sizeof *b->v);
    b->v[b->n++] = c;
}

static void u32_insert(U32 *b, size_t at, uint32_t c) {
    b->v = grow(b->v, &b->cap, b->n + 1, sizeof *b->v);
    memmove(b->v + at + 1, b->v + at, (b->n - at) * sizeof *b->v);
    b->v[at] = c;
    b->n++;
}

static void bytes_push(Bytes *b, char c) {
    b->v = grow(b->v, &b->cap, b->n + 2, 1);
    b->v[b->n++] = c;
    b->v[b->n] = '\0';
}

static void bytes_append(Bytes *b, const char *s, size_t n) {
    for (size_t i = 0; i < n; i++) bytes_push(b, s[i]);
}

static bool u32_equal(const uint32_t *a, size_t an, const uint32_t *b, size_t bn) {
    return an == bn && (an == 0 || memcmp(a, b, an * sizeof *a) == 0);
}

/* ---- Mapping (mapping.cpp) ----------------------------------------------------------------- */

static size_t find_range_index(uint32_t key) {
    size_t low = 0, high = IDNA_TABLE_COUNT - 1;
    while (low <= high) {
        size_t middle = (low + high) >> 1;
        uint32_t value = idna_table[middle] & 0x1FFFFF;
        if (value < key) low = middle + 1;
        else if (value > key) {
            if (middle == 0) break;
            high = middle - 1;
        } else return middle;
    }
    return low == 0 ? 0 : low - 1;
}

/* The IDNA mapping of `in` into `out`; false when a code point is disallowed (Ada's empty result). */
static bool map(const uint32_t *in, size_t n, U32 *out) {
    out->n = 0;
    for (size_t i = 0; i < n; i++) {
        size_t index = find_range_index(in[i]);
        uint32_t e = idna_table[index];
        switch ((e >> 21) & 3) {
        case IDNA_IGNORED: break;
        case IDNA_VALID: u32_push(out, in[i]); break;
        case IDNA_DISALLOWED: out->n = 0; return false;
        default:
            for (uint32_t k = 0, at = idna_table_index[index]; k < e >> 23; k++) u32_push(out, idna_mappings[at + k]);
        }
    }
    return true;
}

static void normalize(U32 *s) {
    uint32_t *out = NULL;
    int len = unicode_normalize(&out, s->v, (int)s->n, UNICODE_NFC, NULL, NULL);
    if (len < 0) abort();
    s->v = grow(s->v, &s->cap, (size_t)len, sizeof *s->v);
    if (len) memcpy(s->v, out, (size_t)len * sizeof *out);
    s->n = (size_t)len;
    free(out);
}

/* ---- Punycode (punycode.cpp) --------------------------------------------------------------- */

enum { BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128 };

static int32_t char_to_digit_value(char value) {
    if (value >= 'a' && value <= 'z') return value - 'a';
    if (value >= '0' && value <= '9') return value - '0' + 26;
    return -1;
}

static char digit_to_char(int32_t digit) { return digit < 26 ? (char)(digit + 97) : (char)(digit + 22); }

static int32_t adapt(int32_t d, int32_t n, bool firsttime) {
    d = firsttime ? d / DAMP : d / 2;
    d += d / n;
    int32_t k = 0;
    while (d > ((BASE - TMIN) * TMAX) / 2) {
        d /= BASE - TMIN;
        k += BASE;
    }
    return k + (((BASE - TMIN + 1) * d) / (d + SKEW));
}

static bool punycode_to_utf32(const char *input, size_t len, U32 *out) {
    int32_t written_out = 0;
    uint32_t n = INITIAL_N;
    int32_t i = 0;
    int32_t bias = INITIAL_BIAS;
    size_t end_of_ascii = len;
    for (size_t k = len; k-- > 0;)
        if (input[k] == '-') {
            end_of_ascii = k;
            break;
        }
    if (end_of_ascii != len) {
        for (size_t k = 0; k < end_of_ascii; k++) {
            uint8_t c = (uint8_t)input[k];
            if (c >= 0x80) return false;
            u32_push(out, c);
            written_out++;
        }
        input += end_of_ascii + 1;
        len -= end_of_ascii + 1;
    }
    while (len > 0) {
        int32_t oldi = i;
        int32_t w = 1;
        for (int32_t k = BASE;; k += BASE) {
            if (len == 0) return false;
            uint8_t code_point = (uint8_t)*input++;
            len--;
            int32_t digit = char_to_digit_value((char)code_point);
            if (digit < 0) return false;
            if (digit > (0x7fffffff - i) / w) return false;
            i = i + digit * w;
            int32_t t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
            if (digit < t) break;
            if (w > 0x7fffffff / (BASE - t)) return false;
            w = w * (BASE - t);
        }
        bias = adapt(i - oldi, written_out + 1, oldi == 0);
        if (i / (written_out + 1) > (int32_t)(0x7fffffff - n)) return false;
        n = n + (uint32_t)(i / (written_out + 1));
        i = i % (written_out + 1);
        if (n < 0x80) return false;
        u32_insert(out, (size_t)i, n);
        written_out++;
        ++i;
    }
    return true;
}

static bool utf32_to_punycode(const uint32_t *input, size_t len, Bytes *out) {
    uint32_t n = INITIAL_N;
    int32_t d = 0;
    int32_t bias = INITIAL_BIAS;
    size_t h = 0;
    for (size_t k = 0; k < len; k++) {
        uint32_t c = input[k];
        if (c < 0x80) {
            ++h;
            bytes_push(out, (char)c);
        }
        if (c > 0x10ffff || (c >= 0xd880 && c < 0xe000)) return false;  /* sic: Ada's bound */
    }
    size_t b = h;
    if (b > 0) bytes_push(out, '-');
    while (h < len) {
        uint32_t m = 0x10FFFF;
        for (size_t k = 0; k < len; k++)
            if (input[k] >= n && input[k] < m) m = input[k];
        if ((m - n) > (0x7fffffff - (uint32_t)d) / (h + 1)) return false;
        d = d + (int32_t)((m - n) * (h + 1));
        n = m;
        for (size_t k = 0; k < len; k++) {
            uint32_t c = input[k];
            if (c < n) {
                if (d == 0x7fffffff) return false;
                ++d;
            }
            if (c == n) {
                int32_t q = d;
                for (int32_t kk = BASE;; kk += BASE) {
                    int32_t t = kk <= bias ? TMIN : kk >= bias + TMAX ? TMAX : kk - bias;
                    if (q < t) break;
                    bytes_push(out, digit_to_char(t + ((q - t) % (BASE - t))));
                    q = (q - t) / (BASE - t);
                }
                bytes_push(out, digit_to_char(q));
                bias = adapt(d, (int32_t)(h + 1), h == b);
                d = 0;
                ++h;
            }
        }
        ++d;
        ++n;
    }
    return true;
}

/* ---- Validity (validity.cpp) --------------------------------------------------------------- */

static bool in_ranges(const uint32_t (*r)[2], size_t count, uint32_t c) {
    size_t lo = 0, hi = count;
    while (lo < hi) {
        size_t mid = (lo + hi) / 2;
        if (c < r[mid][0]) hi = mid;
        else if (c > r[mid][1]) lo = mid + 1;
        else return true;
    }
    return false;
}

static int find_direction(uint32_t c) {
    size_t lo = 0, hi = IDNA_DIR_COUNT;  /* the first range whose last code point is >= c */
    while (lo < hi) {
        size_t mid = (lo + hi) / 2;
        if (idna_dir_last[mid] < c) lo = mid + 1;
        else hi = mid;
    }
    if (lo == IDNA_DIR_COUNT) return DIR_NONE;
    return c >= idna_dir_first[lo] ? idna_dir_class[lo] : DIR_NONE;
}

static bool is_label_valid(const uint32_t *label, size_t n) {
    if (n == 0) return true;
    /* the label must not begin with a combining mark */
    if (in_ranges(idna_combining, IDNA_COMBINING_COUNT, label[0])) return false;
    /* CheckJoiners: ContextJ (RFC 5892, Appendix A) */
    for (size_t i = 0; i < n; i++) {
        uint32_t c = label[i];
        if (c == 0x200c) {
            if (i > 0 && in_ranges(idna_virama, IDNA_VIRAMA_COUNT, label[i - 1])) return true;  /* sic: Ada returns */
            if (i == 0 || i + 1 >= n) return false;
            bool before = false, after = false;
            for (size_t k = 0; k < i && !before; k++)
                before = in_ranges(idna_l, IDNA_L_COUNT, label[k]) || in_ranges(idna_d, IDNA_D_COUNT, label[k]);
            for (size_t k = i + 1; k < n && !after; k++)
                after = in_ranges(idna_r, IDNA_R_COUNT, label[k]) || in_ranges(idna_d, IDNA_D_COUNT, label[k]);
            return before && after;
        } else if (c == 0x200d) {
            if (i > 0 && in_ranges(idna_virama, IDNA_VIRAMA_COUNT, label[i - 1])) return true;
            return false;
        }
    }
    /* CheckBidi (RFC 5893, section 2) */
    size_t last_non_nsm = n;
    for (size_t i = n; i-- > 0;)
        if (find_direction(label[i]) != DIR_NSM) {
            last_non_nsm = i;
            break;
        }
    if (last_non_nsm == n) return false;
    unsigned directions = 0;
    for (size_t i = 0; i < n; i++) directions |= 1u << find_direction(label[i]);
    if (!(directions & ((1u << DIR_R) | (1u << DIR_AL) | (1u << DIR_AN)))) return true;
    if (find_direction(label[0]) == DIR_L) {  /* LTR; Ada checks up to the last non-NSM, exclusive */
        for (size_t i = 0; i < last_non_nsm; i++) {
            int d = find_direction(label[i]);
            if (!(d == DIR_L || d == DIR_EN || d == DIR_ES || d == DIR_CS || d == DIR_ET || d == DIR_ON || d == DIR_BN || d == DIR_NSM))
                return false;
        }
        return true;
    }
    bool has_an = false, has_en = false;
    for (size_t i = 0; i <= last_non_nsm; i++) {
        int d = find_direction(label[i]);
        if (d == DIR_EN) {
            has_en = true;
            if (has_an) return false;
        }
        if (d == DIR_AN) {
            has_an = true;
            if (has_en) return false;
        }
        if (!(d == DIR_R || d == DIR_AL || d == DIR_AN || d == DIR_EN || d == DIR_ES || d == DIR_CS || d == DIR_ET || d == DIR_ON || d == DIR_BN ||
              d == DIR_NSM))
            return false;
        if (i == last_non_nsm && !(d == DIR_R || d == DIR_AL || d == DIR_AN || d == DIR_EN)) return false;
    }
    return true;
}

/* ---- To ASCII (to_ascii.cpp) --------------------------------------------------------------- */

/* An xn-- label (its punycode after the prefix): it must decode, be mapped and normalized
 * already, and be valid. */
static bool check_punycode_label(const char *puny, size_t len) {
    U32 decoded = { 0 }, mapped = { 0 }, normal = { 0 };
    bool ok = punycode_to_utf32(puny, len, &decoded);
    if (ok) {
        map(decoded.v, decoded.n, &mapped);
        ok = u32_equal(decoded.v, decoded.n, mapped.v, mapped.n);
    }
    if (ok) {
        for (size_t i = 0; i < mapped.n; i++) u32_push(&normal, mapped.v[i]);
        normalize(&normal);
        ok = u32_equal(normal.v, normal.n, mapped.v, mapped.n) && mapped.n != 0 && is_label_valid(mapped.v, mapped.n);
    }
    free(decoded.v);
    free(mapped.v);
    free(normal.v);
    return ok;
}

static char *from_ascii_to_ascii(const uint32_t *domain, size_t n, size_t *out_len) {
    Bytes mapped = { 0 }, out = { 0 };
    for (size_t i = 0; i < n; i++) bytes_push(&mapped, (char)(domain[i] >= 'A' && domain[i] <= 'Z' ? domain[i] + 32 : domain[i]));
    size_t label_start = 0;
    while (label_start != mapped.n) {
        const char *dot = memchr(mapped.v + label_start, '.', mapped.n - label_start);
        bool last = dot == NULL;
        size_t label_size = last ? mapped.n - label_start : (size_t)(dot - (mapped.v + label_start));
        const char *label = mapped.v + label_start;
        label_start += last ? label_size : label_size + 1;
        if (label_size >= 4 && memcmp(label, "xn--", 4) == 0) {
            bytes_append(&out, label, label_size);
            if (!check_punycode_label(label + 4, label_size - 4)) goto fail;
        } else {
            bytes_append(&out, label, label_size);
        }
        if (!last) bytes_push(&out, '.');
    }
    free(mapped.v);
    if (out.n == 0) goto fail_out;
    *out_len = out.n;
    return out.v;
fail:
    free(mapped.v);
fail_out:
    free(out.v);
    return NULL;
}

char *idna_to_ascii(const uint32_t *domain, size_t n, size_t *out_len) {
    bool ascii = true;
    for (size_t i = 0; i < n && ascii; i++) ascii = domain[i] < 0x80;
    if (ascii) return from_ascii_to_ascii(domain, n, out_len);
    U32 s = { 0 };
    Bytes out = { 0 };
    if (!map(domain, n, &s)) goto fail;
    normalize(&s);
    size_t label_start = 0;
    while (label_start != s.n) {
        size_t end = label_start;
        while (end < s.n && s.v[end] != '.') end++;
        bool last = end == s.n;
        const uint32_t *label = s.v + label_start;
        size_t label_size = end - label_start;
        label_start = last ? end : end + 1;
        if (label_size >= 4 && label[0] == 'x' && label[1] == 'n' && label[2] == '-' && label[3] == '-') {
            for (size_t i = 0; i < label_size; i++) {
                if (label[i] >= 0x80) goto fail;
                bytes_push(&out, (char)label[i]);
            }
            if (!check_punycode_label(out.v + out.n - label_size + 4, label_size - 4)) goto fail;
        } else {
            bool label_ascii = true;
            for (size_t i = 0; i < label_size && label_ascii; i++) label_ascii = label[i] < 0x80;
            if (label_ascii) {
                for (size_t i = 0; i < label_size; i++) bytes_push(&out, (char)label[i]);
            } else {
                if (!is_label_valid(label, label_size)) goto fail;
                bytes_append(&out, "xn--", 4);
                if (!utf32_to_punycode(label, label_size, &out)) goto fail;
            }
        }
        if (!last) bytes_push(&out, '.');
    }
    free(s.v);
    if (out.n == 0) {
        free(out.v);
        return NULL;
    }
    *out_len = out.n;
    return out.v;
fail:
    free(s.v);
    free(out.v);
    return NULL;
}
