/* Host primitives for node:zlib's Brotli streams: Node's binding (src/node_zlib.cc, its
 * BrotliEncoderContext and BrotliDecoderContext) over Brotli 1.1.0, the copy Node vendors. As
 * host_zlib.c: a stream is a handle object, and a failure is [message, errno, code]. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "brotli/decode.h"
#include "brotli/encode.h"
#include "js_buffer.h"
#include "js_exception.h"
#include "js_gc.h"
#include "js_node.h"
#include "js_web.h"
#include "js_object.h"
#include "js_ops.h"
#include "jsstring.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED_PRIMITIVE_ARGS (void)callee, (void)this_val, (void)new_target
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

/* Node's node_zlib_mode */
enum { BROTLI_DECODE = 8, BROTLI_ENCODE = 9 };

typedef struct BrotliObject {
    JSObject                  obj;
    int                       mode;
    BrotliEncoderState       *encoder;
    BrotliDecoderState       *decoder;
    int                       flush;
    bool                      encode_result;  /* the encoder's last result */
    BrotliDecoderResult       decode_result;
    BrotliDecoderErrorCode    error;
    JSRuntime                *rt;             /* the allocator's */
    uint8_t                  *dictionary;     /* malloc'd; NULL when none (it outlives what uses it) */
    size_t                    dictionary_len;
    BrotliEncoderPreparedDictionary *prepared;  /* the encoder's, from the dictionary */
} BrotliObject;

/* Brotli's memory is the heap's external memory. */
static void *brotli_alloc(void *rt, size_t n) { return js_gc_external_malloc(rt, n); }
static void brotli_free(void *rt, void *p) { js_gc_external_free(rt, p); }

static void brotli_end(BrotliObject *b) {
    if (b->encoder) BrotliEncoderDestroyInstance(b->encoder);
    if (b->decoder) BrotliDecoderDestroyInstance(b->decoder);
    if (b->prepared) BrotliEncoderDestroyPreparedDictionary(b->prepared);
    free(b->dictionary);
    b->encoder = NULL;
    b->decoder = NULL;
    b->prepared = NULL;
    b->dictionary = NULL;
    b->dictionary_len = 0;
}

static void brotli_finalize(JSRuntime *rt, JSCell *cell) {
    (void)rt;
    brotli_end((BrotliObject *)cell);
}

static const JSClass brotli_class = { "BrotliHandle", sizeof(BrotliObject), NULL, NULL, NULL, NULL, NULL, brotli_finalize, NULL };

static BrotliObject *brotli_arg(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &brotli_class ? (BrotliObject *)js_as_object(v) : NULL;
}

static JSValue failure(JSContext *ctx, const char *message, int err, const char *code) {
    JSValue items[3] = { js_new_string_cstr(ctx, message), js_int32(err), js_new_string_cstr(ctx, code) };
    JSValue a = js_new_array(ctx, 3);
    for (int i = 0; i < 3; i++)
        if (js_array_append(ctx, a, items[i]) < 0) return JS_EXCEPTION;
    return a;
}

/* Init (and ResetStream, which is Init again: the parameters and the dictionary set before are
 * gone, as in Node), with a raw shared dictionary when one is given: NULL, or a failure's message
 * (its code in *code) */
static const char *brotli_init(BrotliObject *b, const uint8_t *dictionary, size_t dictionary_len, const char **code) {
    brotli_end(b);
    *code = "ERR_ZLIB_INITIALIZATION_FAILED";
    if (b->mode == BROTLI_ENCODE) b->encoder = BrotliEncoderCreateInstance(brotli_alloc, brotli_free, b->rt);
    else b->decoder = BrotliDecoderCreateInstance(brotli_alloc, brotli_free, b->rt);
    if (!b->encoder && !b->decoder) return "Could not initialize Brotli instance";
    if (!dictionary_len) return NULL;
    b->dictionary = malloc(dictionary_len);
    if (!b->dictionary) js_fatal("out of memory in Brotli");
    memcpy(b->dictionary, dictionary, dictionary_len);
    b->dictionary_len = dictionary_len;
    *code = "ERR_ZLIB_DICTIONARY_LOAD_FAILED";
    if (b->encoder) {
        b->prepared = BrotliEncoderPrepareDictionary(BROTLI_SHARED_DICTIONARY_RAW, dictionary_len, b->dictionary, BROTLI_MAX_QUALITY,
                                                     brotli_alloc, brotli_free, b->rt);
        if (!b->prepared) return "Failed to prepare brotli dictionary";
        if (!BrotliEncoderAttachPreparedDictionary(b->encoder, b->prepared)) return "Failed to attach brotli dictionary";
    } else if (!BrotliDecoderAttachDictionary(b->decoder, BROTLI_SHARED_DICTIONARY_RAW, dictionary_len, b->dictionary)) {
        return "Failed to attach brotli dictionary";
    }
    return NULL;
}

/* brotliNew(mode) → handle */
PRIMITIVE(js_host_brotli_new) {
    UNUSED_PRIMITIVE_ARGS;
    BrotliObject *b = (BrotliObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &brotli_class, JS_NULL, 0));
    b->mode = js_is_number(ARG(0)) && js_as_number(ARG(0)) == BROTLI_ENCODE ? BROTLI_ENCODE : BROTLI_DECODE;
    b->encoder = NULL;
    b->decoder = NULL;
    b->rt = ctx->rt;
    b->dictionary = NULL;
    b->dictionary_len = 0;
    b->prepared = NULL;
    b->flush = BROTLI_OPERATION_PROCESS;
    b->encode_result = false;
    b->decode_result = BROTLI_DECODER_RESULT_SUCCESS;
    b->error = BROTLI_DECODER_NO_ERROR;
    return js_object_value(&b->obj);
}

/* brotliInit(handle, params, dictionary | undefined): params a Uint32Array, by parameter number,
 * 0xffffffff unset; the dictionary a raw shared one →
 * 0 | failure */
PRIMITIVE(js_host_brotli_init) {
    UNUSED_PRIMITIVE_ARGS;
    BrotliObject *b = brotli_arg(ARG(0));
    uint8_t *p;
    size_t n;
    if (!b || !js_buffer_source_bytes(ARG(1), &p, &n)) return js_throw_type_error(ctx, "brotliInit: a handle and parameters expected");
    uint8_t *dict = NULL;
    size_t dict_len = 0;
    if (!js_is_undefined(ARG(2))) js_buffer_source_bytes(ARG(2), &dict, &dict_len);
    const char *code;
    const char *message = brotli_init(b, dict, dict_len, &code);
    if (message) return failure(ctx, message, -1, code);
    for (size_t i = 0; i < n / sizeof(uint32_t); i++) {
        uint32_t value;
        memcpy(&value, p + i * sizeof value, sizeof value);
        if (value == UINT32_MAX) continue;
        bool ok = b->encoder ? BrotliEncoderSetParameter(b->encoder, (BrotliEncoderParameter)i, value)
                             : BrotliDecoderSetParameter(b->decoder, (BrotliDecoderParameter)i, value);
        if (!ok) return failure(ctx, "Setting parameter failed", -1, "ERR_BROTLI_PARAM_SET_FAILED");
    }
    return js_int32(0);
}

/* brotliWrite(handle, flush, in | null, inOff, inLen, out, outOff, outLen, state) → 0, with state
 * [availOut, availIn] after it, or a failure */
PRIMITIVE(js_host_brotli_write) {
    UNUSED_PRIMITIVE_ARGS;
    BrotliObject *b = brotli_arg(ARG(0));
    uint8_t *in = NULL, *out, *state;
    size_t in_n = 0, out_n, state_n;
    if (!b || (!b->encoder && !b->decoder) || (!js_is_null(ARG(2)) && !js_buffer_source_bytes(ARG(2), &in, &in_n))
        || !js_buffer_source_bytes(ARG(5), &out, &out_n) || !js_buffer_source_bytes(ARG(8), &state, &state_n) || state_n < 2 * sizeof(uint32_t))
        return js_throw_type_error(ctx, "brotliWrite: a handle, buffers and a state expected");
    double in_off = in ? js_as_number(ARG(3)) : 0, in_len = in ? js_as_number(ARG(4)) : 0;
    double out_off = js_as_number(ARG(6)), out_len = js_as_number(ARG(7));
    /* node_zlib.cc's checks */
    if (!(in_off >= 0 && in_len >= 0 && in_off + in_len <= (double)in_n))
        return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "input buffer is out of bounds");
    if (!(out_off >= 0 && out_len >= 0 && out_off + out_len <= (double)out_n))
        return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "output buffer is out of bounds");
    const uint8_t *next_in = in ? in + (size_t)in_off : NULL;
    uint8_t *next_out = out + (size_t)out_off;
    size_t avail_in = (size_t)in_len, avail_out = (size_t)out_len;
    b->flush = js_is_number(ARG(1)) ? (int)js_as_number(ARG(1)) : BROTLI_OPERATION_PROCESS;
    if (b->encoder) {
        b->encode_result = BrotliEncoderCompressStream(b->encoder, (BrotliEncoderOperation)b->flush, &avail_in, &next_in, &avail_out, &next_out, NULL);
        if (!b->encode_result) return failure(ctx, "Compression failed", -1, "ERR_BROTLI_COMPRESSION_FAILED");
    } else {
        b->decode_result = BrotliDecoderDecompressStream(b->decoder, &avail_in, &next_in, &avail_out, &next_out, NULL);
        if (b->decode_result == BROTLI_DECODER_RESULT_ERROR) b->error = BrotliDecoderGetErrorCode(b->decoder);
        if (b->error != BROTLI_DECODER_NO_ERROR) {
            char code[64];
            snprintf(code, sizeof code, "ERR_%s", BrotliDecoderErrorString(b->error));
            return failure(ctx, "Decompression failed", (int)b->error, code);
        }
        /* zlib's error for it: Brotli has none of its own */
        if (b->flush == BROTLI_OPERATION_FINISH && b->decode_result == BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT)
            return failure(ctx, "unexpected end of file", -5, "Z_BUF_ERROR");
    }
    uint32_t result[2] = { (uint32_t)avail_out, (uint32_t)avail_in };
    memcpy(state, result, sizeof result);
    return js_int32(0);
}

/* brotliReset(handle) → 0 | failure */
PRIMITIVE(js_host_brotli_reset) {
    UNUSED_PRIMITIVE_ARGS;
    BrotliObject *b = brotli_arg(ARG(0));
    if (!b) return js_throw_type_error(ctx, "brotliReset: a handle expected");
    const char *code;
    const char *message = brotli_init(b, NULL, 0, &code);
    if (message) return failure(ctx, message, -1, code);
    return js_int32(0);
}

/* brotliClose(handle): Brotli's memory, now */
PRIMITIVE(js_host_brotli_close) {
    UNUSED_PRIMITIVE_ARGS;
    BrotliObject *b = brotli_arg(ARG(0));
    if (b) brotli_end(b);
    return JS_UNDEFINED;
}
