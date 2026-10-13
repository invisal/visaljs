/* Date (ECMAScript §21.4), the date component.
 *
 * A Date holds a time value: milliseconds since the epoch, UTC, or NaN. Local time comes from the
 * C library's time zone (localtime_r: TZ, else /etc/localtime), and the zone's English names,
 * which Date.prototype.toString shows as Node does ("Western European Summer Time"), from a table
 * generated from Node's ICU data (tznames.gen.h). Date.parse is V8's parser: the ISO format,
 * then its legacy one. toLocaleString and friends format as en-US, whatever locale is asked.
 *
 * Date.parse is ported from V8 (Copyright the V8 project authors, BSD 3-clause):
 * runtime/third_party/v8-ieee754/LICENSE. */
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
#include "js_symbol.h"
#include "jscontext.h"
#include "jsstring.h"
#include "os.h"

#include "tznames.gen.h"

#define MS_PER_DAY 86400000.0
#define MAX_TIME 8.64e15

typedef struct DateObject {
    JSObject obj;
    double   time;  /* the [[DateValue]]: a time value, or NaN */
} DateObject;

static const JSClass date_class = { "Date", sizeof(DateObject), NULL, NULL, NULL, NULL, NULL, NULL, NULL };

static bool is_date(JSValue v) { return js_is_object(v) && js_as_object(v)->shape->cls == &date_class; }

/* ---- Time values (§21.4.1) ------------------------------------------------------------------ */

static double day_of(double t) { return floor(t / MS_PER_DAY); }

static double time_within_day(double t) {
    double r = fmod(t, MS_PER_DAY);
    return r < 0 ? r + MS_PER_DAY : r + 0.0;  /* never -0 */
}

static double day_from_year(double y) {
    return 365 * (y - 1970) + floor((y - 1969) / 4) - floor((y - 1901) / 100) + floor((y - 1601) / 400);
}

static bool leap(double y) { return fmod(y, 4) == 0 && (fmod(y, 100) != 0 || fmod(y, 400) == 0); }

static double year_from_time(double t) {
    double y = floor(t / (MS_PER_DAY * 365.2425)) + 1970;
    while (day_from_year(y) * MS_PER_DAY > t) y--;
    while (day_from_year(y + 1) * MS_PER_DAY <= t) y++;
    return y;
}

static const int month_start[2][13] = {
    { 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365 },
    { 0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366 },
};

/* The calendar fields of a time value. */
typedef struct Fields {
    double year, month, date, hours, minutes, seconds, ms, weekday;
} Fields;

static Fields fields_of(double t) {
    Fields f;
    f.year = year_from_time(t);
    int day_in_year = (int)(day_of(t) - day_from_year(f.year));
    const int *starts = month_start[leap(f.year)];
    int m = 0;
    while (day_in_year >= starts[m + 1]) m++;
    f.month = m;
    f.date = day_in_year - starts[m] + 1;
    double w = fmod(day_of(t) + 4, 7);
    f.weekday = w < 0 ? w + 7 : w;
    double ms = time_within_day(t);
    f.hours = floor(ms / 3600000);
    f.minutes = fmod(floor(ms / 60000), 60);
    f.seconds = fmod(floor(ms / 1000), 60);
    f.ms = fmod(ms, 1000);
    return f;
}

static double to_integer(double d) { return trunc(d) + 0.0; }

/* MakeTime (§21.4.1.27) */
static double make_time(double h, double m, double s, double ms) {
    if (!isfinite(h) || !isfinite(m) || !isfinite(s) || !isfinite(ms)) return NAN;
    return to_integer(h) * 3600000.0 + to_integer(m) * 60000.0 + to_integer(s) * 1000.0 + to_integer(ms);
}

/* MakeDay (§21.4.1.28) */
static double make_day(double year, double month, double date) {
    if (!isfinite(year) || !isfinite(month) || !isfinite(date)) return NAN;
    double y = to_integer(year), m = to_integer(month), dt = to_integer(date);
    double ym = y + floor(m / 12);
    if (fabs(ym) > 400000) return NAN;  /* far outside the time value range */
    double mn = fmod(m, 12);
    if (mn < 0) mn += 12;
    double day = day_from_year(ym) + month_start[leap(ym)][(int)mn];
    return day + dt - 1;
}

/* MakeDate (§21.4.1.29) */
static double make_date(double day, double time) {
    double tv = day * MS_PER_DAY + time;
    return isfinite(tv) ? tv : NAN;
}

/* TimeClip (§21.4.1.31) */
static double time_clip(double t) {
    if (!isfinite(t) || fabs(t) > MAX_TIME) return NAN;
    return to_integer(t);
}

/* ---- Local time (§21.4.1.20–25) ------------------------------------------------------------- */

static double offset_at(double t, bool *dst) {
    bool d;
    double off = js_os_local_offset((int64_t)floor(t / 1000), &d) * 1000.0;
    if (dst) *dst = d;
    return off;
}

static double local_time(double t) { return t + offset_at(t, NULL); }

/* UTC(t) (§21.4.1.26): a local time to a time value. In a repeated hour, the earlier instant;
 * in a skipped one, the offset from before the transition. */
static double utc_of(double tl) {
    if (!isfinite(tl)) return NAN;
    double before = offset_at(tl - MS_PER_DAY, NULL), after = offset_at(tl + MS_PER_DAY, NULL);
    if (before == after) return tl - before;
    double ub = tl - before, ua = tl - after;
    bool vb = offset_at(ub, NULL) == before, va = offset_at(ua, NULL) == after;
    if (vb && va) return ub < ua ? ub : ua;
    if (vb) return ub;
    if (va) return ua;
    return ub;
}

/* ---- Formatting ----------------------------------------------------------------------------- */

static const char *const day_names[] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
static const char *const month_names[] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };

/* A year as toString shows it: 4 digits at least, with a sign if negative. */
static void put_year(char *buf, size_t cap, double y) {
    snprintf(buf, cap, y < 0 ? "-%04.0f" : "%04.0f", fabs(y));
}

static int compare_zone(const void *key, const void *entry) {
    return strcmp((const char *)key, ((const struct TzZone *)entry)->id);
}

/* "GMT+0100 (Western European Standard Time)" for the time value t. */
static void put_zone(char *buf, size_t cap, double t) {
    bool dst;
    double off = offset_at(t, &dst);
    double minutes = trunc(off / 60000);
    char sign = minutes < 0 ? '-' : '+';
    minutes = fabs(minutes);
    const struct TzZone *z = bsearch(js_os_timezone_id(), tz_zones, JS_COUNTOF(tz_zones), sizeof *tz_zones, compare_zone);
    char fallback[32];
    if (!z) {  /* ICU's own fallback: "GMT+01:00", or "GMT" at zero */
        if (minutes == 0) snprintf(fallback, sizeof fallback, "GMT");
        else snprintf(fallback, sizeof fallback, "GMT%c%02.0f:%02.0f", sign, floor(minutes / 60), fmod(minutes, 60));
    }
    snprintf(buf, cap, "GMT%c%02.0f%02.0f (%s)", sign, floor(minutes / 60), fmod(minutes, 60),
             z ? tz_names[dst ? z->dst : z->std] : fallback);
}

enum { FMT_STRING, FMT_DATE, FMT_TIME, FMT_UTC, FMT_ISO, FMT_LOCALE, FMT_LOCALE_DATE, FMT_LOCALE_TIME };

/* The string forms of a valid time value. */
static void format(char *buf, size_t cap, double t, int kind) {
    char year[24], zone[96];
    Fields f = fields_of(kind == FMT_UTC || kind == FMT_ISO ? t : local_time(t));
    switch (kind) {
    case FMT_STRING:
        put_year(year, sizeof year, f.year);
        put_zone(zone, sizeof zone, t);
        snprintf(buf, cap, "%s %s %02.0f %s %02.0f:%02.0f:%02.0f %s", day_names[(int)f.weekday], month_names[(int)f.month], f.date,
                 year, f.hours, f.minutes, f.seconds, zone);
        break;
    case FMT_DATE:
        put_year(year, sizeof year, f.year);
        snprintf(buf, cap, "%s %s %02.0f %s", day_names[(int)f.weekday], month_names[(int)f.month], f.date, year);
        break;
    case FMT_TIME:
        put_zone(zone, sizeof zone, t);
        snprintf(buf, cap, "%02.0f:%02.0f:%02.0f %s", f.hours, f.minutes, f.seconds, zone);
        break;
    case FMT_UTC:
        put_year(year, sizeof year, f.year);
        snprintf(buf, cap, "%s, %02.0f %s %s %02.0f:%02.0f:%02.0f GMT", day_names[(int)f.weekday], f.date, month_names[(int)f.month],
                 year, f.hours, f.minutes, f.seconds);
        break;
    case FMT_ISO:
        if (f.year >= 0 && f.year <= 9999) snprintf(year, sizeof year, "%04.0f", f.year);
        else snprintf(year, sizeof year, "%c%06.0f", f.year < 0 ? '-' : '+', fabs(f.year));
        snprintf(buf, cap, "%s-%02.0f-%02.0fT%02.0f:%02.0f:%02.0f.%03.0fZ", year, f.month + 1, f.date, f.hours, f.minutes, f.seconds, f.ms);
        break;
    default: {  /* en-US: "1/1/1970, 1:00:00 AM"; years before 1 count back from 1 BC */
        double y = f.year <= 0 ? 1 - f.year : f.year;
        double h12 = fmod(f.hours, 12) == 0 ? 12 : fmod(f.hours, 12);
        const char *ampm = f.hours < 12 ? "AM" : "PM";
        if (kind == FMT_LOCALE)
            snprintf(buf, cap, "%.0f/%.0f/%.0f, %.0f:%02.0f:%02.0f %s", f.month + 1, f.date, y, h12, f.minutes, f.seconds, ampm);
        else if (kind == FMT_LOCALE_DATE)
            snprintf(buf, cap, "%.0f/%.0f/%.0f", f.month + 1, f.date, y);
        else
            snprintf(buf, cap, "%.0f:%02.0f:%02.0f %s", h12, f.minutes, f.seconds, ampm);
    }
    }
}

static JSValue format_value(JSContext *ctx, double t, int kind) {
    if (isnan(t)) return js_new_string_cstr(ctx, "Invalid Date");
    char buf[160];
    format(buf, sizeof buf, t, kind);
    return js_new_string_cstr(ctx, buf);
}

/* ---- Date.parse: V8's date parser ----------------------------------------------------------- */

enum { TK_END, TK_NUMBER, TK_SYMBOL, TK_SPACE, TK_KEYWORD, TK_UNKNOWN, TK_INVALID };
enum { KW_NONE, KW_MONTH, KW_AM_PM, KW_ZONE, KW_T };

typedef struct Token {
    int type;
    int value;   /* a number's value (saturated), a symbol's character, a keyword's value */
    int length;  /* a number's digits, a keyword's letters */
    int keyword; /* KW_* */
} Token;

typedef struct Scanner {
    const uint16_t *s;
    uint32_t len, pos;
    Token next;
} Scanner;

static uint32_t peek_char(Scanner *sc) { return sc->pos < sc->len ? sc->s[sc->pos] : 0; }

static bool is_space(uint32_t c) {
    return c == ' ' || (c >= 9 && c <= 13) || c == 0xA0 || c == 0xFEFF || c == 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
           c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000;
}

static const struct { char word[4]; int keyword, value; } keywords[] = {
    { "jan", KW_MONTH, 1 }, { "feb", KW_MONTH, 2 }, { "mar", KW_MONTH, 3 }, { "apr", KW_MONTH, 4 },
    { "may", KW_MONTH, 5 }, { "jun", KW_MONTH, 6 }, { "jul", KW_MONTH, 7 }, { "aug", KW_MONTH, 8 },
    { "sep", KW_MONTH, 9 }, { "oct", KW_MONTH, 10 }, { "nov", KW_MONTH, 11 }, { "dec", KW_MONTH, 12 },
    { "am", KW_AM_PM, 0 }, { "pm", KW_AM_PM, 12 },
    { "ut", KW_ZONE, 0 }, { "utc", KW_ZONE, 0 }, { "z", KW_ZONE, 0 }, { "gmt", KW_ZONE, 0 },
    { "cdt", KW_ZONE, -5 }, { "cst", KW_ZONE, -6 }, { "edt", KW_ZONE, -4 }, { "est", KW_ZONE, -5 },
    { "mdt", KW_ZONE, -6 }, { "mst", KW_ZONE, -7 }, { "pdt", KW_ZONE, -7 }, { "pst", KW_ZONE, -8 },
    { "t", KW_T, 0 },
};

static Token scan(Scanner *sc) {
    Token t = { TK_END, 0, 0, KW_NONE };
    if (sc->pos >= sc->len) return t;
    uint32_t c = peek_char(sc);
    if (c >= '0' && c <= '9') {
        int n = 0, len = 0;
        while ((c = peek_char(sc)) >= '0' && c <= '9' && sc->pos < sc->len) {
            if (n < 214748364 - 10) n = n * 10 + (int)(c - '0');
            sc->pos++;
            len++;
        }
        return (Token){ TK_NUMBER, n, len, KW_NONE };
    }
    if (c == ':' || c == '-' || c == '+' || c == '.' || c == ')') {
        sc->pos++;
        return (Token){ TK_SYMBOL, (int)c, 1, KW_NONE };
    }
    if (c >= 'A' && !is_space(c)) {  /* a word: its first three letters, lowercased, pick a keyword */
        char pre[4] = { 0, 0, 0, 0 };
        int len = 0;
        while (sc->pos < sc->len && (c = peek_char(sc)) >= 'A' && !is_space(c)) {
            if (len < 3) pre[len] = (char)(c < 128 ? (c >= 'A' && c <= 'Z' ? c | 0x20 : c) : 1);
            sc->pos++;
            len++;
        }
        for (size_t i = 0; i < JS_COUNTOF(keywords); i++) {
            if (strncmp(pre, keywords[i].word, 3) != 0) continue;
            if (len <= 3 || keywords[i].keyword == KW_MONTH) return (Token){ TK_KEYWORD, keywords[i].value, len, keywords[i].keyword };
        }
        return (Token){ TK_KEYWORD, 0, len, KW_NONE };
    }
    if (is_space(c)) {
        while (sc->pos < sc->len && is_space(peek_char(sc))) sc->pos++;
        return (Token){ TK_SPACE, 0, 0, KW_NONE };
    }
    if (c == '(') {  /* a comment, nested parentheses included */
        int depth = 0;
        do {
            c = peek_char(sc);
            if (c == '(') depth++;
            else if (c == ')') depth--;
            sc->pos++;
        } while (depth > 0 && sc->pos < sc->len);
        return (Token){ TK_UNKNOWN, 0, 0, KW_NONE };
    }
    sc->pos++;
    return (Token){ TK_UNKNOWN, 0, 0, KW_NONE };
}

static Token next_token(Scanner *sc) {
    Token t = sc->next;
    sc->next = scan(sc);
    return t;
}

static bool skip_symbol(Scanner *sc, int c) {
    if (sc->next.type != TK_SYMBOL || sc->next.value != c) return false;
    next_token(sc);
    return true;
}

static bool is_fixed_number(Token t, int length) { return t.type == TK_NUMBER && t.length == length; }
static bool is_sign(Token t) { return t.type == TK_SYMBOL && (t.value == '+' || t.value == '-'); }
static bool is_keyword_z(Token t) { return t.type == TK_KEYWORD && t.keyword == KW_ZONE && t.length == 1 && t.value == 0; }
static bool between(int x, int lo, int hi) { return x >= lo && x <= hi; }

#define NONE (-1000000)

typedef struct DayComposer {
    int comp[3], index, named_month;
    bool iso;
} DayComposer;

typedef struct TimeComposer {
    int comp[4], index, hour_offset;
} TimeComposer;

typedef struct ZoneComposer {
    int sign, hour, minute;
} ZoneComposer;

static bool day_add(DayComposer *d, int n) {
    if (d->index >= 3) return false;
    d->comp[d->index++] = n;
    return true;
}

static bool time_add(TimeComposer *t, int n) {
    if (t->index >= 4) return false;
    t->comp[t->index++] = n;
    return true;
}

static bool time_add_final(TimeComposer *t, int n) {
    if (!time_add(t, n)) return false;
    while (t->index < 4) t->comp[t->index++] = 0;
    return true;
}

static bool time_expecting(const TimeComposer *t, int n) {
    return (t->index == 1 && between(n, 0, 59)) || (t->index == 2 && between(n, 0, 59)) || (t->index == 3 && between(n, 0, 999));
}

static void zone_set(ZoneComposer *z, int hours) {
    z->sign = hours < 0 ? -1 : 1;
    z->hour = hours < 0 ? -hours : hours;
    z->minute = 0;
}

static bool zone_expecting(const ZoneComposer *z, int n) { return z->hour != NONE && z->minute == NONE && between(n, 0, 59); }
static bool zone_is_utc(const ZoneComposer *z) { return z->hour == 0 && z->minute == 0; }

/* Milliseconds from a fraction's digits: the first three, scaled. */
static int read_ms(Token t) {
    int n = t.value, len = t.length;
    if (len == 1) return n * 100;
    if (len == 2) return n * 10;
    if (len > 3) {
        if (len > 9) len = 9;
        int factor = 1;
        do {
            factor *= 10;
            len--;
        } while (len > 3);
        n /= factor;
    }
    return n;
}

/* The ES5 date-time format (§21.4.1.32), V8's way: the token where it stopped (END when the whole
 * string was read), or INVALID. */
static Token parse_iso(Scanner *sc, DayComposer *day, TimeComposer *time, ZoneComposer *tz) {
    if (is_sign(sc->next)) {
        Token sign = next_token(sc);
        if (!is_fixed_number(sc->next, 6)) return sign;
        int year = next_token(sc).value;
        if (sign.value == '-' && year == 0) return sign;
        day_add(day, sign.value == '-' ? -year : year);
    } else if (is_fixed_number(sc->next, 4)) {
        day_add(day, next_token(sc).value);
    } else {
        return next_token(sc);
    }
    if (skip_symbol(sc, '-')) {
        if (!is_fixed_number(sc->next, 2) || !between(sc->next.value, 1, 12)) return next_token(sc);
        day_add(day, next_token(sc).value);
        if (skip_symbol(sc, '-')) {
            if (!is_fixed_number(sc->next, 2) || !between(sc->next.value, 1, 31)) return next_token(sc);
            day_add(day, next_token(sc).value);
        }
    }
    if (!(sc->next.type == TK_KEYWORD && sc->next.keyword == KW_T)) {
        if (sc->next.type != TK_END) return next_token(sc);
    } else {
        next_token(sc);
        Token invalid = { TK_INVALID, 0, 0, KW_NONE };
        if (!is_fixed_number(sc->next, 2) || !between(sc->next.value, 0, 24)) return invalid;
        bool hour_24 = sc->next.value == 24;
        time_add(time, next_token(sc).value);
        if (!skip_symbol(sc, ':')) return invalid;
        if (!is_fixed_number(sc->next, 2) || !between(sc->next.value, 0, 59) || (hour_24 && sc->next.value > 0)) return invalid;
        time_add(time, next_token(sc).value);
        if (skip_symbol(sc, ':')) {
            if (!is_fixed_number(sc->next, 2) || !between(sc->next.value, 0, 59) || (hour_24 && sc->next.value > 0)) return invalid;
            time_add(time, next_token(sc).value);
            if (skip_symbol(sc, '.')) {
                if (sc->next.type != TK_NUMBER || (hour_24 && sc->next.value > 0)) return invalid;
                time_add(time, read_ms(next_token(sc)));
            }
        }
        if (is_keyword_z(sc->next)) {
            next_token(sc);
            zone_set(tz, 0);
        } else if (is_sign(sc->next)) {
            tz->sign = next_token(sc).value == '+' ? 1 : -1;
            if (is_fixed_number(sc->next, 4)) {
                int hm = next_token(sc).value;
                if (!between(hm / 100, 0, 23) || !between(hm % 100, 0, 59)) return invalid;
                tz->hour = hm / 100;
                tz->minute = hm % 100;
            } else {
                if (!is_fixed_number(sc->next, 2) || !between(sc->next.value, 0, 23)) return invalid;
                tz->hour = next_token(sc).value;
                if (!skip_symbol(sc, ':')) return invalid;
                if (!is_fixed_number(sc->next, 2) || !between(sc->next.value, 0, 59)) return invalid;
                tz->minute = next_token(sc).value;
            }
        }
        if (sc->next.type != TK_END) return invalid;
    }
    /* date-only forms are UTC; date-time forms without an offset, local */
    if (tz->hour == NONE && time->index == 0) zone_set(tz, 0);
    day->iso = true;
    return (Token){ TK_END, 0, 0, KW_NONE };
}

/* Date.parse(string): a time value, or NaN. */
static double parse_date(JSContext *ctx, JSValue str) {
    JSStrView v = js_string_view(ctx, str);
    uint16_t *units = malloc((v.length + 1) * sizeof *units);
    if (!units) js_fatal("out of memory parsing a date");
    for (uint32_t i = 0; i < v.length; i++) units[i] = (uint16_t)js_view_at(v, i);
    Scanner sc = { units, v.length, 0, { TK_END, 0, 0, KW_NONE } };
    sc.next = scan(&sc);
    DayComposer day = { { 0, 0, 0 }, 0, NONE, false };
    TimeComposer time = { { 0, 0, 0, 0 }, 0, NONE };
    ZoneComposer tz = { NONE, NONE, NONE };
    double result = NAN;

    Token token = parse_iso(&sc, &day, &time, &tz);
    if (token.type == TK_INVALID) goto done;
    bool has_read_number = day.index > 0;
    for (; token.type != TK_END; token = next_token(&sc)) {  /* the legacy parser */
        if (token.type == TK_NUMBER) {
            has_read_number = true;
            int n = token.value;
            if (skip_symbol(&sc, ':')) {
                if (skip_symbol(&sc, ':')) {
                    if (time.index != 0) goto done;
                    time_add(&time, n);
                    time_add(&time, 0);
                } else {
                    if (!time_add(&time, n)) goto done;
                    if (sc.next.type == TK_SYMBOL && sc.next.value == '.') next_token(&sc);
                }
            } else if (sc.next.type == TK_SYMBOL && sc.next.value == '.' && time_expecting(&time, n)) {
                next_token(&sc);
                time_add(&time, n);
                if (sc.next.type != TK_NUMBER) goto done;
                time_add_final(&time, read_ms(next_token(&sc)));
            } else if (zone_expecting(&tz, n)) {
                tz.minute = n;
            } else if (time_expecting(&time, n)) {
                time_add_final(&time, n);
                Token p = sc.next;
                if (p.type != TK_END && p.type != TK_SPACE && !is_keyword_z(p) && !is_sign(p)) goto done;
            } else {
                if (!day_add(&day, n)) goto done;
                skip_symbol(&sc, '-');
            }
        } else if (token.type == TK_KEYWORD) {
            if (token.keyword == KW_AM_PM && time.index != 0) {
                time.hour_offset = token.value;
            } else if (token.keyword == KW_MONTH) {
                day.named_month = token.value;
                skip_symbol(&sc, '-');
            } else if (token.keyword == KW_ZONE && has_read_number) {
                zone_set(&tz, token.value);
            } else {
                if (has_read_number) goto done;           /* no words after a number */
                if (sc.next.type == TK_NUMBER) goto done;  /* nor a word glued to one */
            }
        } else if (is_sign(token) && (zone_is_utc(&tz) || time.index != 0)) {
            tz.sign = token.value == '+' ? 1 : -1;
            int n = 0, length = 0;
            if (sc.next.type == TK_NUMBER) {
                Token num = next_token(&sc);
                n = num.value;
                length = num.length;
            }
            has_read_number = true;
            if (sc.next.type == TK_SYMBOL && sc.next.value == ':') {
                tz.hour = n;
                tz.minute = NONE;
            } else if (length == 1 || length == 2) {
                tz.hour = n;
                tz.minute = 0;
            } else if (length == 3 || length == 4) {
                tz.hour = n / 100;
                tz.minute = n % 100;
            } else {
                goto done;
            }
        } else if ((is_sign(token) || (token.type == TK_SYMBOL && token.value == ')')) && has_read_number) {
            goto done;
        }
    }

    /* DayComposer::Write */
    if (day.index < 1) goto done;
    while (day.index < 3) day.comp[day.index++] = 1;
    int year = 0, month, mday;
    if (day.named_month == NONE) {
        if (day.iso || !between(day.comp[0], 1, 31)) {
            year = day.comp[0];
            month = day.comp[1];
            mday = day.comp[2];
        } else {
            month = day.comp[0];
            mday = day.comp[1];
            year = day.comp[2];
        }
    } else {
        month = day.named_month;
        if (!between(day.comp[0], 1, 31)) {
            year = day.comp[0];
            mday = day.comp[1];
        } else {
            mday = day.comp[0];
            year = day.comp[1];
        }
    }
    if (!day.iso) {
        if (between(year, 0, 49)) year += 2000;
        else if (between(year, 50, 99)) year += 1900;
    }
    if (!between(month, 1, 12) || !between(mday, 1, 31)) goto done;
    /* TimeComposer::Write */
    while (time.index < 4) time.comp[time.index++] = 0;
    int hour = time.comp[0], minute = time.comp[1], second = time.comp[2], ms = time.comp[3];
    if (time.hour_offset != NONE) {
        if (!between(hour, 0, 12)) goto done;
        hour = hour % 12 + time.hour_offset;
    }
    if (!between(hour, 0, 23) || !between(minute, 0, 59) || !between(second, 0, 59) || !between(ms, 0, 999)) {
        if (hour != 24 || minute != 0 || second != 0 || ms != 0) goto done;
    }
    double t = make_date(make_day(year, month - 1, mday), make_time(hour, minute, second, ms));
    if (tz.sign != NONE) {  /* TimeZoneComposer::Write */
        double offset = (tz.hour == NONE ? 0 : tz.hour) * 3600.0 + (tz.minute == NONE ? 0 : tz.minute) * 60.0;
        result = t - tz.sign * offset * 1000;
    } else {
        result = utc_of(t);
    }
    result = time_clip(result);
done:
    free(units);
    return result;
}

/* ---- The constructor and its statics -------------------------------------------------------- */

static double now(void) { return floor(js_os_time_ms()); }

/* The year argument of the constructor and Date.UTC: 0..99 mean 1900..1999. */
static double full_year(double y) {
    if (isnan(y)) return y;
    double yi = to_integer(y);
    return yi >= 0 && yi <= 99 ? 1900 + yi : y;
}

/* MakeDate from (year, month, date, hours, minutes, seconds, ms) arguments, as numbers. */
static int date_from_args(JSContext *ctx, uint32_t argc, const JSValue *argv, double *out) {
    double v[7] = { NAN, 0, 1, 0, 0, 0, 0 };
    for (uint32_t i = 0; i < argc && i < 7; i++)
        if (js_to_number(ctx, &v[i], argv[i]) < 0) return -1;
    *out = make_date(make_day(full_year(v[0]), v[1], v[2]), make_time(v[3], v[4], v[5], v[6]));
    return 0;
}

/* Date(...) (§21.4.2.1) */
BUILTIN(date_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return format_value(ctx, now(), FMT_STRING);
    double tv;
    if (argc == 0) {
        tv = now();
    } else if (argc == 1) {
        JSValue value = argv[0];
        if (is_date(value)) {
            tv = ((DateObject *)js_as_object(value))->time;
        } else {
            JSValue p = js_to_primitive(ctx, value, JS_HINT_DEFAULT);
            if (js_is_exception(p)) return p;
            if (js_is_string(p)) tv = parse_date(ctx, p);
            else if (js_to_number(ctx, &tv, p) < 0) return JS_EXCEPTION;
        }
        tv = time_clip(tv);
    } else {
        if (date_from_args(ctx, argc, argv, &tv) < 0) return JS_EXCEPTION;
        tv = time_clip(utc_of(tv));
    }
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_DATE_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    DateObject *d = (DateObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &date_class, proto, 0));
    d->time = tv;
    return js_object_value(&d->obj);
}

BUILTIN(date_now) {
    UNUSED_ARGS;
    return js_number(now());
}

BUILTIN(date_parse) {
    UNUSED_ARGS;
    JSValue s = js_to_string(ctx, ARG(0));
    return js_is_exception(s) ? s : js_number(parse_date(ctx, s));
}

/* Date.UTC(year, month, …) (§21.4.3.4) */
BUILTIN(date_utc) {
    UNUSED_ARGS;
    double t;
    if (date_from_args(ctx, argc, argv, &t) < 0) return JS_EXCEPTION;
    return js_number(time_clip(t));
}

/* ---- Date.prototype ------------------------------------------------------------------------- */

static DateObject *this_date(JSContext *ctx, JSValue v, const char *method) {
    if (is_date(v)) return (DateObject *)js_as_object(v);
    if (!method) {
        js_discard(js_throw_type_error(ctx, "this is not a Date object."));
    } else {
        char what[64];
        js_describe_value(ctx, v, what, sizeof what);
        js_discard(js_throw_type_error(ctx, "Method Date.prototype.%s called on incompatible receiver %s", method, what));
    }
    return NULL;
}

enum { F_YEAR, F_MONTH, F_DATE, F_HOURS, F_MINUTES, F_SECONDS, F_MS, F_DAY, F_TIME, F_OFFSET };

static double field(double t, int which, bool local) {
    if (isnan(t)) return NAN;
    if (which == F_TIME) return t;
    if (which == F_OFFSET) return trunc((t - local_time(t)) / 60000);
    Fields f = fields_of(local ? local_time(t) : t);
    switch (which) {
    case F_YEAR: return f.year;
    case F_MONTH: return f.month;
    case F_DATE: return f.date;
    case F_HOURS: return f.hours;
    case F_MINUTES: return f.minutes;
    case F_SECONDS: return f.seconds;
    case F_MS: return f.ms;
    default: return f.weekday;
    }
}

#define GETTER(fn, which, local)                                       \
    BUILTIN(fn) {                                                      \
        UNUSED_ARGS;                                                   \
        DateObject *d = this_date(ctx, this_val, NULL);                \
        return d ? js_number(field(d->time, which, local)) : JS_EXCEPTION; \
    }
GETTER(date_get_time, F_TIME, false)
GETTER(date_get_timezone_offset, F_OFFSET, true)
GETTER(date_get_full_year, F_YEAR, true)
GETTER(date_get_month, F_MONTH, true)
GETTER(date_get_date, F_DATE, true)
GETTER(date_get_day, F_DAY, true)
GETTER(date_get_hours, F_HOURS, true)
GETTER(date_get_minutes, F_MINUTES, true)
GETTER(date_get_seconds, F_SECONDS, true)
GETTER(date_get_milliseconds, F_MS, true)
GETTER(date_get_utc_full_year, F_YEAR, false)
GETTER(date_get_utc_month, F_MONTH, false)
GETTER(date_get_utc_date, F_DATE, false)
GETTER(date_get_utc_day, F_DAY, false)
GETTER(date_get_utc_hours, F_HOURS, false)
GETTER(date_get_utc_minutes, F_MINUTES, false)
GETTER(date_get_utc_seconds, F_SECONDS, false)
GETTER(date_get_utc_milliseconds, F_MS, false)

/* getYear (Annex B.2.3.1) */
BUILTIN(date_get_year) {
    UNUSED_ARGS;
    DateObject *d = this_date(ctx, this_val, "getYear");
    return d ? js_number(field(d->time, F_YEAR, true) - 1900) : JS_EXCEPTION;
}

/* The setters (§21.4.4.20–28): fields first..first+max-1 from the arguments (at least one),
 * the rest from the current (local or UTC) time. setFullYear starts from +0 when invalid. */
static JSValue set_fields(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, int first, uint32_t max, bool local,
                          const char *method) {
    DateObject *d = this_date(ctx, this_val, method);
    if (!d) return JS_EXCEPTION;
    double t = d->time, v[4];
    uint32_t n = argc < 1 ? 1 : argc < max ? argc : max;
    for (uint32_t i = 0; i < n; i++)
        if (js_to_number(ctx, &v[i], i < argc ? argv[i] : JS_UNDEFINED) < 0) return JS_EXCEPTION;
    if (isnan(t)) {
        if (first != F_YEAR) return js_number(NAN);
        t = 0;
    } else if (local) {
        t = local_time(t);
    }
    Fields f = fields_of(t);
    double fs[7] = { f.year, f.month, f.date, f.hours, f.minutes, f.seconds, f.ms };
    for (uint32_t i = 0; i < n; i++) fs[first + (int)i] = v[i];
    double date = make_date(make_day(fs[0], fs[1], fs[2]), make_time(fs[3], fs[4], fs[5], fs[6]));
    d->time = time_clip(local ? utc_of(date) : date);
    return js_number(d->time);
}

#define SETTER(fn, first, max, local, name)                                              \
    BUILTIN(fn) {                                                                        \
        (void)callee, (void)new_target;                                                  \
        return set_fields(ctx, this_val, argc, argv, first, max, local, name);           \
    }
SETTER(date_set_full_year, F_YEAR, 3, true, "setFullYear")
SETTER(date_set_month, F_MONTH, 2, true, "setMonth")
SETTER(date_set_date, F_DATE, 1, true, "setDate")
SETTER(date_set_hours, F_HOURS, 4, true, "setHours")
SETTER(date_set_minutes, F_MINUTES, 3, true, "setMinutes")
SETTER(date_set_seconds, F_SECONDS, 2, true, "setSeconds")
SETTER(date_set_milliseconds, F_MS, 1, true, "setMilliseconds")
SETTER(date_set_utc_full_year, F_YEAR, 3, false, "setUTCFullYear")
SETTER(date_set_utc_month, F_MONTH, 2, false, "setUTCMonth")
SETTER(date_set_utc_date, F_DATE, 1, false, "setUTCDate")
SETTER(date_set_utc_hours, F_HOURS, 4, false, "setUTCHours")
SETTER(date_set_utc_minutes, F_MINUTES, 3, false, "setUTCMinutes")
SETTER(date_set_utc_seconds, F_SECONDS, 2, false, "setUTCSeconds")
SETTER(date_set_utc_milliseconds, F_MS, 1, false, "setUTCMilliseconds")

BUILTIN(date_set_time) {
    UNUSED_ARGS;
    DateObject *d = this_date(ctx, this_val, "setTime");
    if (!d) return JS_EXCEPTION;
    double t;
    if (js_to_number(ctx, &t, ARG(0)) < 0) return JS_EXCEPTION;
    d->time = time_clip(t);
    return js_number(d->time);
}

/* setYear (Annex B.2.3.2) */
BUILTIN(date_set_year) {
    UNUSED_ARGS;
    DateObject *d = this_date(ctx, this_val, "setYear");
    if (!d) return JS_EXCEPTION;
    double y;
    if (js_to_number(ctx, &y, ARG(0)) < 0) return JS_EXCEPTION;
    double t = isnan(d->time) ? 0 : local_time(d->time);
    if (isnan(y)) {
        d->time = NAN;
        return js_number(NAN);
    }
    Fields f = fields_of(t);
    double date = make_date(make_day(full_year(y), f.month, f.date), time_within_day(t));
    d->time = time_clip(utc_of(date));
    return js_number(d->time);
}

#define FORMATTER(fn, kind, name)                                       \
    BUILTIN(fn) {                                                       \
        UNUSED_ARGS;                                                    \
        DateObject *d = this_date(ctx, this_val, name);                 \
        return d ? format_value(ctx, d->time, kind) : JS_EXCEPTION;     \
    }
FORMATTER(date_to_string, FMT_STRING, "toString")
FORMATTER(date_to_date_string, FMT_DATE, "toDateString")
FORMATTER(date_to_time_string, FMT_TIME, "toTimeString")
FORMATTER(date_to_utc_string, FMT_UTC, "toUTCString")
FORMATTER(date_to_locale_string, FMT_LOCALE, "toLocaleString")
FORMATTER(date_to_locale_date_string, FMT_LOCALE_DATE, "toLocaleDateString")
FORMATTER(date_to_locale_time_string, FMT_LOCALE_TIME, "toLocaleTimeString")

BUILTIN(date_to_iso_string) {
    UNUSED_ARGS;
    DateObject *d = this_date(ctx, this_val, "toISOString");
    if (!d) return JS_EXCEPTION;
    if (isnan(d->time)) return js_throw_range_error(ctx, "Invalid time value");
    return format_value(ctx, d->time, FMT_ISO);
}

BUILTIN(date_value_of) {
    UNUSED_ARGS;
    DateObject *d = this_date(ctx, this_val, NULL);
    return d ? js_number(d->time) : JS_EXCEPTION;
}

/* toJSON(key) (§21.4.4.37) */
BUILTIN(date_to_json) {
    UNUSED_ARGS;
    JSValue o = js_to_object(ctx, this_val);
    if (js_is_exception(o)) return o;
    JSValue tv = js_to_primitive(ctx, o, JS_HINT_NUMBER);
    if (js_is_exception(tv)) return tv;
    if (js_is_number(tv) && !isfinite(js_as_number(tv))) return JS_NULL;
    JSValue f = js_get_value(ctx, o, js_atom_from_cstr(ctx, "toISOString"));
    if (js_is_exception(f)) return f;
    if (!js_is_callable(f)) return js_throw_type_error(ctx, "toISOString is not a function");
    return js_call(ctx, f, o, 0, NULL);
}

/* [@@toPrimitive](hint) (§21.4.4.45) */
BUILTIN(date_to_primitive) {
    UNUSED_ARGS;
    if (!js_is_object(this_val)) {
        char what[64];
        js_describe_value(ctx, this_val, what, sizeof what);
        return js_throw_type_error(ctx, "Method Date.prototype [ @@toPrimitive ] called on incompatible receiver %s", what);
    }
    JSValue hint = ARG(0);
    if (js_is_string(hint)) {
        if (js_string_equals(ctx, hint, JS_ATOM(string)) || js_string_equals(ctx, hint, JS_ATOM(default)))
            return js_ordinary_to_primitive(ctx, this_val, JS_HINT_STRING);
        if (js_string_equals(ctx, hint, JS_ATOM(number))) return js_ordinary_to_primitive(ctx, this_val, JS_HINT_NUMBER);
    }
    char what[64];
    js_describe_value(ctx, hint, what, sizeof what);
    return js_throw_type_error(ctx, "Invalid hint: %s", what);
}

/* util.inspect's view (inspect.c, through rt->date_inspect): the ISO string, or "Invalid Date". */
static JSValue date_inspect(JSContext *ctx, JSValue v) {
    if (!is_date(v)) return JS_EMPTY;
    double t = ((DateObject *)js_as_object(v))->time;
    return format_value(ctx, t, FMT_ISO);
}

/* ---- Realm ----------------------------------------------------------------------------------- */

static const JSBuiltin date_statics[] = {
    JS_BUILTIN_FN("now", date_now, 0),
    JS_BUILTIN_FN("parse", date_parse, 1),
    JS_BUILTIN_FN("UTC", date_utc, 7),
};

static const JSBuiltin date_proto[] = {  /* V8's order */
    JS_BUILTIN_FN("toString", date_to_string, 0),
    JS_BUILTIN_FN("toDateString", date_to_date_string, 0),
    JS_BUILTIN_FN("toTimeString", date_to_time_string, 0),
    JS_BUILTIN_FN("toISOString", date_to_iso_string, 0),
    JS_BUILTIN_FN("toUTCString", date_to_utc_string, 0),
    JS_BUILTIN_ALIAS("toGMTString", "toUTCString"),
    JS_BUILTIN_FN("getDate", date_get_date, 0),
    JS_BUILTIN_FN("setDate", date_set_date, 1),
    JS_BUILTIN_FN("getDay", date_get_day, 0),
    JS_BUILTIN_FN("getFullYear", date_get_full_year, 0),
    JS_BUILTIN_FN("setFullYear", date_set_full_year, 3),
    JS_BUILTIN_FN("getHours", date_get_hours, 0),
    JS_BUILTIN_FN("setHours", date_set_hours, 4),
    JS_BUILTIN_FN("getMilliseconds", date_get_milliseconds, 0),
    JS_BUILTIN_FN("setMilliseconds", date_set_milliseconds, 1),
    JS_BUILTIN_FN("getMinutes", date_get_minutes, 0),
    JS_BUILTIN_FN("setMinutes", date_set_minutes, 3),
    JS_BUILTIN_FN("getMonth", date_get_month, 0),
    JS_BUILTIN_FN("setMonth", date_set_month, 2),
    JS_BUILTIN_FN("getSeconds", date_get_seconds, 0),
    JS_BUILTIN_FN("setSeconds", date_set_seconds, 2),
    JS_BUILTIN_FN("getTime", date_get_time, 0),
    JS_BUILTIN_FN("setTime", date_set_time, 1),
    JS_BUILTIN_FN("getTimezoneOffset", date_get_timezone_offset, 0),
    JS_BUILTIN_FN("getUTCDate", date_get_utc_date, 0),
    JS_BUILTIN_FN("setUTCDate", date_set_utc_date, 1),
    JS_BUILTIN_FN("getUTCDay", date_get_utc_day, 0),
    JS_BUILTIN_FN("getUTCFullYear", date_get_utc_full_year, 0),
    JS_BUILTIN_FN("setUTCFullYear", date_set_utc_full_year, 3),
    JS_BUILTIN_FN("getUTCHours", date_get_utc_hours, 0),
    JS_BUILTIN_FN("setUTCHours", date_set_utc_hours, 4),
    JS_BUILTIN_FN("getUTCMilliseconds", date_get_utc_milliseconds, 0),
    JS_BUILTIN_FN("setUTCMilliseconds", date_set_utc_milliseconds, 1),
    JS_BUILTIN_FN("getUTCMinutes", date_get_utc_minutes, 0),
    JS_BUILTIN_FN("setUTCMinutes", date_set_utc_minutes, 3),
    JS_BUILTIN_FN("getUTCMonth", date_get_utc_month, 0),
    JS_BUILTIN_FN("setUTCMonth", date_set_utc_month, 2),
    JS_BUILTIN_FN("getUTCSeconds", date_get_utc_seconds, 0),
    JS_BUILTIN_FN("setUTCSeconds", date_set_utc_seconds, 2),
    JS_BUILTIN_FN("valueOf", date_value_of, 0),
    JS_BUILTIN_FN("getYear", date_get_year, 0),
    JS_BUILTIN_FN("setYear", date_set_year, 1),
    JS_BUILTIN_FN("toJSON", date_to_json, 1),
    JS_BUILTIN_FN("toLocaleString", date_to_locale_string, 0),
    JS_BUILTIN_FN("toLocaleDateString", date_to_locale_date_string, 0),
    JS_BUILTIN_FN("toLocaleTimeString", date_to_locale_time_string, 0),
    { NULL, &js_symbol_toPrimitive, JS_BUILTIN_KIND_FN, JS_PROP_CONFIGURABLE, 1, date_to_primitive, NULL, 0, NULL },
};

static void install_date(JSContext *ctx, JSObject *global) {
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 8);
    ctx->intrinsics[JS_INTRINSIC_DATE_PROTOTYPE] = proto;
    JSValue key = js_atom_from_cstr(ctx, "Date");
    JSValue c = js_new_native(ctx, date_ctor, key, 7, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_builtins(ctx, js_as_object(c), date_statics, JS_COUNTOF(date_statics));
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), date_proto, JS_COUNTOF(date_proto));
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
    ctx->rt->date_inspect = date_inspect;
}

const JSComponent js_component_date = { "date", install_date };
