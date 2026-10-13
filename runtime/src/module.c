/* Module-level host behavior: import.meta, one object per original file, and
 * import() of a specifier the bundler couldn't resolve at build time. Errors and URLs
 * follow Node: ERR_MODULE_NOT_FOUND, file: URLs percent-encoded like the WHATWG URL parser. */
#include "js_module.h"

#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_exception.h"
#include "js_promise.h"
#include "js_symbol.h"
#include "jsstring.h"

/* ---- A growable UTF-8 buffer ------------------------------------------- */

typedef struct {
    char *s;
    size_t len, cap;
} Buf;

static void put(Buf *b, const char *s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 128;
        while (cap < b->len + n + 1) cap *= 2;
        char *grown = realloc(b->s, cap);
        if (!grown) js_fatal("out of memory");
        b->s = grown;
        b->cap = cap;
    }
    memcpy(b->s + b->len, s, n);
    b->len += n;
    b->s[b->len] = '\0';
}

static void puts_(Buf *b, const char *s) { put(b, s, strlen(s)); }

/* Characters of a URL path the WHATWG parser percent-encodes (the path percent-encode set),
 * and in the query and fragment (`in_path` false: the fragment set, which the query's covers). */
static bool needs_encoding(unsigned char c, bool in_path) {
    if (c <= 0x20 || c >= 0x7F) return true;
    switch (c) {
    case '"': case '<': case '>': case '`': return true;
    case '#': case '?': case '{': case '}': return in_path;
    default: return false;
    }
}

static void put_encoded(Buf *b, const char *s, size_t n, bool in_path) {
    static const char HEX[] = "0123456789ABCDEF";
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (needs_encoding(c, in_path)) {
            char esc[3] = { '%', HEX[c >> 4], HEX[c & 15] };
            put(b, esc, 3);
        } else {
            put(b, (const char *)&c, 1);
        }
    }
}

/* Appends `path` (absolute, '/'-separated) with its dot segments removed, as the WHATWG URL
 * parser does: `.` is dropped, `..` drops the segment before it, and either one at the end
 * leaves a trailing slash. Empty segments (`a//b`) stay. */
static void put_normalized_path(Buf *b, const char *path, size_t n) {
    size_t base = b->len;
    size_t i = path[0] == '/' ? 1 : 0;
    for (;;) {
        size_t start = i;
        while (i < n && path[i] != '/') i++;
        size_t len = i - start;
        bool last = i >= n;
        if (len == 2 && path[start] == '.' && path[start + 1] == '.') {
            if (b->len > base) {                   /* drop "/segment" */
                while (b->s[b->len - 1] != '/') b->len--;
                b->len--;
            }
            if (last) put(b, "/", 1);
        } else if (len == 1 && path[start] == '.') {
            if (last) put(b, "/", 1);
        } else {
            put(b, "/", 1);
            put(b, path + start, len);
        }
        if (last) break;
        i++;  /* past the '/' */
    }
    if (b->len == base) put(b, "/", 1);
    b->s[b->len] = '\0';
}

/* The file: URL of an absolute path. */
static void put_file_url(Buf *b, const char *path) {
    puts_(b, "file://");
    put_encoded(b, path, strlen(path), true);
}

static char *utf8_of(JSContext *ctx, JSValue s) {
    JSStrView v = js_string_view(ctx, s);
    size_t n = js_view_to_utf8(v, NULL, 0);
    char *out = malloc(n + 1);
    if (!out) js_fatal("out of memory");
    js_view_to_utf8(v, out, n);
    out[n] = '\0';
    return out;
}

static bool starts_with(const char *s, const char *prefix) {
    return strncmp(s, prefix, strlen(prefix)) == 0;
}

/* A URL scheme followed by ':' (`file:`, `https:`; not a Windows drive letter's one character). */
static size_t scheme_length(const char *s) {
    if (!((s[0] >= 'a' && s[0] <= 'z') || (s[0] >= 'A' && s[0] <= 'Z'))) return 0;
    size_t i = 1;
    while ((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= '0' && s[i] <= '9') ||
           s[i] == '+' || s[i] == '-' || s[i] == '.')
        i++;
    return s[i] == ':' && i > 1 ? i : 0;
}

/* Node built-in modules visaljs provides as bare names (node/prelude). */
static const char *const HOST_MODULES[] = { "fs", "path", "util" };

/* ERR_MODULE_NOT_FOUND, as Node words it. */
static JSValue not_found(JSContext *ctx, const char *what, const char *name, const char *importer) {
    Buf b = { 0 };
    puts_(&b, "Cannot find ");
    puts_(&b, what);
    puts_(&b, " '");
    puts_(&b, name);
    puts_(&b, "' imported from ");
    puts_(&b, importer);
    JSValue msg = js_new_string_utf8(ctx, b.s, b.len);
    free(b.s);
    if (js_is_exception(msg)) return msg;
    JSValue err = js_new_error(ctx, JS_ERROR, msg);
    if (js_is_exception(err)) return err;
    JSValue code = js_new_string_cstr(ctx, "ERR_MODULE_NOT_FOUND");
    if (js_is_exception(code)) return code;
    js_define_data(ctx, js_as_object(err), js_atom_from_cstr(ctx, "code"), code, JS_PROP_DEFAULT);
    return err;
}

/* Resolves a specifier against the module at `importer` (an absolute path), into `out`.
 * 0, or -1 with *error set (ERR_MODULE_NOT_FOUND for packages, which only the bundler resolves). */
static int resolve_specifier(JSContext *ctx, const char *spec, const char *importer, Buf *out, JSValue *error) {
    if (starts_with(spec, "node:")) {
        puts_(out, spec);
        return 0;
    }
    for (size_t i = 0; i < sizeof HOST_MODULES / sizeof HOST_MODULES[0]; i++) {
        if (strcmp(spec, HOST_MODULES[i]) == 0) {
            puts_(out, "node:");
            puts_(out, spec);
            return 0;
        }
    }
    bool relative = strcmp(spec, ".") == 0 || strcmp(spec, "..") == 0 || starts_with(spec, "./") ||
                    starts_with(spec, "../") || spec[0] == '/';
    size_t scheme = scheme_length(spec);
    if (!relative && !scheme) {
        /* a package: its name is the first segment (two for a scope, @scope/name) */
        const char *slash = strchr(spec, '/');
        if (spec[0] == '@' && slash) slash = strchr(slash + 1, '/');
        size_t n = slash ? (size_t)(slash - spec) : strlen(spec);
        char *name = malloc(n + 1);
        if (!name) js_fatal("out of memory");
        memcpy(name, spec, n);
        name[n] = '\0';
        *error = not_found(ctx, "package", name, importer);
        free(name);
        return -1;
    }
    const char *rest;
    Buf path = { 0 };
    if (scheme) {
        /* an absolute URL: scheme://authority kept, its path normalized */
        const char *p = spec + scheme + 1;
        size_t prefix = scheme + 1;
        if (p[0] == '/' && p[1] == '/') {
            const char *end = p + 2;
            while (*end && *end != '/' && *end != '?' && *end != '#') end++;
            prefix = (size_t)(end - spec);
        }
        put(out, spec, prefix);
        const char *path_start = spec + prefix;
        rest = path_start + strcspn(path_start, "?#");
        put(&path, path_start, (size_t)(rest - path_start));
        if (path.len == 0) put(&path, "/", 1);
    } else {
        puts_(out, "file://");
        rest = spec + strcspn(spec, "?#");
        if (spec[0] != '/') {
            /* the importer's directory, then the specifier */
            const char *dir_end = strrchr(importer, '/');
            put(&path, importer, dir_end ? (size_t)(dir_end - importer) + 1 : 0);
        }
        put(&path, spec, (size_t)(rest - spec));
    }
    for (size_t i = 0; i < path.len; i++)
        if (path.s[i] == '\\') path.s[i] = '/';  /* special schemes treat backslashes as slashes */
    Buf normalized = { 0 };
    put_normalized_path(&normalized, path.s, path.len);
    put_encoded(out, normalized.s, normalized.len, !scheme || starts_with(spec, "file:"));
    put_encoded(out, rest, strlen(rest), false);
    free(path.s);
    free(normalized.s);
    return 0;
}

/* import.meta.resolve(specifier): the module's path is the function's home_object. */
static JSValue meta_resolve(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                            const JSValue *argv, JSValue new_target) {
    (void)this_val, (void)new_target;
    JSValue s = js_to_string(ctx, argc ? argv[0] : JS_UNDEFINED);
    if (js_is_exception(s)) return s;
    char *spec = utf8_of(ctx, s);
    char *importer = utf8_of(ctx, js_as_function(callee)->home_object);
    Buf out = { 0 };
    JSValue error = JS_UNDEFINED;
    int r = resolve_specifier(ctx, spec, importer, &out, &error);
    free(spec);
    free(importer);
    if (r < 0) {
        free(out.s);
        return js_is_exception(error) ? error : js_throw(ctx, error);
    }
    JSValue result = js_new_string_utf8(ctx, out.s, out.len);
    free(out.s);
    return result;
}

JSValue js_import_meta(JSContext *ctx, JSValue *cache, const char *file, bool main) {
    if (js_is_object(*cache)) return *cache;
    JSValue meta = js_new_object_proto(ctx, JS_NULL, 5);
    if (js_is_exception(meta)) return meta;
    JSObject *o = js_as_object(meta);
    const char *slash = strrchr(file, '/');
    size_t dir_len = slash == file ? 1 : slash ? (size_t)(slash - file) : 0;
    JSValue path = js_new_string_cstr(ctx, file);
    if (js_is_exception(path)) return path;
    JSValue dirname = js_new_string_utf8(ctx, file, dir_len);
    if (js_is_exception(dirname)) return dirname;
    Buf url = { 0 };
    put_file_url(&url, file);
    JSValue href = js_new_string_utf8(ctx, url.s, url.len);
    free(url.s);
    if (js_is_exception(href)) return href;
    js_define_data(ctx, o, js_atom_from_cstr(ctx, "dirname"), dirname, JS_PROP_DEFAULT);
    js_define_data(ctx, o, js_atom_from_cstr(ctx, "filename"), path, JS_PROP_DEFAULT);
    js_define_data(ctx, o, js_atom_from_cstr(ctx, "main"), js_bool(main), JS_PROP_DEFAULT);
    JSValue resolve = js_new_native(ctx, meta_resolve, js_atom_from_cstr(ctx, "resolve"), 1, JS_FN_STRICT);
    if (js_is_exception(resolve)) return resolve;
    js_set_home_object(ctx, resolve, path);
    js_define_data(ctx, o, js_atom_from_cstr(ctx, "resolve"), resolve, JS_PROP_DEFAULT);
    js_define_data(ctx, o, js_atom_from_cstr(ctx, "url"), href, JS_PROP_DEFAULT);
    *cache = meta;
    return meta;
}

/* Rejects `promise` with the pending exception; returns it. */
static JSValue reject_pending(JSContext *ctx, JSValue promise) {
    js_promise_reject_internal(ctx, promise, js_take_exception(ctx));
    return promise;
}

static JSValue reject_type_error(JSContext *ctx, JSValue promise, const char *message) {
    JSValue e = js_throw_type_error(ctx, "%s", message);
    (void)e;
    return reject_pending(ctx, promise);
}

/* §13.3.10.1 EvaluateImportCall, after the arguments are evaluated: the specifier and the
 * options are checked as the spec says (each failure rejects, with V8's messages), then the
 * module, which can't be in the program (the bundler inlines every import() it can resolve),
 * isn't found. */
JSValue js_dynamic_import(JSContext *ctx, JSValue specifier, JSValue options, const char *importer) {
    JSValue promise = js_new_promise(ctx);
    if (js_is_exception(promise)) return promise;
    JSValue s = js_to_string(ctx, specifier);
    if (js_is_exception(s)) return reject_pending(ctx, promise);
    if (!js_is_undefined(options)) {
        if (!js_is_object(options)) return reject_type_error(ctx, promise, "The second argument to import() must be an object");
        JSValue with = js_get(ctx, js_as_object(options), js_atom_from_cstr(ctx, "with"), options);
        if (js_is_exception(with)) return reject_pending(ctx, promise);
        if (!js_is_undefined(with)) {
            if (!js_is_object(with)) return reject_type_error(ctx, promise, "The 'assert' option must be an object");
            JSValue keys = js_own_keys(ctx, js_as_object(with));
            if (js_is_exception(keys)) return reject_pending(ctx, promise);
            JSValueArray *list = (JSValueArray *)js_as_cell(keys);
            for (uint32_t i = 0; i < list->cell.aux; i++) {
                JSValue key = list->values[i];
                if (js_is_symbol(key)) continue;
                JSPropertyDescriptor desc;
                int has = js_get_own_property(ctx, js_as_object(with), key, &desc);
                if (has < 0) return reject_pending(ctx, promise);
                if (!has || !(desc.attrs & JS_PROP_ENUMERABLE)) continue;
                JSValue v = js_get(ctx, js_as_object(with), key, with);
                if (js_is_exception(v)) return reject_pending(ctx, promise);
                if (!js_is_string(v)) return reject_type_error(ctx, promise, "Import assertion value must be a string");
            }
        }
    }
    char *spec = utf8_of(ctx, s);
    Buf out = { 0 };
    JSValue error = JS_UNDEFINED;
    if (resolve_specifier(ctx, spec, importer, &out, &error) == 0) {
        /* a file: Node names its path; anything else (node:os, https:) its URL */
        const char *name = out.s;
        Buf decoded = { 0 };
        if (starts_with(out.s, "file://")) {
            for (const char *p = out.s + 7; *p; p++) {
                if (p[0] == '%' && p[1] && p[2]) {
                    char hex[3] = { p[1], p[2], 0 };
                    char c = (char)strtol(hex, NULL, 16);
                    put(&decoded, &c, 1);
                    p += 2;
                } else {
                    put(&decoded, p, 1);
                }
            }
            name = decoded.s ? decoded.s : "";
        }
        error = not_found(ctx, "module", name, importer);
        free(decoded.s);
    }
    free(spec);
    free(out.s);
    if (js_is_exception(error)) return reject_pending(ctx, promise);
    js_promise_reject_internal(ctx, promise, error);
    return promise;
}
