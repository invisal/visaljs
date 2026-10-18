/*
 * jscontext.h — the two runtime handles.
 *
 *   JSRuntime  the agent: heap and GC, atoms, pending exception, job queue
 *   JSContext  a realm: global object and intrinsics. Reaches the agent via ctx->rt.
 */
#ifndef JSCONTEXT_H
#define JSCONTEXT_H

#include <string.h>

#include "js_atoms.h"
#include "js_bigint.h"
#include "js_gc.h"
#include "js_jobs.h"

/* Room left below the stack limit for the throw path and for runtime C code
 * called after the last check. Sanitizers make frames larger. */
#if defined(__SANITIZE_ADDRESS__)
#define JS_STACK_MARGIN ((uintptr_t)256 * 1024)
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define JS_STACK_MARGIN ((uintptr_t)256 * 1024)
#endif
#endif
#ifndef JS_STACK_MARGIN
#define JS_STACK_MARGIN ((uintptr_t)64 * 1024)
#endif

/* Typed array element types (js_buffer.h lists them): one constructor and prototype each. */
#define JS_TYPED_ARRAY_TYPES 12

/* Per-realm objects the runtime needs; every slot is a GC root. */
typedef enum JSIntrinsic {
    JS_INTRINSIC_GLOBAL_OBJECT,     /* globalThis */
    JS_INTRINSIC_OBJECT_PROTOTYPE,  /* %Object.prototype% */
    JS_INTRINSIC_ARRAY_PROTOTYPE,   /* %Array.prototype%: itself an array */
    JS_INTRINSIC_FUNCTION_PROTOTYPE,  /* %Function.prototype%: itself a function */
    JS_INTRINSIC_THROW_TYPE_ERROR,  /* %ThrowTypeError%: strict arguments.callee */
    JS_INTRINSIC_FUNCTION_HAS_INSTANCE,
    JS_INTRINSIC_FUNCTION_SHAPE,    /* the shapes new functions start with: length and name in place (js_cached_shape) */
    JS_INTRINSIC_GENERATOR_FUNCTION_SHAPE,
    JS_INTRINSIC_ASYNC_FUNCTION_SHAPE,
    JS_INTRINSIC_ASYNC_GENERATOR_FUNCTION_SHAPE,
    JS_INTRINSIC_ITER_RESULT_SHAPE, /* { value, done } */
    JS_INTRINSIC_PROMISE_SPECIES_GETTER,  /* the original Promise[@@species] getter: then's fast path */  /* Function.prototype[@@hasInstance]: instanceof's fast path */
    JS_INTRINSIC_STRING_PROTOTYPE,  /* where primitives look up properties */
    JS_INTRINSIC_NUMBER_PROTOTYPE,
    JS_INTRINSIC_BOOLEAN_PROTOTYPE,
    JS_INTRINSIC_SYMBOL_PROTOTYPE,
    JS_INTRINSIC_BIGINT_PROTOTYPE,          /* the bigint component */
    JS_INTRINSIC_ITERATOR_PROTOTYPE,        /* %IteratorPrototype% */
    JS_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_ARRAY_ITERATOR_NEXT,       /* the original next: the array fast path checks it */
    JS_INTRINSIC_ARRAY_VALUES,              /* %Array.prototype.values%, also Array.prototype[@@iterator] */
    JS_INTRINSIC_STRING_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_STRING_ITERATOR_NEXT,
    JS_INTRINSIC_STRING_ITERATOR,           /* the original String.prototype[@@iterator] */
    JS_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE,  /* %GeneratorFunction.prototype% */
    JS_INTRINSIC_GENERATOR_PROTOTYPE,       /* %GeneratorPrototype% */
    JS_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE,  /* %AsyncFunction.prototype% */
    JS_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE,  /* %AsyncIteratorPrototype% */
    JS_INTRINSIC_ASYNC_FROM_SYNC_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE,  /* %AsyncGeneratorFunction.prototype% */
    JS_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE, /* %AsyncGeneratorPrototype% */
    JS_INTRINSIC_WEAK_MAP_PROTOTYPE,
    JS_INTRINSIC_WEAK_SET_PROTOTYPE,
    JS_INTRINSIC_WEAK_REF_PROTOTYPE,
    JS_INTRINSIC_FINALIZATION_REGISTRY_PROTOTYPE,
    JS_INTRINSIC_MAP_PROTOTYPE,             /* the collections component, when installed */
    JS_INTRINSIC_SET_PROTOTYPE,
    JS_INTRINSIC_MAP_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_SET_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_ARRAY_BUFFER_PROTOTYPE,    /* the arraybuffer component */
    JS_INTRINSIC_DATA_VIEW_PROTOTYPE,
    JS_INTRINSIC_DATE_PROTOTYPE,            /* the date component */
    JS_INTRINSIC_TYPED_ARRAY,               /* %TypedArray%, the typedarray component */
    JS_INTRINSIC_TYPED_ARRAY_PROTOTYPE,
    JS_INTRINSIC_TYPED_ARRAY_CTORS,         /* then one per element type (js_buffer.h) */
    JS_INTRINSIC_TYPED_ARRAY_PROTOS = JS_INTRINSIC_TYPED_ARRAY_CTORS + JS_TYPED_ARRAY_TYPES,
    JS_INTRINSIC_TYPED_ARRAY_PROTOS_END = JS_INTRINSIC_TYPED_ARRAY_PROTOS + JS_TYPED_ARRAY_TYPES - 1,
    JS_INTRINSIC_PROMISE,                   /* %Promise%: NewPromiseCapability's fast path checks it */
    JS_INTRINSIC_PROMISE_PROTOTYPE,
    JS_INTRINSIC_ERROR_PROTOTYPE,   /* then one per native error, in JSErrorKind order */
    JS_INTRINSIC_EVAL_ERROR_PROTOTYPE,
    JS_INTRINSIC_RANGE_ERROR_PROTOTYPE,
    JS_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
    JS_INTRINSIC_SYNTAX_ERROR_PROTOTYPE,
    JS_INTRINSIC_TYPE_ERROR_PROTOTYPE,
    JS_INTRINSIC_URI_ERROR_PROTOTYPE,
    JS_INTRINSIC_AGGREGATE_ERROR_PROTOTYPE,
    JS_INTRINSIC_ERROR_STACK_GET,   /* every error's `stack` accessor (V8's) */
    JS_INTRINSIC_ERROR_STACK_SET,
    JS_INTRINSIC_ERROR,             /* %Error%: Error.captureStackTrace reads its prepareStackTrace and stackTraceLimit */
    JS_INTRINSIC_CALL_SITE_PROTOTYPE,  /* the placeholder call sites Error.prepareStackTrace receives */
    JS_INTRINSIC_REGEXP,            /* %RegExp%, when the RegExp component is installed */
    JS_INTRINSIC_REGEXP_PROTOTYPE,
    JS_INTRINSIC_REGEXP_EXEC,       /* the original RegExp.prototype.exec: RegExpExec calls it directly */
    JS_INTRINSIC_REGEXP_STRING_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_DOM_EXCEPTION_PROTOTYPE,   /* the web-standard host layer */
    JS_INTRINSIC_TEXT_ENCODER_PROTOTYPE,
    JS_INTRINSIC_TEXT_DECODER_PROTOTYPE,
    JS_INTRINSIC_URL_PROTOTYPE,
    JS_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE,
    JS_INTRINSIC_URL_SEARCH_PARAMS_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_URL_SEARCH_PARAMS_ENTRIES,
    JS_INTRINSIC_EVENT_PROTOTYPE,
    JS_INTRINSIC_EVENT_TARGET_PROTOTYPE,
    JS_INTRINSIC_ABORT_SIGNAL_PROTOTYPE,
    JS_INTRINSIC_ABORT_CONTROLLER_PROTOTYPE,
    JS_INTRINSIC_BUFFER,            /* Node's Buffer */
    JS_INTRINSIC_BUFFER_PROTOTYPE,
    JS_INTRINSIC_HEADERS_PROTOTYPE,
    JS_INTRINSIC_HEADERS_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_READABLE_STREAM_PROTOTYPE,
    JS_INTRINSIC_READABLE_STREAM_READER_PROTOTYPE,
    JS_INTRINSIC_READABLE_STREAM_CONTROLLER_PROTOTYPE,
    JS_INTRINSIC_READABLE_STREAM_ITERATOR_PROTOTYPE,
    JS_INTRINSIC_WRITABLE_STREAM_PROTOTYPE,
    JS_INTRINSIC_WRITABLE_STREAM_WRITER_PROTOTYPE,
    JS_INTRINSIC_WRITABLE_STREAM_CONTROLLER_PROTOTYPE,
    JS_INTRINSIC_TRANSFORM_STREAM_PROTOTYPE,
    JS_INTRINSIC_TRANSFORM_STREAM_CONTROLLER_PROTOTYPE,
    JS_INTRINSIC_BLOB_PROTOTYPE,
    JS_INTRINSIC_FILE_PROTOTYPE,
    JS_INTRINSIC_REQUEST_PROTOTYPE,
    JS_INTRINSIC_RESPONSE_PROTOTYPE,  /* the original entries: new URLSearchParams(params) copies directly */
    JS_INTRINSIC_CRYPTO,            /* Web Crypto: the crypto object */
    JS_INTRINSIC_CRYPTO_PROTOTYPE,
    JS_INTRINSIC_SUBTLE_CRYPTO,     /* crypto.subtle */
    JS_INTRINSIC_SUBTLE_CRYPTO_PROTOTYPE,
    JS_INTRINSIC_CRYPTO_KEY_PROTOTYPE,
    JS_INTRINSIC_UTIL_INSPECT,      /* the util.inspect function custom inspectors receive */
    JS_INTRINSIC_CONSOLE_STATE,     /* console's counters and timers, by label */
    JS_INTRINSIC_COUNT
} JSIntrinsic;

/* Shapes the GC processes weakly: root shapes by (class, proto,
 * capacity), and shapes whose transition tables point to children. */
typedef struct JSShapeRegistry {
    struct JSShape **roots;       /* open addressing; NULL = empty */
    size_t root_cap, root_count;
    struct JSShape **parents;     /* shapes with transitions */
    size_t parent_count, parent_cap;
    /* Since the last collection: the root shapes and transitions' children made (the only shapes
     * a young collection can find dead), and the shapes given transitions, parents[old_parents..]. */
    struct JSShape **young;
    size_t young_count, young_cap;
    size_t old_parents;
} JSShapeRegistry;

/* Registered inline-cache arrays: reset weakly after marking. */
typedef struct JSPropCacheTables {
    struct JSPropCacheTable { struct JSPropCache *ics; size_t n; } *tables;
    size_t count, cap;
} JSPropCacheTables;

/* What util.inspect shows of a Map, a Set or their iterators (collection_preview). */
typedef enum JSCollectionPreview {
    JS_PREVIEW_MAP, JS_PREVIEW_SET,                      /* the entries */
    JS_PREVIEW_MAP_ITERATOR, JS_PREVIEW_SET_ITERATOR,    /* the keys or values left */
    JS_PREVIEW_MAP_ENTRIES, JS_PREVIEW_SET_ENTRIES,      /* the [key, value] pairs left */
} JSCollectionPreview;

/* An I/O backend for the event loop: libuv, set by the host code that first needs it
 * (node:http), so that programs without I/O don't link libuv. */
typedef struct JSIOBackend {
    bool (*alive)(JSRuntime *rt);  /* open handles (servers, sockets) keep the program running */
    /* Waits for I/O at most timeout_ms (-1: until some), running the callbacks it brings: 0, or
     * the exit status after an uncaught error (already reported). */
    int  (*run)(JSContext *ctx, int64_t timeout_ms);
} JSIOBackend;

struct JSRuntime {
    JSHeap    heap;
    JSShapeRegistry shapes;
    JSPropCacheTables prop_caches;
    /* the shared second-level caches (object.c): get and set entries by (shape, key), for the
     * sites a monomorphic cache misses and C code's lookups, and the shape that defining a new
     * key gives (object literals); emptied at every collection */
    struct JSMegaEntry *mega_get, *mega_set, *mega_define;
    /* Bumped when an object that is some shape's prototype changes shape (js_object_set_shape):
     * caches that saw a prototype chain (ADD, PROTO) and remember the epoch it had are good
     * while it's the same, without walking the chain again (optimizer step 11). */
    uint32_t  proto_epoch;
    JSContext *realms;      /* every live JSContext, linked through next_realm */
    JSAtomTable atoms;      /* weak */
    JSValue   exception;    /* pending exception, JS_EMPTY if none; a GC root */
    JSValue   symbol_registry;  /* Symbol.for's GlobalSymbolRegistry: key -> symbol (a root) */
    uintptr_t stack_limit;  /* lowest usable stack address, margin included */
    JSJobQueue jobs;        /* microtasks */
    JSTimers  timers;       /* setTimeout / setInterval */
    /* The async context: an opaque value the host keeps per chain of async work
     * (node:async_hooks' AsyncLocalStorage keeps its stores in it). Every job, timer and promise
     * reaction takes the one current when it was queued, and runs under it. Undefined: none. A root. */
    JSValue   async_context;
    struct JSRejections { JSValue *items; size_t count, cap; } rejections;  /* rejected, unhandled promises (roots) */
    struct JSRejections handled_late;  /* reported ones given a handler since: for on_handled_late (roots) */
    /* Set by the host (process's 'uncaughtException', 'unhandledRejection'): an uncaught error,
     * or the reason of a promise rejected and unhandled (`promise` undefined for an error).
     * 0 handled, -1 not (it is reported), else the exit status after the host reported its
     * handler's own error (7 for 'uncaughtException''s, as in Node). on_handled_late: a
     * promise it handled got a handler ('rejectionHandled'), at the end of a checkpoint; 0, or
     * -1 after an exception. */
    int     (*on_uncaught)(JSContext *ctx, JSValue error, JSValue promise);
    int     (*on_handled_late)(JSContext *ctx, JSValue promise);
    uint8_t   failure;  /* the exit status after an uncaught error: 1, or on_uncaught's */
    struct JSWeakList { struct JSObject **items; size_t count, cap; } weak;  /* WeakMap/Set/Ref, registries */
    /* WeakMap and WeakSet entries set since the last collection, by key (EMPTY: every entry of the
     * table): the only ones a young collection looks at (weak.c). */
    struct JSWeakWrites { struct JSWeakWrite { struct JSObject *table; JSValue key; } *items; size_t count, cap; } weak_writes;
    struct JSKeptAlive { JSValue *items; size_t count, cap; } kept_alive;    /* [[KeptAlive]]: roots until ClearKeptObjects */
    const struct JSComponent *const *components;  /* installed in every realm */
    size_t    ncomponents;
    const struct JSCoreEntry *core;  /* the core methods every realm installs (js_core.def) */
    size_t    ncore;
    /* Set by the collections component (core reaches optional components through
     * hooks): a Map's or Set's entries, or what an iterator has left, as an array (flat
     * [k1, v1, k2, v2, …] for a Map and the entries iterators); EMPTY for other values. */
    JSValue (*collection_preview)(JSContext *ctx, JSValue v, JSCollectionPreview *what);
    bool    (*is_typed_array)(JSValue v);  /* set by typed arrays: ArrayBuffer.isView */
    /* Set by Date: a Date's ISO string ("Invalid Date" if invalid) for util.inspect; EMPTY otherwise. */
    JSValue (*date_inspect)(JSContext *ctx, JSValue v);
    /* Set by RegExp: a RegExp's "/source/flags" for util.inspect; EMPTY otherwise. */
    JSValue (*regexp_inspect)(JSContext *ctx, JSValue v);
    const JSBigIntOps *bigint;  /* set by the bigint component */
    /* A typed array's length now: -1 when out of bounds (detached), -2 for anything else. */
    double  (*typed_array_length)(JSValue v);
    /* Set by typed arrays: a typed array's or DataView's bytes (its current window), true; false
     * for anything else (an ArrayBuffer too: process.stdout.write takes views only). */
    bool    (*view_bytes)(JSValue v, uint8_t **data, size_t *length);
    const JSIOBackend *io;     /* the event loop's I/O, once a program uses some */
    uint8_t   rejection_mode;  /* JSRejectionMode */
    uint8_t   in_checkpoint;   /* js_run_microtasks is running */
};

struct JSContext {
    JSRuntime *rt;
    uintptr_t  stack_limit; /* copy of rt->stack_limit: one load in every function prologue */
    uint8_t    barrier_threshold; /* js_store's slow path runs for an owner whose GC byte is this or more */
    JSValue    intrinsics[JS_INTRINSIC_COUNT];
    JSContext *next_realm;
    struct JSShape *array_shape;  /* the root shape of its arrays with Array.prototype (js_new_array), made at the first */
};

JSRuntime *js_runtime_new(void);
void js_runtime_free(JSRuntime *rt);   /* frees every cell, running finalizers */
JSContext *js_context_new(JSRuntime *rt);  /* a new realm; js_runtime_free frees any left */
void js_context_free(JSContext *ctx);
/* The test262 host: defines $262 on ctx's global object and returns it. */
JSValue js_test_host_init(JSContext *ctx);

/* Every store of a JSValue into a cell that may already be reachable: the write barrier.
 * One compare when the owner is young or already remembered. */
static inline void js_store(JSContext *ctx, JSCell *owner, JSValue *slot, JSValue v) {
    assert(!js_is_exception(v) && "JS_EXCEPTION stored into a cell");
    *slot = v;
    if (JS_UNLIKELY(owner->gc >= ctx->barrier_threshold) && js_is_cell(v)) js_write_barrier_slow(ctx, owner, slot, js_as_cell(v));
}

/* The barrier alone, after storing `v` at `slot` (NULL: in malloc'd memory) where js_store can't
 * write: a malloc'd table's entry, a struct holding several values. */
static inline void js_write_barrier(JSContext *ctx, JSCell *owner, const void *slot, JSValue v) {
    if (JS_UNLIKELY(owner->gc >= ctx->barrier_threshold) && js_is_cell(v)) js_write_barrier_slow(ctx, owner, slot, js_as_cell(v));
}

/* The barrier for a store of a cell pointer (a JSShape *, a JSEnv *, ...) into `owner`, after the
 * store: js_store_ptr does both. */
static inline void js_write_barrier_cell(JSContext *ctx, JSCell *owner, const void *slot, const JSCell *c) {
    if (JS_UNLIKELY(owner->gc >= ctx->barrier_threshold) && c) js_write_barrier_slow(ctx, owner, slot, c);
}
#define js_store_ptr(ctx, owner, slot, p) \
    do { *(slot) = (p); js_write_barrier_cell((ctx), (owner), (slot), (const JSCell *)(p)); } while (0)

/* Copies `n` values into `owner` (memmove: the ranges may overlap), then remembers the owner if
 * it's old: one barrier for a bulk copy. */
static inline void js_store_range(JSContext *ctx, JSCell *owner, JSValue *dst, const JSValue *src, size_t n) {
    memmove(dst, src, n * sizeof *dst);
    if (JS_UNLIKELY(owner->gc >= ctx->barrier_threshold) && n) js_remember(ctx, owner, dst, n * sizeof *dst);
}

/* Allocation fast path: the lowest free cell of the class's window.
 * Its cells are zeroed, and zeroed memory reads as JS_EMPTY, so a half-initialized cell is always
 * safe to trace. Checking builds (JS_GC_VERIFY, implied by JS_GC_STRESS) always take the slow
 * path, which checks the dead cell and, under stress, collects first. */
static inline void *js_alloc_small(JSContext *ctx, unsigned size_class) {
#ifndef JS_GC_VERIFY
    JSAllocator *a = &ctx->rt->heap.alloc[size_class];
    uint64_t free = a->free;
    if (JS_LIKELY(free)) {
        a->free = free & (free - 1);
        return (void *)(a->base + js_ctz64(free) * a->cell_size);
    }
#endif
    return js_alloc_slow(ctx, size_class);
}

#endif /* JSCONTEXT_H */
