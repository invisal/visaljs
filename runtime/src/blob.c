/* Blob and File (File API §3, §4), the blob component, as Node has them: a
 * blob keeps its bytes (a copy of its parts: strings as UTF-8, buffer sources, other blobs);
 * text(), arrayBuffer() and bytes() resolve with them, stream() is a ReadableStream of them
 * (the streams component). Node's errors and inspection (`Blob { size: 3, type: '' }`). */
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_promise.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"
#include "os.h"

/* A failure's -1, after the call that threw (the throwers' results must be used). */
static int fail(JSValue thrown) {
    (void)thrown;
    return -1;
}

typedef struct BlobObject {
    JSObject obj;
    uint8_t *data;     /* malloc'd, or NULL when empty */
    size_t   size;
    JSValue  type;     /* a string */
    JSValue  name;     /* File: a string; else undefined */
    double   last_modified;
} BlobObject;

static void blob_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((BlobObject *)c)->type);
    js_trace_value(trc, ((BlobObject *)c)->name);
}
static void blob_finalize(JSRuntime *rt, JSCell *c) {
    BlobObject *b = (BlobObject *)c;
    if (b->data) js_gc_external_sub(rt, b->size);
    free(b->data);
}

static const JSClass blob_class = { "Blob", sizeof(BlobObject), NULL, NULL, NULL, NULL, blob_visit, blob_finalize, NULL };

static BlobObject *as_blob(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &blob_class ? (BlobObject *)js_as_object(v) : NULL;
}

static JSValue new_blob(JSContext *ctx, JSValue proto, uint8_t *data, size_t size, JSValue type) {
    BlobObject *b = (BlobObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &blob_class, proto, 2));
    b->data = data;
    b->size = size;
    if (data) js_gc_external_add(ctx->rt, size);  /* the heap's external memory */
    js_init_slot(&b->type, type);
    js_init_slot(&b->name, JS_UNDEFINED);
    b->last_modified = 0;
    return js_object_value(&b->obj);
}

/* A type as the File API normalizes it: lowercased, or "" when it has a character outside U+0020–U+007E. */
static JSValue normalize_type(JSContext *ctx, JSValue t) {
    JSStrView v = js_string_view(ctx, t);
    uint8_t small[128];
    uint8_t *b = v.length <= sizeof small ? small : malloc(v.length);
    if (!b) js_fatal("out of memory");
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c < 0x20 || c > 0x7E) {
            if (b != small) free(b);
            return js_empty_string();
        }
        b[i] = (uint8_t)(c >= 'A' && c <= 'Z' ? c + 32 : c);
    }
    JSValue r = js_new_string_latin1(ctx, b, v.length);
    if (b != small) free(b);
    return r;
}

typedef struct {
    uint8_t *p;
    size_t   n, cap;
} Bytes;

static void put(Bytes *b, const uint8_t *p, size_t n) {
    if (b->n + n > b->cap) {
        size_t cap = b->cap ? b->cap : 64;
        while (cap < b->n + n) cap *= 2;
        uint8_t *q = realloc(b->p, cap);
        if (!q) js_fatal("out of memory building a Blob");
        b->p = q;
        b->cap = cap;
    }
    if (n) memcpy(b->p + b->n, p, n);
    b->n += n;
}

/* The parts' bytes: a sequence of strings, buffer sources and blobs. 0, or -1. */
static int collect_parts(JSContext *ctx, JSValue parts, const char *arg, Bytes *out) {
    if (js_is_undefined(parts)) return 0;
    JSValue method = js_is_object(parts) ? js_get_value(ctx, parts, JS_SYMBOL(iterator)) : JS_UNDEFINED;
    if (js_is_exception(method)) return -1;
    if (!js_is_callable(method)) return fail(js_throw_invalid_arg_type(ctx, arg, "a sequence", parts));
    JSValue rec = js_iter_start(ctx, parts);
    if (js_is_exception(rec)) return -1;
    for (;;) {
        JSValue part = js_iter_next(ctx, rec);
        if (js_is_exception(part)) return -1;
        if (js_is_empty(part)) break;
        uint8_t *p;
        size_t n;
        BlobObject *b = as_blob(part);
        if (b) {
            put(out, b->data, b->size);
        } else if (js_buffer_source_bytes(part, &p, &n)) {
            put(out, p, n);
        } else {
            JSValue s = js_to_string(ctx, part);
            if (js_is_exception(s)) return -1;
            JSStrView v = js_string_view(ctx, s);
            size_t len = js_view_to_utf8(v, NULL, 0);
            uint8_t *tmp = malloc(len ? len : 1);
            if (!tmp) js_fatal("out of memory building a Blob");
            js_view_to_utf8(v, (char *)tmp, len);
            put(out, tmp, len);
            free(tmp);
        }
    }
    return 0;
}

/* The options' type, normalized ("" when absent). */
static JSValue type_option(JSContext *ctx, JSValue options) {
    if (js_is_nullish(options)) return js_empty_string();
    if (!js_is_object(options)) return js_throw_invalid_arg_type(ctx, "options", "a dictionary", options);
    JSValue t = js_get_value(ctx, options, js_atom_from_cstr(ctx, "type"));
    if (js_is_exception(t)) return t;
    if (js_is_undefined(t)) return js_empty_string();
    JSValue s = js_to_string(ctx, t);
    return js_is_exception(s) ? s : normalize_type(ctx, s);
}

/* new Blob(sources, { type }) */
BUILTIN(blob_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "Blob");
    Bytes bytes = { 0 };
    if (collect_parts(ctx, ARG(0), "sources", &bytes) < 0) {
        free(bytes.p);
        return JS_EXCEPTION;
    }
    JSValue type = type_option(ctx, ARG(1));
    JSValue proto = js_is_exception(type) ? type : js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_BLOB_PROTOTYPE);
    if (js_is_exception(proto)) {
        free(bytes.p);
        return JS_EXCEPTION;
    }
    return new_blob(ctx, proto, bytes.p, bytes.n, type);
}

/* new File(fileBits, fileName, { type, lastModified }) */
BUILTIN(file_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "File");
    if (argc < 2) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS", "The \"fileBits\" and \"fileName\" arguments must be specified");
    Bytes bytes = { 0 };
    if (collect_parts(ctx, argv[0], "fileBits", &bytes) < 0) {
        free(bytes.p);
        return JS_EXCEPTION;
    }
    JSValue name = js_to_string(ctx, argv[1]);
    JSValue type = js_is_exception(name) ? name : type_option(ctx, ARG(2));
    double last_modified = js_os_time_ms();
    if (!js_is_exception(type) && js_is_object(ARG(2))) {
        JSValue lm = js_get_value(ctx, ARG(2), js_atom_from_cstr(ctx, "lastModified"));
        if (js_is_exception(lm) || (!js_is_undefined(lm) && js_to_number(ctx, &last_modified, lm) < 0)) type = JS_EXCEPTION;
        last_modified = isfinite(last_modified) ? trunc(last_modified) : 0;
    }
    JSValue proto = js_is_exception(type) ? type : js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_FILE_PROTOTYPE);
    if (js_is_exception(proto)) {
        free(bytes.p);
        return JS_EXCEPTION;
    }
    JSValue f = new_blob(ctx, proto, bytes.p, bytes.n, type);
    BlobObject *b = as_blob(f);
    js_store(ctx, &b->obj.cell, &b->name, name);
    b->last_modified = last_modified;
    return f;
}

#define THIS_BLOB()                        \
    BlobObject *b = as_blob(this_val);     \
    if (!b) return js_throw_invalid_this(ctx, "Blob")

BUILTIN(blob_size) {
    UNUSED_ARGS;
    THIS_BLOB();
    return js_number((double)b->size);
}

BUILTIN(blob_type) {
    UNUSED_ARGS;
    THIS_BLOB();
    return b->type;
}

BUILTIN(file_name) {
    UNUSED_ARGS;
    BlobObject *b = as_blob(this_val);
    if (!b || js_is_undefined(b->name)) return js_throw_type_error(ctx, "Cannot read private member #name from an object whose class did not declare it");
    return b->name;
}

BUILTIN(file_last_modified) {
    UNUSED_ARGS;
    BlobObject *b = as_blob(this_val);
    if (!b || js_is_undefined(b->name)) return js_throw_type_error(ctx, "Cannot read private member #lastModified from an object whose class did not declare it");
    return js_number(b->last_modified);
}

static size_t relative(double d, size_t size) {
    if (isnan(d)) return 0;
    d = trunc(d);
    if (d < 0) d += (double)size;
    return d < 0 ? 0 : d > (double)size ? size : (size_t)d;
}

/* slice(start, end, contentType) */
BUILTIN(blob_slice) {
    UNUSED_ARGS;
    THIS_BLOB();
    double start = 0, end = (double)b->size;
    if (!js_is_undefined(ARG(0)) && js_to_number(ctx, &start, ARG(0)) < 0) return JS_EXCEPTION;
    if (!js_is_undefined(ARG(1)) && js_to_number(ctx, &end, ARG(1)) < 0) return JS_EXCEPTION;
    JSValue type = js_empty_string();
    if (!js_is_undefined(ARG(2))) {
        JSValue s = js_to_string(ctx, ARG(2));
        if (js_is_exception(s)) return s;
        type = normalize_type(ctx, s);
    }
    size_t from = relative(start, b->size), to = relative(end, b->size);
    size_t n = to > from ? to - from : 0;
    uint8_t *data = n ? malloc(n) : NULL;
    if (n && !data) js_fatal("out of memory slicing a Blob");
    if (n) memcpy(data, b->data + from, n);
    return new_blob(ctx, ctx->intrinsics[JS_INTRINSIC_BLOB_PROTOTYPE], data, n, type);
}

static JSValue resolved(JSContext *ctx, JSValue v) {
    JSValue p = js_new_promise(ctx);
    if (js_is_exception(v)) js_promise_reject_internal(ctx, p, js_take_exception(ctx));
    else js_promise_resolve_internal(ctx, p, v);
    return p;
}

static JSValue rejected_invalid_this(JSContext *ctx) {
    JSValue e = js_throw_invalid_this(ctx, "Blob");
    (void)e;
    JSValue p = js_new_promise(ctx);
    js_promise_reject_internal(ctx, p, js_take_exception(ctx));
    return p;
}

BUILTIN(blob_text) {
    UNUSED_ARGS;
    BlobObject *b = as_blob(this_val);
    if (!b) return rejected_invalid_this(ctx);
    return resolved(ctx, js_decode_utf8_bytes(ctx, b->data, b->size));
}

BUILTIN(blob_array_buffer) {
    UNUSED_ARGS;
    BlobObject *b = as_blob(this_val);
    if (!b) return rejected_invalid_this(ctx);
    JSValue ab = js_new_array_buffer(ctx, b->size);
    if (!js_is_exception(ab) && b->size) memcpy(js_as_array_buffer(ab)->data, b->data, b->size);
    return resolved(ctx, ab);
}

BUILTIN(blob_bytes) {
    UNUSED_ARGS;
    BlobObject *b = as_blob(this_val);
    if (!b) return rejected_invalid_this(ctx);
    JSValue u8 = js_new_uint8_array(ctx, b->size);
    if (!js_is_exception(u8) && b->size) {
        uint8_t *p;
        size_t n;
        js_buffer_source_bytes(u8, &p, &n);
        memcpy(p, b->data, b->size);
    }
    return resolved(ctx, u8);
}

BUILTIN(blob_stream) {
    UNUSED_ARGS;
    THIS_BLOB();
    JSValue u8 = js_new_uint8_array(ctx, b->size);
    if (js_is_exception(u8)) return u8;
    if (b->size) {
        uint8_t *p;
        size_t n;
        js_buffer_source_bytes(u8, &p, &n);
        memcpy(p, b->data, b->size);
    }
    return js_readable_stream_of_bytes(ctx, b->size ? u8 : JS_UNDEFINED);
}

/* `Blob { size: 3, type: '' }`, `File { size: 2, type: '', name: 'a.txt', lastModified: 5 }` */
BUILTIN(blob_inspect) {
    UNUSED_ARGS;
    THIS_BLOB();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "size"), js_number((double)b->size), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "type"), b->type, JS_PROP_DEFAULT);
    if (!js_is_undefined(b->name)) {
        js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "name"), b->name, JS_PROP_DEFAULT);
        js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "lastModified"), js_number(b->last_modified), JS_PROP_DEFAULT);
    }
    return js_inspect_as(ctx, this_val, js_is_undefined(b->name) ? "Blob" : "File", o, ARG(0), ARG(1));
}

/* ---- C callers (the fetch component) -------------------------------------------------------- */

bool js_is_blob(JSValue v) { return as_blob(v) != NULL; }

void js_blob_bytes(JSValue v, const uint8_t **data, size_t *size, JSValue *type) {
    BlobObject *b = as_blob(v);
    *data = b->data;
    *size = b->size;
    *type = b->type;
}

JSValue js_new_blob(JSContext *ctx, const uint8_t *p, size_t n, JSValue type) {
    uint8_t *data = n ? malloc(n) : NULL;
    if (n && !data) js_fatal("out of memory making a Blob");
    if (n) memcpy(data, p, n);
    return new_blob(ctx, ctx->intrinsics[JS_INTRINSIC_BLOB_PROTOTYPE], data, n, normalize_type(ctx, type));
}

/* ---- Realm ---------------------------------------------------------------------------------- */

static const JSBuiltin blob_proto[] = {
    WEBIDL_ATTRIBUTE("type", blob_type, NULL),
    WEBIDL_ATTRIBUTE("size", blob_size, NULL),
    WEBIDL_OPERATION("slice", blob_slice, 0),
    WEBIDL_OPERATION("arrayBuffer", blob_array_buffer, 0),
    WEBIDL_OPERATION("text", blob_text, 0),
    WEBIDL_OPERATION("bytes", blob_bytes, 0),
    WEBIDL_OPERATION("stream", blob_stream, 0),
};

static const JSBuiltin file_proto[] = {
    WEBIDL_ATTRIBUTE("name", file_name, NULL),
    WEBIDL_ATTRIBUTE("lastModified", file_last_modified, NULL),
};

static void install_blob(JSContext *ctx, JSObject *global) {
    JSValue blob = js_define_web_class(ctx, global, "Blob", blob_ctor, 0, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], JS_INTRINSIC_BLOB_PROTOTYPE);
    JSValue bp = ctx->intrinsics[JS_INTRINSIC_BLOB_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(bp), blob_proto, JS_COUNTOF(blob_proto));
    js_define_inspect(ctx, bp, blob_inspect, "Blob");

    JSValue file = js_define_web_class(ctx, global, "File", file_ctor, 2, bp, JS_INTRINSIC_FILE_PROTOTYPE);
    if (js_set_prototype_of(ctx, js_as_object(file), blob) < 0) js_discard(js_take_exception(ctx));
    JSValue fp = ctx->intrinsics[JS_INTRINSIC_FILE_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(fp), file_proto, JS_COUNTOF(file_proto));
    js_define_data(ctx, js_as_object(fp), JS_SYMBOL(toStringTag), js_new_string_cstr(ctx, "File"), JS_PROP_CONFIGURABLE);
}

const JSComponent js_component_blob = { "blob", install_blob };
