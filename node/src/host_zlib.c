/* Host primitives for node:zlib: Node's zlib binding (src/node_zlib.cc, its
 * ZlibContext) over Chromium's zlib, the copy Node vendors, so a program compresses to the bytes
 * Node gives. A stream is a handle object; the prelude (node/prelude/zlib.js) is Node's lib/zlib.js
 * on these, and runs a write's callback a turn later, where Node's thread pool would. A failure is
 * returned as [message, errno, code], what Node's binding passes to the stream's onerror.
 *
 * Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE. */
#include <stdlib.h>
#include <string.h>

#include "js_buffer.h"
#include "js_exception.h"
#include "js_gc.h"
#include "js_node.h"
#include "js_object.h"
#include "js_ops.h"
#include "jsstring.h"
#include "zlib.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED_PRIMITIVE_ARGS (void)callee, (void)this_val, (void)new_target
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

/* Node's node_zlib_mode */
enum { NONE, DEFLATE, INFLATE, GZIP, GUNZIP, DEFLATERAW, INFLATERAW, UNZIP };

#define GZIP_HEADER_ID1 0x1f
#define GZIP_HEADER_ID2 0x8b

typedef struct ZlibObject {
    JSObject obj;
    z_stream strm;
    int      mode;
    int      level, window_bits, mem_level, strategy;
    int      flush;
    int      err;
    int      gzip_id_bytes_read;
    bool     zlib_init_done;
    uint8_t *dictionary;  /* malloc'd; NULL when empty */
    size_t   dictionary_len;
} ZlibObject;

static void zlib_end(ZlibObject *z) {
    if (z->zlib_init_done) {
        if (z->mode == DEFLATE || z->mode == GZIP || z->mode == DEFLATERAW) deflateEnd(&z->strm);
        else if (z->mode >= INFLATE) inflateEnd(&z->strm);
        z->zlib_init_done = false;
    }
    z->mode = NONE;
    free(z->dictionary);
    z->dictionary = NULL;
    z->dictionary_len = 0;
}

static void zlib_finalize(JSRuntime *rt, JSCell *cell) {
    (void)rt;
    zlib_end((ZlibObject *)cell);
}

static const JSClass zlib_class = { "Zlib", sizeof(ZlibObject), NULL, NULL, NULL, NULL, NULL, zlib_finalize, NULL };

static ZlibObject *zlib_arg(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &zlib_class ? (ZlibObject *)js_as_object(v) : NULL;
}

static int int_arg(JSValue v) { return js_is_number(v) ? (int)js_as_number(v) : 0; }

static const char *zlib_strerror(int err) {
    switch (err) {
    case Z_OK: return "Z_OK";
    case Z_STREAM_END: return "Z_STREAM_END";
    case Z_NEED_DICT: return "Z_NEED_DICT";
    case Z_ERRNO: return "Z_ERRNO";
    case Z_STREAM_ERROR: return "Z_STREAM_ERROR";
    case Z_DATA_ERROR: return "Z_DATA_ERROR";
    case Z_MEM_ERROR: return "Z_MEM_ERROR";
    case Z_BUF_ERROR: return "Z_BUF_ERROR";
    case Z_VERSION_ERROR: return "Z_VERSION_ERROR";
    default: return "Z_UNKNOWN_ERROR";
    }
}

/* ErrorForMessage: zlib's own message when it has one. */
static JSValue failure(JSContext *ctx, ZlibObject *z, const char *message) {
    if (z->strm.msg) message = z->strm.msg;
    JSValue items[3] = { js_new_string_cstr(ctx, message), js_int32(z->err), js_new_string_cstr(ctx, zlib_strerror(z->err)) };
    JSValue a = js_new_array(ctx, 3);
    for (int i = 0; i < 3; i++)
        if (js_array_append(ctx, a, items[i]) < 0) return JS_EXCEPTION;
    return a;
}

static int set_dictionary(ZlibObject *z) {
    if (!z->dictionary) return Z_OK;
    z->err = Z_OK;
    if (z->mode == DEFLATE || z->mode == DEFLATERAW) z->err = deflateSetDictionary(&z->strm, z->dictionary, (uInt)z->dictionary_len);
    /* the other inflates set it when inflate() asks for it */
    else if (z->mode == INFLATERAW) z->err = inflateSetDictionary(&z->strm, z->dictionary, (uInt)z->dictionary_len);
    return z->err;
}

/* InitZlib: true on the first call (z->err then tells whether it worked). */
static bool init_zlib(ZlibObject *z) {
    if (z->zlib_init_done) return false;
    switch (z->mode) {
    case DEFLATE: case GZIP: case DEFLATERAW:
        z->err = deflateInit2(&z->strm, z->level, Z_DEFLATED, z->window_bits, z->mem_level, z->strategy);
        break;
    case INFLATE: case GUNZIP: case INFLATERAW: case UNZIP:
        z->err = inflateInit2(&z->strm, z->window_bits);
        break;
    default:
        z->err = Z_STREAM_ERROR;
        break;
    }
    if (z->err != Z_OK) {
        free(z->dictionary);
        z->dictionary = NULL;
        z->dictionary_len = 0;
        z->mode = NONE;
        return true;
    }
    set_dictionary(z);
    z->zlib_init_done = true;
    return true;
}

static int reset_stream(ZlibObject *z) {
    z->err = Z_OK;
    switch (z->mode) {
    case DEFLATE: case DEFLATERAW: case GZIP: z->err = deflateReset(&z->strm); break;
    case INFLATE: case INFLATERAW: case GUNZIP: z->err = inflateReset(&z->strm); break;
    default: break;
    }
    return z->err;
}

/* DoThreadPoolWork: one deflate or inflate over the buffers set. */
static void process(ZlibObject *z) {
    if (init_zlib(z) && z->err != Z_OK) return;
    const Bytef *next_header_byte = NULL;
    switch (z->mode) {
    case DEFLATE: case GZIP: case DEFLATERAW:
        z->err = deflate(&z->strm, z->flush);
        return;
    case UNZIP:
        if (z->strm.avail_in > 0) next_header_byte = z->strm.next_in;
        if (z->gzip_id_bytes_read == 0 && next_header_byte) {
            if (*next_header_byte == GZIP_HEADER_ID1) {
                z->gzip_id_bytes_read = 1;
                next_header_byte++;
                if (z->strm.avail_in == 1) next_header_byte = NULL;  /* the only byte was read */
            } else {
                z->mode = INFLATE;
                next_header_byte = NULL;
            }
        }
        if (z->gzip_id_bytes_read == 1 && next_header_byte) {
            if (*next_header_byte == GZIP_HEADER_ID2) {
                z->gzip_id_bytes_read = 2;
                z->mode = GUNZIP;
            } else {
                z->mode = INFLATE;  /* INFLATE and INFLATERAW are the same once initialized */
            }
        }
        /* fall through */
    case INFLATE: case GUNZIP: case INFLATERAW:
        z->err = inflate(&z->strm, z->flush);
        if (z->mode != INFLATERAW && z->err == Z_NEED_DICT && z->dictionary) {
            z->err = inflateSetDictionary(&z->strm, z->dictionary, (uInt)z->dictionary_len);
            if (z->err == Z_OK) z->err = inflate(&z->strm, z->flush);
            else if (z->err == Z_DATA_ERROR) z->err = Z_NEED_DICT;  /* a bad dictionary, not bad input */
        }
        /* bytes after a gzip member: another member, or trailing garbage (zeros are padding) */
        while (z->strm.avail_in > 0 && z->mode == GUNZIP && z->err == Z_STREAM_END && z->strm.next_in[0] != 0x00) {
            reset_stream(z);
            z->err = inflate(&z->strm, z->flush);
        }
        return;
    default:
        return;
    }
}

/* GetErrorInfo: NULL when the stream's state is fine. */
static const char *error_message(ZlibObject *z) {
    switch (z->err) {
    case Z_OK:
    case Z_BUF_ERROR:
        if (z->strm.avail_out != 0 && z->flush == Z_FINISH) return "unexpected end of file";
        return NULL;
    case Z_STREAM_END:
        return NULL;
    case Z_NEED_DICT:
        return z->dictionary ? "Bad dictionary" : "Missing dictionary";
    default:
        return "Zlib error";
    }
}

/* zlib's memory is the heap's external memory: a deflate stream's is about
 * 256 KiB. */
static voidpf zlib_alloc(voidpf rt, uInt items, uInt size) { return js_gc_external_malloc(rt, (size_t)items * size); }
static void zlib_free(voidpf rt, voidpf p) { js_gc_external_free(rt, p); }

/* zlibNew(mode) → handle */
PRIMITIVE(js_host_zlib_new) {
    UNUSED_PRIMITIVE_ARGS;
    ZlibObject *z = (ZlibObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &zlib_class, JS_NULL, 0));
    memset(&z->strm, 0, sizeof z->strm);
    z->strm.zalloc = zlib_alloc;
    z->strm.zfree = zlib_free;
    z->strm.opaque = ctx->rt;
    z->mode = int_arg(ARG(0));
    z->flush = Z_NO_FLUSH;
    z->err = Z_OK;
    z->gzip_id_bytes_read = 0;
    z->zlib_init_done = false;
    z->dictionary = NULL;
    z->dictionary_len = 0;
    return js_object_value(&z->obj);
}

/* zlibInit(handle, windowBits, level, memLevel, strategy, dictionary | undefined): checked by the
 * prelude, as Node's lib/zlib.js checks them; zlib itself starts on the first write. */
PRIMITIVE(js_host_zlib_init) {
    UNUSED_PRIMITIVE_ARGS;
    ZlibObject *z = zlib_arg(ARG(0));
    if (!z) return js_throw_type_error(ctx, "zlibInit: a handle expected");
    z->window_bits = int_arg(ARG(1));
    z->level = int_arg(ARG(2));
    z->mem_level = int_arg(ARG(3));
    z->strategy = int_arg(ARG(4));
    z->flush = Z_NO_FLUSH;
    z->err = Z_OK;
    if (z->mode == GZIP || z->mode == GUNZIP) z->window_bits += 16;
    if (z->mode == UNZIP) z->window_bits += 32;
    if (z->mode == DEFLATERAW || z->mode == INFLATERAW) z->window_bits *= -1;
    uint8_t *p;
    size_t n;
    if (js_buffer_source_bytes(ARG(5), &p, &n) && n > 0) {
        z->dictionary = malloc(n);
        if (!z->dictionary) js_fatal("out of memory in zlib");
        memcpy(z->dictionary, p, n);
        z->dictionary_len = n;
    }
    return JS_UNDEFINED;
}

/* zlibWrite(handle, flush, in | null, inOff, inLen, out, outOff, outLen, state) → 0, with state
 * [availOut, availIn] after it, or a failure */
PRIMITIVE(js_host_zlib_write) {
    UNUSED_PRIMITIVE_ARGS;
    ZlibObject *z = zlib_arg(ARG(0));
    uint8_t *in = NULL, *out, *state;
    size_t in_n = 0, out_n, state_n;
    if (!z || (!js_is_null(ARG(2)) && !js_buffer_source_bytes(ARG(2), &in, &in_n)) || !js_buffer_source_bytes(ARG(5), &out, &out_n)
        || !js_buffer_source_bytes(ARG(8), &state, &state_n) || state_n < 2 * sizeof(uint32_t))
        return js_throw_type_error(ctx, "zlibWrite: a handle, buffers and a state expected");
    double in_off = in ? js_as_number(ARG(3)) : 0, in_len = in ? js_as_number(ARG(4)) : 0;
    double out_off = js_as_number(ARG(6)), out_len = js_as_number(ARG(7));
    if (!(in_off >= 0 && in_len >= 0 && in_off + in_len <= (double)in_n && out_off >= 0 && out_len >= 0 && out_off + out_len <= (double)out_n))
        return js_throw_range_error(ctx, "zlibWrite: out of bounds");
    z->strm.next_in = in ? in + (size_t)in_off : NULL;
    z->strm.avail_in = (uInt)in_len;
    z->strm.next_out = out + (size_t)out_off;
    z->strm.avail_out = (uInt)out_len;
    z->flush = int_arg(ARG(1));
    process(z);
    const char *message = error_message(z);
    if (message) return failure(ctx, z, message);
    uint32_t result[2] = { z->strm.avail_out, z->strm.avail_in };
    memcpy(state, result, sizeof result);
    return js_int32(0);
}

/* zlibParams(handle, level, strategy) → 0 | failure */
PRIMITIVE(js_host_zlib_params) {
    UNUSED_PRIMITIVE_ARGS;
    ZlibObject *z = zlib_arg(ARG(0));
    if (!z) return js_throw_type_error(ctx, "zlibParams: a handle expected");
    if (init_zlib(z) && z->err != Z_OK) return failure(ctx, z, "Failed to init stream before set parameters");
    z->err = Z_OK;
    if (z->mode == DEFLATE || z->mode == DEFLATERAW) z->err = deflateParams(&z->strm, int_arg(ARG(1)), int_arg(ARG(2)));
    if (z->err != Z_OK && z->err != Z_BUF_ERROR) return failure(ctx, z, "Failed to set parameters");
    return js_int32(0);
}

/* zlibReset(handle) → 0 | failure */
PRIMITIVE(js_host_zlib_reset) {
    UNUSED_PRIMITIVE_ARGS;
    ZlibObject *z = zlib_arg(ARG(0));
    if (!z) return js_throw_type_error(ctx, "zlibReset: a handle expected");
    if (init_zlib(z) && z->err != Z_OK) return failure(ctx, z, "Failed to init stream before reset");
    if (reset_stream(z) != Z_OK) return failure(ctx, z, "Failed to reset stream");
    if (set_dictionary(z) != Z_OK) return failure(ctx, z, "Failed to set dictionary");
    return js_int32(0);
}

/* zlibClose(handle): zlib's memory, now */
PRIMITIVE(js_host_zlib_close) {
    UNUSED_PRIMITIVE_ARGS;
    ZlibObject *z = zlib_arg(ARG(0));
    if (z) zlib_end(z);
    return JS_UNDEFINED;
}

/* zlibCrc32(data, value): a string's UTF-8, or the bytes */
PRIMITIVE(js_host_zlib_crc32) {
    UNUSED_PRIMITIVE_ARGS;
    uLong value = js_is_number(ARG(1)) ? (uLong)js_as_number(ARG(1)) : 0;
    uint8_t *p;
    size_t n;
    if (js_buffer_source_bytes(ARG(0), &p, &n)) return js_number((double)crc32(value, p, (uInt)n));
    if (!js_is_string(ARG(0))) return js_throw_type_error(ctx, "zlibCrc32: a string or bytes expected");
    JSStrView view = js_string_view(ctx, ARG(0));
    size_t len = js_view_to_utf8(view, NULL, 0);
    char *utf8 = malloc(len ? len : 1);
    if (!utf8) js_fatal("out of memory in zlib");
    js_view_to_utf8(view, utf8, len);
    value = crc32(value, (const Bytef *)utf8, (uInt)len);
    free(utf8);
    return js_number((double)value);
}
