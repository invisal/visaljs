/* Host primitives for node:zlib's zstd streams: Node's binding (src/node_zlib.cc, its
 * ZstdCompressContext and ZstdDecompressContext) over zstd 1.5.7, the copy Node vendors. As
 * host_zlib.c: a stream is a handle object, and a failure is [message, errno, code]. */
#include <stdlib.h>
#include <string.h>

#include "js_buffer.h"
#include "js_exception.h"
#include "js_gc.h"
#include "js_node.h"
#include "js_object.h"
#include "js_ops.h"
#include "jsstring.h"
#define ZSTD_STATIC_LINKING_ONLY  /* ZSTD_customMem: the vendored version's */
#include "zstd.h"
#include "zstd_errors.h"

#define PRIMITIVE(fn) \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)
#define UNUSED_PRIMITIVE_ARGS (void)callee, (void)this_val, (void)new_target
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

typedef struct ZstdObject {
    JSObject           obj;
    bool               compress;
    ZSTD_CCtx         *cctx;
    ZSTD_DCtx         *dctx;
    unsigned long long pledged_src_size;
    int                flush;
    bool               frame_complete;  /* decompressing: the last input ended a frame */
    ZSTD_ErrorCode     error;  /* the first failure stays, as in Node */
    JSRuntime         *rt;     /* the allocator's */
} ZstdObject;

/* zstd's memory is the heap's external memory. */
static void *zstd_alloc(void *rt, size_t n) { return js_gc_external_malloc(rt, n); }
static void zstd_free(void *rt, void *p) { js_gc_external_free(rt, p); }

static ZSTD_customMem zstd_mem(ZstdObject *z) { return (ZSTD_customMem){ zstd_alloc, zstd_free, z->rt }; }

static void zstd_end(ZstdObject *z) {
    ZSTD_freeCCtx(z->cctx);
    ZSTD_freeDCtx(z->dctx);
    z->cctx = NULL;
    z->dctx = NULL;
}

static void zstd_finalize(JSRuntime *rt, JSCell *cell) {
    (void)rt;
    zstd_end((ZstdObject *)cell);
}

static const JSClass zstd_class = { "ZstdHandle", sizeof(ZstdObject), NULL, NULL, NULL, NULL, NULL, zstd_finalize, NULL };

static ZstdObject *zstd_arg(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &zstd_class ? (ZstdObject *)js_as_object(v) : NULL;
}

static JSValue failure(JSContext *ctx, const char *message, int err, const char *code) {
    JSValue items[3] = { js_new_string_cstr(ctx, message), js_int32(err), js_new_string_cstr(ctx, code) };
    JSValue a = js_new_array(ctx, 3);
    for (int i = 0; i < 3; i++)
        if (js_array_append(ctx, a, items[i]) < 0) return JS_EXCEPTION;
    return a;
}

/* Node's ZstdStrerror: the error's name in zstd_errors.h */
static const char *zstd_strerror(ZSTD_ErrorCode e) {
    switch (e) {
#define V(code) case code: return #code;
    V(ZSTD_error_no_error) V(ZSTD_error_GENERIC) V(ZSTD_error_prefix_unknown) V(ZSTD_error_version_unsupported)
    V(ZSTD_error_frameParameter_unsupported) V(ZSTD_error_frameParameter_windowTooLarge) V(ZSTD_error_corruption_detected)
    V(ZSTD_error_checksum_wrong) V(ZSTD_error_literals_headerWrong) V(ZSTD_error_dictionary_corrupted)
    V(ZSTD_error_dictionary_wrong) V(ZSTD_error_dictionaryCreation_failed) V(ZSTD_error_parameter_unsupported)
    V(ZSTD_error_parameter_combination_unsupported) V(ZSTD_error_parameter_outOfBound) V(ZSTD_error_tableLog_tooLarge)
    V(ZSTD_error_maxSymbolValue_tooLarge) V(ZSTD_error_maxSymbolValue_tooSmall) V(ZSTD_error_stabilityCondition_notRespected)
    V(ZSTD_error_stage_wrong) V(ZSTD_error_init_missing) V(ZSTD_error_memory_allocation) V(ZSTD_error_workSpace_tooSmall)
    V(ZSTD_error_dstSize_tooSmall) V(ZSTD_error_srcSize_wrong) V(ZSTD_error_dstBuffer_null)
    V(ZSTD_error_noForwardProgress_destFull) V(ZSTD_error_noForwardProgress_inputEmpty)
#undef V
    default: return "ZSTD_error_GENERIC";
    }
}

/* Init: a new context (ResetStream is Init again, without the dictionary or the parameters, as in
 * Node). NULL, or the failure's message and code. */
static const char *zstd_init(ZstdObject *z, const uint8_t *dictionary, size_t dictionary_len, const char **code) {
    zstd_end(z);
    *code = "ERR_ZLIB_INITIALIZATION_FAILED";
    if (z->compress) {
        if (!(z->cctx = ZSTD_createCCtx_advanced(zstd_mem(z)))) return "Could not initialize zstd instance";
        if (dictionary_len && ZSTD_isError(ZSTD_CCtx_loadDictionary(z->cctx, dictionary, dictionary_len))) {
            *code = "ERR_ZLIB_DICTIONARY_LOAD_FAILED";
            return "Failed to load zstd dictionary";
        }
        if (ZSTD_isError(ZSTD_CCtx_setPledgedSrcSize(z->cctx, z->pledged_src_size))) return "Could not set pledged src size";
    } else {
        if (!(z->dctx = ZSTD_createDCtx_advanced(zstd_mem(z)))) return "Could not initialize zstd instance";
        if (dictionary_len && ZSTD_isError(ZSTD_DCtx_loadDictionary(z->dctx, dictionary, dictionary_len))) {
            *code = "ERR_ZLIB_DICTIONARY_LOAD_FAILED";
            return "Failed to load zstd dictionary";
        }
    }
    return NULL;
}

/* zstdNew(compress) → handle */
PRIMITIVE(js_host_zstd_new) {
    UNUSED_PRIMITIVE_ARGS;
    ZstdObject *z = (ZstdObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &zstd_class, JS_NULL, 0));
    z->compress = js_truthy(ARG(0));
    z->cctx = NULL;
    z->dctx = NULL;
    z->rt = ctx->rt;
    z->pledged_src_size = ZSTD_CONTENTSIZE_UNKNOWN;
    z->flush = ZSTD_e_continue;
    z->frame_complete = false;
    z->error = ZSTD_error_no_error;
    return js_object_value(&z->obj);
}

/* zstdInit(handle, params, pledgedSrcSize | undefined, dictionary | undefined): params a
 * Uint32Array, by parameter number, 0xffffffff unset; the prelude checked pledgedSrcSize →
 * 0 | failure */
PRIMITIVE(js_host_zstd_init) {
    UNUSED_PRIMITIVE_ARGS;
    ZstdObject *z = zstd_arg(ARG(0));
    uint8_t *p, *dict = NULL;
    size_t n, dict_len = 0;
    if (!z || !js_buffer_source_bytes(ARG(1), &p, &n)) return js_throw_type_error(ctx, "zstdInit: a handle and parameters expected");
    if (js_is_number(ARG(2))) z->pledged_src_size = (unsigned long long)js_as_number(ARG(2));
    if (!js_is_undefined(ARG(3))) js_buffer_source_bytes(ARG(3), &dict, &dict_len);
    const char *code;
    const char *message = zstd_init(z, dict, dict_len, &code);
    if (message) return failure(ctx, message, -1, code);
    for (size_t i = 0; i < n / sizeof(uint32_t); i++) {
        uint32_t value;
        memcpy(&value, p + i * sizeof value, sizeof value);
        if (value == UINT32_MAX) continue;
        size_t r = z->compress ? ZSTD_CCtx_setParameter(z->cctx, (ZSTD_cParameter)i, (int)value)
                               : ZSTD_DCtx_setParameter(z->dctx, (ZSTD_dParameter)i, (int)value);
        if (ZSTD_isError(r)) return failure(ctx, "Setting parameter failed", -1, "ERR_ZSTD_PARAM_SET_FAILED");
    }
    return js_int32(0);
}

/* zstdWrite(handle, flush, in | null, inOff, inLen, out, outOff, outLen, state) → 0, with state
 * [availOut, availIn] after it, or a failure */
PRIMITIVE(js_host_zstd_write) {
    UNUSED_PRIMITIVE_ARGS;
    ZstdObject *z = zstd_arg(ARG(0));
    uint8_t *in = NULL, *out, *state;
    size_t in_n = 0, out_n, state_n;
    if (!z || (!z->cctx && !z->dctx) || (!js_is_null(ARG(2)) && !js_buffer_source_bytes(ARG(2), &in, &in_n))
        || !js_buffer_source_bytes(ARG(5), &out, &out_n) || !js_buffer_source_bytes(ARG(8), &state, &state_n) || state_n < 2 * sizeof(uint32_t))
        return js_throw_type_error(ctx, "zstdWrite: a handle, buffers and a state expected");
    double in_off = in ? js_as_number(ARG(3)) : 0, in_len = in ? js_as_number(ARG(4)) : 0;
    double out_off = js_as_number(ARG(6)), out_len = js_as_number(ARG(7));
    if (!(in_off >= 0 && in_len >= 0 && in_off + in_len <= (double)in_n && out_off >= 0 && out_len >= 0 && out_off + out_len <= (double)out_n))
        return js_throw_range_error(ctx, "zstdWrite: out of bounds");
    ZSTD_inBuffer input = { in ? in + (size_t)in_off : NULL, (size_t)in_len, 0 };
    ZSTD_outBuffer output = { out + (size_t)out_off, (size_t)out_len, 0 };
    z->flush = js_is_number(ARG(1)) ? (int)js_as_number(ARG(1)) : ZSTD_e_continue;
    size_t r = z->compress ? ZSTD_compressStream2(z->cctx, &output, &input, (ZSTD_EndDirective)z->flush)
                           : ZSTD_decompressStream(z->dctx, &output, &input);
    if (ZSTD_isError(r)) z->error = ZSTD_getErrorCode(r);
    if (z->error != ZSTD_error_no_error) return failure(ctx, ZSTD_getErrorString(z->error), (int)z->error, zstd_strerror(z->error));
    /* decompressing to the end, all the input read, room left and the frame not complete: the
       input stopped short (Node 24's ZstdDecompressContext::GetErrorInfo). A call without input
       leaves the frame as the last one with input left it. */
    if (!z->compress && input.size > 0) z->frame_complete = r == 0;
    if (!z->compress && z->flush == ZSTD_e_end && !z->frame_complete && input.pos == input.size && output.pos < output.size)
        return failure(ctx, "unexpected end of file", -5, "Z_BUF_ERROR");
    uint32_t result[2] = { (uint32_t)(output.size - output.pos), (uint32_t)(input.size - input.pos) };
    memcpy(state, result, sizeof result);
    return js_int32(0);
}

/* zstdReset(handle) → 0 | failure */
PRIMITIVE(js_host_zstd_reset) {
    UNUSED_PRIMITIVE_ARGS;
    ZstdObject *z = zstd_arg(ARG(0));
    if (!z) return js_throw_type_error(ctx, "zstdReset: a handle expected");
    if (!z->compress) z->pledged_src_size = ZSTD_CONTENTSIZE_UNKNOWN;  /* ignored when decompressing */
    z->frame_complete = false;
    const char *code;
    const char *message = zstd_init(z, NULL, 0, &code);
    if (message) return failure(ctx, message, -1, code);
    return js_int32(0);
}

/* zstdClose(handle): zstd's memory, now */
PRIMITIVE(js_host_zstd_close) {
    UNUSED_PRIMITIVE_ARGS;
    ZstdObject *z = zstd_arg(ARG(0));
    if (z) zstd_end(z);
    return JS_UNDEFINED;
}
