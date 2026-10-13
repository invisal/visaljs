/*
 * js_gc.h — heap and garbage collector.
 *
 * Non-moving mark-sweep. Cells come from 64 KiB aligned blocks, one size
 * class per block, or from the large-object space. Mark and allocation bits
 * live in side bitmaps in the block header, never in the cell.
 */
#ifndef JS_GC_H
#define JS_GC_H

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#if defined(_MSC_VER) && !defined(__clang__)
#include <intrin.h>
#endif

#include "jscell.h"
#include "jsvalue.h"

typedef struct JSRuntime JSRuntime;
typedef struct JSContext JSContext;

/* ---- Blocks and size classes ------------------------------------------- */

#define JS_BLOCK_SIZE       ((size_t)64 * 1024)
#define JS_CELL_ALIGN       16
#define JS_MAX_SMALL_SIZE   8192
#define JS_NUM_SIZE_CLASSES 32
#define JS_BLOCK_MAX_CELLS  (JS_BLOCK_SIZE / JS_CELL_ALIGN)
#define JS_BITMAP_WORDS     (JS_BLOCK_MAX_CELLS / 64)

/* Collection policy. */
#define JS_GC_MIN_HEAP      ((size_t)4 << 20)  /* the old generation's smallest limit */
#define JS_GC_NURSERY       ((size_t)4 << 20)  /* a young collection after this much is allocated */

/* Checking builds: JS_GC_STRESS collects at every allocation;
 * JS_GC_VERIFY checks every pointer the marker follows and poisons dead cells. Stress implies
 * verification. Both make allocation take the slow path. */
#if defined(JS_GC_STRESS) && !defined(JS_GC_VERIFY)
#define JS_GC_VERIFY 1
#endif

/* The header of a 64 KiB block of same-size cells, or of a large object:
 * a 64 KiB-aligned mapping holding exactly one cell (is_large). Either way
 * js_block_of(cell) finds it. */
typedef struct JSBlock {
    struct JSBlock *next;        /* in its size class's list, or in the empty pool */
    struct JSBlock *prev;        /* in its size class's list */
    size_t   map_size;           /* JS_BLOCK_SIZE, or the large object's mapping */
    uint32_t cell_size;
    uint32_t cell_count;
    uint8_t  size_class;
    uint8_t  is_large;
    union {
        uint8_t queued;          /* in its class's sweep queue */
        uint8_t remembered;      /* a large object: in the remembered set, with cards marked */
    };
    uint8_t  has_finalizable;
    uint32_t index_magic;        /* ceil(2^32 / cell_size): a cell's index is (offset * magic) >> 32 */
    uint8_t  young;              /* the allocator took it since the last collection */
    uint64_t mark_bits[JS_BITMAP_WORDS];
    uint64_t alloc_bits[JS_BITMAP_WORDS];  /* exact only while the world is stopped */
} JSBlock;

/* A large object's cards: a bit per 2^card_shift bytes of the object
 * that a store gave a young cell since the last collection. They live in the allocation bitmap,
 * whose only other bit is bit 0 of word 0. A large object's size_class is its card_shift. */
#define JS_LARGE_CARDS ((JS_BITMAP_WORDS - 1) * 64)
static inline uint64_t *js_large_cards(JSBlock *b) { return &b->alloc_bits[1]; }

#define JS_BLOCK_FIRST_CELL \
    ((sizeof(JSBlock) + JS_CELL_ALIGN - 1) & ~(size_t)(JS_CELL_ALIGN - 1))

static inline JSBlock *js_block_of(const void *p) {
    return (JSBlock *)((uintptr_t)p & ~(uintptr_t)(JS_BLOCK_SIZE - 1));
}

/* Cell size of each class: 16…128 in steps of 16, then 4 classes per doubling up to 8192. */
extern const uint16_t js_size_class_bytes[JS_NUM_SIZE_CLASSES];

/* The class for 1 <= size <= JS_MAX_SMALL_SIZE. Folds to a constant for constant sizes. */
static inline unsigned js_size_class(size_t size) {
    if (size <= 128) return (unsigned)((size + 15) / 16) - (size != 0);
    unsigned s = (unsigned)size - 1;
#if defined(_MSC_VER) && !defined(__clang__)
    unsigned long b;
    _BitScanReverse(&b, s);
#else
    unsigned b = 31 - (unsigned)__builtin_clz(s);  /* floor(log2(s)): 7…12 */
#endif
    return 8 + (unsigned)(b - 7) * 4 + ((s >> (b - 2)) - 4);
}

/* The index of x's lowest set bit; x != 0. */
static inline unsigned js_ctz64(uint64_t x) {
#if defined(_MSC_VER) && !defined(__clang__)
    unsigned long i;
    _BitScanForward64(&i, x);
    return (unsigned)i;
#else
    return (unsigned)__builtin_ctzll(x);
#endif
}

/* ---- Heap -------------------------------------------------------------- */

/* What the collector has done, counted always (a few clock reads per collection). JS_GC_TRACE=1
 * prints a line per collection, JS_GC_STATS=1 a JSON summary at exit. */
typedef struct JSGCStats {
    uint64_t collections;
    uint64_t young_collections;               /* of them: the rest were full */
    uint64_t idle_collections;                /* of the full ones: when the program was idle */
    uint64_t mark_slices;                     /* incremental marking's pauses, in pause_ms too */
    uint64_t parallel_markings;               /* pauses' markings the helper threads joined */
    double   pause_ms, max_pause_ms;          /* the world stopped: everything below but sweep */
    double   mark_ms, weak_ms, finish_ms;     /* the pause: marking; weak references; finalizers, large objects, accounting */
    double   sweep_ms;                        /* lazy sweeping, in allocation: timed only when reporting */
    uint64_t blocks_swept;
    uint64_t allocated_bytes;                 /* handed to the allocator, in total */
    uint64_t marked_cells;                    /* by the last collection */
    size_t   peak_heap_bytes;                 /* js_heap_size's high-water mark */
    size_t   peak_external_bytes;             /* external memory's high-water mark */
} JSGCStats;

/* Allocation in one size class, a word of the allocation bitmap at a
 * time: `free` has a bit for each free cell of a window of 64 cells at `base`, zeroed and not
 * handed out yet. The fast path takes the lowest. A dead cell isn't written until it's reused. */
typedef struct JSAllocator {
    uint64_t  free;             /* hot: the fast path's two loads */
    uintptr_t base;
    uintptr_t cell_size;
    JSBlock  *block;            /* the block the window is in; NULL: none */
    uint32_t  word;             /* the bitmap word after the window's: where the next one is looked for */
    uint32_t  fresh;            /* the block is a new mapping, zero-filled */
} JSAllocator;

typedef struct JSHeap {
    JSAllocator alloc[JS_NUM_SIZE_CLASSES]; /* hot: the inline fast path */
    JSBlock *blocks[JS_NUM_SIZE_CLASSES];   /* every block of the class (doubly linked) */
    /* Lazy sweeping: the blocks of each class to sweep before the allocator takes them. A full
     * collection queues them all; a young one, those the allocator took since the last one (the
     * others hold old cells only, and a young collection frees none). malloc'd. */
    struct JSBlockList { JSBlock **items; size_t count, cap; } to_sweep[JS_NUM_SIZE_CLASSES], young_blocks;
    /* Swept blocks with free cells the allocator hasn't taken: finish_sweeping's, before a full
     * collection's marking or after an idle one. Emptied when a full collection queues every block. */
    struct JSBlockList ready[JS_NUM_SIZE_CLASSES];
    JSBlock *empty;                         /* pool of empty blocks, any class */
    size_t   block_count;                   /* mapped, decommitted ones included */
    size_t   empty_count;
    /* Empty blocks given back to the OS, their addresses kept for reuse (malloc'd); not in the block
     * set. Each with the full collections there had been when it was decommitted: one still
     * unused after another full collection is unmapped. */
    struct JSDecommitted { JSBlock *block; size_t full_count; } *decommitted;
    size_t   decommitted_count, decommitted_cap;
    size_t   full_count;                    /* full collections so far */
    JSBlock **large;                        /* large objects, sorted by address (malloc'd) */
    size_t   large_count;
    size_t   large_cap;
    size_t   large_bytes;                   /* their mappings, and the cache's */
    JSBlock **large_cache;                  /* dead large objects' mappings, for reuse (malloc'd) */
    size_t   large_cache_count, large_cache_cap, large_cache_bytes;

    /* Precise roots (malloc'd arrays). */
    struct JSRootTable { JSValue *slots; size_t n; } *root_tables;
    size_t   root_table_count, root_table_cap;
    JSValue **roots;
    size_t   root_count, root_cap;

    /* Conservative pointer test. */
    uintptr_t *block_set;                   /* open addressing over block addresses; 0 = empty */
    size_t   block_set_cap, block_set_count;
    uint64_t block_bloom[4];                /* 256-bit Bloom filter over block_set */
    uintptr_t min_addr, max_addr;           /* bounds of every mapping the heap made */
    void    *stack_base;                    /* highest stack address of the owning thread */

    /* Generations: old cells a store gave a young cell (malloc'd). */
    JSCell **remembered;
    size_t   remembered_count, remembered_cap;

    JSCell **mark_stack;                    /* malloc'd; a tracer's, kept between collections */

    /* Incremental marking: an old collection's marking in
     * slices, while the program runs and allocates. */
    struct JSTracer *marker;                /* the marking in progress (malloc'd), or NULL */
    bool     incremental;                   /* old collections mark incrementally (env JS_GC_INCREMENTAL=0: not) */
    double   mark_ratio;                    /* bytes to mark per byte allocated */
    size_t   slice_clock;                   /* the allocation clock at the last slice */
    size_t   next_slice;                    /* the next slice when the clock gets there */
    size_t   mark_alloc_limit;              /* the final pause when it gets there, done or not */
    double   mark_rate;                     /* promotion_rate when the marking started */
    double   marking_ms;                    /* its pauses so far */
    unsigned marking_slices;
    /* Parallel marking: helper threads mark with the collector in
     * its pauses, started when a marking first has enough to do. */
    struct JSMarkPool *pool;
    unsigned gc_helpers;                    /* how many (env JS_GC_THREADS) */
    bool     exact;                         /* the next collection abandons a marking in progress, and marks from scratch */
    size_t   mark_stack_cap;
    size_t   gc_count;
    int      in_gc;
    int      report;                        /* JS_GC_TRACE (1: each collection) / JS_GC_STATS (2: at exit) bits */
    JSGCStats stats;

    /* Policy: a young collection when what was allocated since the last one,
     * cells and external memory, exceeds the nursery; it's a full one when the old generation
     * (its cells and the external memory they keep) has outgrown old_limit, or the heap limit is
     * near. Each full collection sets old_limit from how fast the old generation grew and how
     * long the collection took, so that full collections take about JS_GC_TARGET of the time. */
    size_t   allocated_since_gc;            /* bytes handed to the allocator */
    size_t   external_since_gc;             /* external bytes added since the last collection */
    size_t   external_bytes;                /* external memory now (js_gc_external_add / _sub) */
    size_t   live_after_gc;                 /* bytes marked by the last collection: the old generation's cells */
    size_t   old_after_full;                /* the old generation after the last full collection */
    size_t   old_limit;                     /* a full collection when the old generation outgrows it */
    double   full_end_cpu;                  /* the thread's CPU time when the last full collection ended */
    double   pause_since_full;              /* young pauses since then */
    double   growth;                        /* > 0: a fixed growth factor instead (env JS_GC_GROWTH) */
    size_t   nursery;
    size_t   min_heap;
    int      full_next;                     /* the next collection is full */
    int      collect_requested;             /* the next allocation collects, or marks a slice (external memory asked) */
    size_t   allocated_since_idle;          /* cells and external memory, until the last collection */
    bool     idle;                          /* the collection running is js_gc_idle's */
    size_t   heap_limit;                    /* 0 = unlimited; env JS_HEAP_LIMIT_MB */
    size_t   stress_interval, stress_counter;  /* JS_GC_STRESS builds; env JS_GC_STRESS_INTERVAL */
    size_t   stress_collections;
} JSHeap;

/* ---- Cell classes and tracing ---------------------------------------- */

typedef struct JSTracer JSTracer;

typedef struct JSCellClass {
    const char *name;
    void (*visit)(JSCell *cell, JSTracer *trc);      /* trace every JSValue the cell holds */
    void (*finalize)(JSRuntime *rt, JSCell *cell);   /* NULL for almost all kinds */
    /* Optional, for a large cell: trace what it holds in bytes [from, to) of the cell, at least.
     * Without it a young collection visits a large remembered cell whole. */
    void (*visit_range)(JSCell *cell, JSTracer *trc, size_t from, size_t to);
} JSCellClass;

/* Ignores non-cells and static cells. */
void js_trace_value(JSTracer *trc, JSValue v);
void js_trace_cell(JSTracer *trc, JSCell *cell);

/* ---- Allocation -------------------------------------------------------- */

/* Any size. Returns a zero-filled cell with its header set. Never NULL. */
JSCell *js_alloc_cell(JSContext *ctx, JSCellKind kind, size_t size);

void *js_alloc_slow(JSContext *ctx, unsigned size_class);

/* JS_CELL_VALUE_ARRAY: a fixed-length JSValue array, all JS_EMPTY initially. */
typedef struct JSValueArray {
    JSCell  cell;       /* aux = length */
    JSValue values[];
} JSValueArray;

JSValueArray *js_alloc_value_array(JSContext *ctx, uint32_t length);

/* JS_CELL_HOST: `size` bytes, starting with a JSHostCell, traced and finalized by `cls`. */
typedef struct JSHostCell {
    JSCell cell;
    const JSCellClass *cls;
} JSHostCell;

JSHostCell *js_alloc_host_cell(JSContext *ctx, const JSCellClass *cls, size_t size);

/* ---- Stores into heap cells (ABI hook) -------------------------------- */

/* js_store and js_store_range, the write barrier, are in jscontext.h: they read the context. */

/* The barrier's slow path: `owner` is old; when `c` is a young cell, remembers the owner, or the
 * card of a large one that `slot` is in (NULL: anywhere in it). */
void js_write_barrier_slow(JSContext *ctx, JSCell *owner, const void *slot, const JSCell *c);
/* Remembers an old `owner`, or `bytes` of a large one from `from`, whatever it was given. */
void js_remember(JSContext *ctx, JSCell *owner, const void *from, size_t bytes);

/* Initializing store into a cell allocated with no allocation in between: the cell is young, so
 * it needs no barrier. */
static inline void js_init_slot(JSValue *slot, JSValue v) { *slot = v; }

/* Keeps `v` visibly live to the conservative scan up to this point. */
#if defined(__GNUC__) || defined(__clang__)
#define js_keep_alive(v) __asm__ volatile("" ::"r"((v).bits))
#else
#define js_keep_alive(v) ((void)*(volatile uint64_t *)&(v).bits)
#endif

/* ---- Roots ------------------------------------------------------------- */

void js_register_roots(JSRuntime *rt, JSValue *slots, size_t n);  /* module globals, once */
/* A JSValue in malloc'd memory. It must hold a valid value (e.g. JS_UNDEFINED)
 * before it's added: any allocation may collect and read it. */
void js_add_root(JSRuntime *rt, JSValue *slot);
void js_remove_root(JSRuntime *rt, JSValue *slot);

/* ---- Control ----------------------------------------------------------- */

void js_gc(JSContext *ctx);        /* full collection: everything unreachable now (a marking in progress starts over) */
void js_gc_young(JSContext *ctx);  /* young collection: the cells allocated since the last one */

/* Incremental marking, started and stepped by allocation;
 * these drive it by hand, for tests. A slice marks about `bytes` bytes of cells, and runs the
 * final pause when there's nothing left. js_gc and js_gc_young finish a marking in progress. */
void js_gc_start_marking(JSContext *ctx);
bool js_gc_marking(const JSRuntime *rt);
void js_gc_mark_slice(JSContext *ctx, size_t bytes);

/* The program is idle: the event loop waited JS_GC_IDLE_MS with nothing to
 * do. When enough was allocated since the last time, js_gc_idle runs a full collection, finishes
 * the sweeping, and gives back to the OS what's free: the empty blocks, and malloc's memory. */
#define JS_GC_IDLE_MS 1000
bool js_gc_idle_wanted(const JSRuntime *rt);
void js_gc_idle(JSContext *ctx);

/* External memory: bytes outside the heap that a cell owns and frees in its
 * finalizer (an ArrayBuffer's), counted toward collections as if they were cells. `add` never
 * collects: when the count calls for a collection, the next allocation runs it. `sub` is for
 * the bytes freed, by the finalizer or before it. */
void js_gc_external_add(JSRuntime *rt, size_t bytes);
void js_gc_external_sub(JSRuntime *rt, size_t bytes);
/* malloc and free for memory a cell owns, counted as external memory: for libraries that take an
 * allocator (zlib, Brotli, zstd), whose frees don't say the size. NULL when out of memory. */
void *js_gc_external_malloc(JSRuntime *rt, size_t bytes);
void js_gc_external_free(JSRuntime *rt, void *p);

/* Exits with "heap limit reached" when the cells would need more than `bytes`. 0 = no limit. */
void js_set_heap_limit(JSRuntime *rt, size_t bytes);
/* Bytes currently committed for cells: blocks (empty ones included, decommitted ones not) and
 * large objects. */
size_t js_heap_size(const JSRuntime *rt);
/* The counters so far. */
const JSGCStats *js_gc_stats(const JSRuntime *rt);

#endif /* JS_GC_H */
