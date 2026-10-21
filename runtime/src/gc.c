/* Heap and garbage collector.
 *
 * Allocation bits say which cells hold a value. They are exact whenever the
 * world is stopped:
 *   - sweeping a block sets them to its mark bits (only survivors);
 *   - the allocator sets the bits of a word's free cells when it takes the
 *     word, since it may hand out any of them;
 *   - stopping the world clears the bits of the cells it didn't hand out.
 */
#include "js_gc.h"

#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_builtins.h"
#include "jscontext.h"
#include "os.h"

#if defined(__clang__) || defined(__GNUC__)
#define JS_NOINLINE __attribute__((noinline))
#define JS_ALWAYS_INLINE inline __attribute__((always_inline))
#define JS_NO_ASAN __attribute__((no_sanitize_address))
#else
#define JS_NOINLINE __declspec(noinline)
#define JS_ALWAYS_INLINE __forceinline
#define JS_NO_ASAN
#endif

const uint16_t js_size_class_bytes[JS_NUM_SIZE_CLASSES] = {
    16, 32, 48, 64, 80, 96, 112, 128,
    160, 192, 224, 256,
    320, 384, 448, 512,
    640, 768, 896, 1024,
    1280, 1536, 1792, 2048,
    2560, 3072, 3584, 4096,
    5120, 6144, 7168, 8192,
};

/* Edges wait in a FIFO this long while their cells are prefetched (a power of two). */
#define MARK_FIFO 32

/* A marker: its own mark stack, so several can mark at once. Visit
 * functions only read their cell and call js_trace_value / js_trace_cell. */
struct JSTracer {
    JSHeap  *heap;
    JSCell **stack;           /* the mark stack: marked cells to visit; grows, and goes back to the heap */
    size_t   sp, cap;
    size_t   base;            /* marking with others: the stack is [base, sp), given away from the bottom */
    JSCell  *fifo[MARK_FIFO]; /* edges not marked yet, their cells being prefetched */
    unsigned fifo_head, fifo_count;
    const void *stack_low;    /* the conservative scan covers [stack_low, stack_base) */
    size_t   marked;          /* cells this tracer marked */
    size_t   marked_bytes;
    JSCell  *partial;         /* incremental marking: a large cell visited a chunk at a time */
    size_t   partial_from;    /* the byte of it the next chunk starts at */
    bool     parallel;        /* other markers too: mark bits are set atomically */
#ifdef JS_GC_VERIFY
    const JSCell *visiting;   /* the cell whose children are being traced (NULL: a root) */
    bool     check_old;       /* verify_remembered: check the edges of old cells, don't mark */
    bool     check_black;     /* verify_marking: the same check, after an incremental marking */
#endif
};

_Noreturn void js_fatal(const char *fmt, ...) {
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    int n = snprintf(msg, sizeof msg, "jsrt: fatal: ");
    vsnprintf(msg + n, sizeof msg - (size_t)n - 1, fmt, ap);
    va_end(ap);
    strcat(msg, "\n");
    fputs(msg, stderr);  /* one write, so the message arrives whole */
    exit(70);            /* EX_SOFTWARE */
}

static void *xrealloc(void *p, size_t size) {
    void *q = realloc(p, size);
    if (!q) js_fatal("out of memory (%zu bytes of GC metadata)", size);
    return q;
}

/* Every cell address must fit in 48 bits: a value holds a cell pointer in its low 48. */
static void check_address(const void *p, size_t size) {
    if ((uintptr_t)p + size > (UINT64_C(1) << 48))
        js_fatal("heap memory mapped above 2^48 (%p)", p);
}

/* ---- Cell classes ------------------------------------------------------ */

static const JSCellClass value_array_class = { "ValueArray", NULL, NULL, NULL };  /* gc_visit.h visits it */

static const JSCellClass bigint_class = { "BigInt", NULL, NULL, NULL };  /* limbs only */

static const JSCellClass *const cell_classes[JS_CELL_KIND_COUNT] = {
    [JS_CELL_STR_FLAT] = &js_flat_string_class,
    [JS_CELL_STR_ROPE] = &js_rope_class,
    [JS_CELL_STR_SLICE] = &js_slice_class,
    [JS_CELL_VALUE_ARRAY] = &value_array_class,
    [JS_CELL_SHAPE] = &js_shape_cell_class,
    [JS_CELL_ACCESSOR] = &js_accessor_cell_class,
    [JS_CELL_ELEMENTS] = &js_elements_cell_class,
    [JS_CELL_ENV] = &js_env_cell_class,
    [JS_CELL_SYMBOL] = &js_symbol_cell_class,
    [JS_CELL_BIGINT] = &bigint_class,
    [JS_CELL_OBJECT] = &js_object_cell_class,
    [JS_CELL_ARRAY] = &js_object_cell_class,
    [JS_CELL_FUNCTION] = &js_object_cell_class,
};

static const JSCellClass *class_of(JSCell *c) {
    return c->kind == JS_CELL_HOST ? ((JSHostCell *)c)->cls : cell_classes[c->kind];
}

/* ---- Bitmaps ----------------------------------------------------------- */

static char *block_cell(JSBlock *b, uint32_t i) {
    return (char *)b + JS_BLOCK_FIRST_CELL + (size_t)i * b->cell_size;
}

/* A multiply, not a divide: the marker computes this for every edge. Exact, since offsets are
 * below 2^16 and sizes below 2^14 (offset * size < 2^32). A large object's magic is 0: its cell
 * is the only one. */
static uint32_t cell_index(const JSBlock *b, const void *c) {
    uint64_t offset = (uint64_t)((const char *)c - (const char *)b - JS_BLOCK_FIRST_CELL);
    return (uint32_t)((offset * b->index_magic) >> 32);
}

static int bit_get(const uint64_t *bits, uint32_t i) { return (int)((bits[i / 64] >> (i % 64)) & 1); }

/* Without -mpopcnt (the default x86-64 target), __builtin_popcountll is a library call. */
static unsigned popcount64(uint64_t x) {
    x -= (x >> 1) & UINT64_C(0x5555555555555555);
    x = (x & UINT64_C(0x3333333333333333)) + ((x >> 2) & UINT64_C(0x3333333333333333));
    x = (x + (x >> 4)) & UINT64_C(0x0F0F0F0F0F0F0F0F);
    return (unsigned)((x * UINT64_C(0x0101010101010101)) >> 56);
}

/* Mark bits while several markers run: relaxed atomics. The
 * packets that hand cells between markers go through a lock, which orders the rest. */
#if defined(_MSC_VER) && !defined(__clang__)
static inline uint64_t atomic_or64(uint64_t *p, uint64_t v) { return (uint64_t)_InterlockedOr64((volatile long long *)p, (long long)v); }
static inline uint64_t atomic_load64(const uint64_t *p) { return *(const volatile uint64_t *)p; }
static inline int atomic_load_int(const int *p) { return *(const volatile int *)p; }
static inline void atomic_store_int(int *p, int v) { *(volatile int *)p = v; }
#else
static inline uint64_t atomic_or64(uint64_t *p, uint64_t v) { return __atomic_fetch_or(p, v, __ATOMIC_RELAXED); }
static inline uint64_t atomic_load64(const uint64_t *p) { return __atomic_load_n(p, __ATOMIC_RELAXED); }
static inline int atomic_load_int(const int *p) { return __atomic_load_n(p, __ATOMIC_RELAXED); }
static inline void atomic_store_int(int *p, int v) { __atomic_store_n(p, v, __ATOMIC_RELAXED); }
#endif

#ifdef JS_GC_VERIFY
/* A dead cell is filled with POISON: allocation checks that nothing wrote it after it died, and
 * the marker that nothing still points to it. */
#define POISON 0xDB

static void poison(void *c, uint32_t size) { memset(c, POISON, size); }

static void check_poison(const void *c, uint32_t size) {
    const unsigned char *p = c;
    for (uint32_t i = 0; i < size; i++)
        if (p[i] != POISON)
            js_fatal("GC verify: a dead cell (%u bytes at %p) was written at offset %u after it died", size, c, i);
}
#endif

/* ---- Block set: which 64 KiB chunks are small-object blocks ------------ */

static size_t block_hash(uintptr_t b) {
    uint64_t x = (uint64_t)(b >> 16) * UINT64_C(0x9E3779B97F4A7C15);
    return (size_t)(x >> 32);
}

static void bloom_add(JSHeap *h, uintptr_t b) {
    size_t bit = block_hash(b) & 255;
    h->block_bloom[bit / 64] |= UINT64_C(1) << (bit % 64);
}

static int bloom_maybe(const JSHeap *h, uintptr_t b) {
    size_t bit = block_hash(b) & 255;
    return (int)((h->block_bloom[bit / 64] >> (bit % 64)) & 1);
}

static void block_set_put(uintptr_t *keys, size_t cap, uintptr_t b) {
    size_t i = block_hash(b) & (cap - 1);
    while (keys[i]) i = (i + 1) & (cap - 1);
    keys[i] = b;
}

static void block_set_add(JSHeap *h, uintptr_t b) {
    if (2 * (h->block_set_count + 1) > h->block_set_cap) {  /* load factor <= 1/2 */
        size_t cap = h->block_set_cap ? h->block_set_cap * 2 : 64;
        uintptr_t *keys = calloc(cap, sizeof *keys);
        if (!keys) js_fatal("out of memory growing the block set");
        for (size_t i = 0; i < h->block_set_cap; i++)
            if (h->block_set[i]) block_set_put(keys, cap, h->block_set[i]);
        free(h->block_set);
        h->block_set = keys;
        h->block_set_cap = cap;
    }
    block_set_put(h->block_set, h->block_set_cap, b);
    h->block_set_count++;
    bloom_add(h, b);
}

static int block_set_contains(const JSHeap *h, uintptr_t b) {
    if (!h->block_set_cap || !bloom_maybe(h, b)) return 0;
    for (size_t i = block_hash(b) & (h->block_set_cap - 1);; i = (i + 1) & (h->block_set_cap - 1)) {
        if (h->block_set[i] == b) return 1;
        if (!h->block_set[i]) return 0;
    }
}

/* Linear probing: shift later entries of the probe run back into the hole. */
static void block_set_remove(JSHeap *h, uintptr_t b) {
    size_t mask = h->block_set_cap - 1, i = block_hash(b) & mask;
    while (h->block_set[i] != b) {
        if (!h->block_set[i]) return;
        i = (i + 1) & mask;
    }
    h->block_set[i] = 0;
    h->block_set_count--;
    for (size_t j = (i + 1) & mask; h->block_set[j]; j = (j + 1) & mask) {
        size_t home = block_hash(h->block_set[j]) & mask;
        int stays = i <= j ? (i < home && home <= j) : (i < home || home <= j);
        if (!stays) {
            h->block_set[i] = h->block_set[j];
            h->block_set[j] = 0;
            i = j;
        }
    }
    /* The Bloom filter keeps the bit: it only ever answers "maybe". */
}

static void note_heap_size(JSHeap *h) {
    size_t size = (h->block_count - h->decommitted_count) * JS_BLOCK_SIZE + h->large_bytes;
    if (size > h->stats.peak_heap_bytes) h->stats.peak_heap_bytes = size;
}

static void note_mapping(JSHeap *h, const void *p, size_t size) {
    uintptr_t lo = (uintptr_t)p, hi = lo + size;
    if (!h->min_addr || lo < h->min_addr) h->min_addr = lo;
    if (hi > h->max_addr) h->max_addr = hi;
}

/* ---- Small-object blocks ----------------------------------------------- */

static JSBlock *map_block(JSHeap *h) {
    JSBlock *b = js_os_map_aligned(JS_BLOCK_SIZE, JS_BLOCK_SIZE);
    if (!b) js_fatal("out of memory mapping a heap block");
    check_address(b, JS_BLOCK_SIZE);
    note_mapping(h, b, JS_BLOCK_SIZE);
    block_set_add(h, (uintptr_t)b);
    h->block_count++;
    note_heap_size(h);
    return b;
}

/* Gives an empty block to size class `sc`, every cell free. */
static void block_init(JSHeap *h, JSBlock *b, unsigned sc) {
    uint32_t size = js_size_class_bytes[sc];
    memset(b, 0, sizeof *b);
    b->map_size = JS_BLOCK_SIZE;
    b->cell_size = size;
    b->cell_count = (uint32_t)((JS_BLOCK_SIZE - JS_BLOCK_FIRST_CELL) / size);
    b->size_class = (uint8_t)sc;
    b->index_magic = (uint32_t)(((UINT64_C(1) << 32) + size - 1) / size);
#ifdef JS_GC_VERIFY
    for (uint32_t i = 0; i < b->cell_count; i++) {
        char *c = block_cell(b, i);
        poison(c, size);
        if (cell_index(b, c) != i || cell_index(b, c + size - 1) != i)
            js_fatal("GC verify: cell %u of a %u-byte block has index %u", i, size, cell_index(b, c));
    }
#endif
    b->prev = NULL;
    b->next = h->blocks[sc];
    if (b->next) b->next->prev = b;
    h->blocks[sc] = b;
}

static void unlink_block(JSHeap *h, JSBlock *b) {
    if (b->prev) b->prev->next = b->next;
    else h->blocks[b->size_class] = b->next;
    if (b->next) b->next->prev = b->prev;
}

static void list_push(struct JSBlockList *l, JSBlock *b) {
    if (l->count == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 64;
        l->items = xrealloc(l->items, l->cap * sizeof *l->items);
    }
    l->items[l->count++] = b;
}

static void queue_sweep(JSHeap *h, JSBlock *b) {
    if (b->queued) return;
    b->queued = 1;
    list_push(&h->to_sweep[b->size_class], b);
}

static void finalize_cell(JSRuntime *rt, JSCell *c) {
    const JSCellClass *cls = class_of(c);
    if (cls->finalize) cls->finalize(rt, c);
}

/* Sweeps `b`: its survivors (the marked cells) become its allocated cells, and the rest are free
 * for the allocator. A word of the bitmap at a time, and no dead cell is written (checking builds
 * poison the cells that died). finalize_dead already ran the dead cells' finalizers. Returns how
 * many survived. */
static uint32_t sweep_block(JSBlock *b) {
    uint32_t live = 0, words = (b->cell_count + 63) / 64;
    for (uint32_t w = 0; w < words; w++) {
#ifdef JS_GC_VERIFY
        for (uint64_t died = b->alloc_bits[w] & ~b->mark_bits[w]; died; died &= died - 1)
            poison(block_cell(b, w * 64 + js_ctz64(died)), b->cell_size);
#endif
        b->alloc_bits[w] = b->mark_bits[w];
        live += popcount64(b->mark_bits[w]);
    }
    if (!live) b->has_finalizable = 0;
    return live;
}

static void unmap_block(JSHeap *h, JSBlock *b) {
    block_set_remove(h, (uintptr_t)b);
    js_os_unmap(b, JS_BLOCK_SIZE);
    h->block_count--;
}

/* Gives an empty block's pages back to the OS. Its address stays mapped, for the allocator to
 * reuse before it maps a new block; it's out of the block set, being no cells' block now. */
static void decommit_block(JSHeap *h, JSBlock *b) {
    block_set_remove(h, (uintptr_t)b);
    js_os_decommit(b, JS_BLOCK_SIZE);
    if (h->decommitted_count == h->decommitted_cap) {
        h->decommitted_cap = h->decommitted_cap ? h->decommitted_cap * 2 : 64;
        h->decommitted = xrealloc(h->decommitted, h->decommitted_cap * sizeof *h->decommitted);
    }
    h->decommitted[h->decommitted_count++] = (struct JSDecommitted){ b, h->full_count };
}

/* A block for the allocator: a decommitted one (the most recent), or a new mapping. Zero-filled
 * either way. */
static JSBlock *new_block(JSHeap *h) {
    if (!h->decommitted_count) return map_block(h);
    JSBlock *b = h->decommitted[--h->decommitted_count].block;
    if (!js_os_commit(b, JS_BLOCK_SIZE)) js_fatal("out of memory committing a heap block");
    block_set_add(h, (uintptr_t)b);
    note_heap_size(h);
    return b;
}

/* After a full collection: unmaps the decommitted blocks no allocation took since the one before. */
static void unmap_unused_blocks(JSHeap *h) {
    size_t kept = 0;
    for (size_t i = 0; i < h->decommitted_count; i++) {
        struct JSDecommitted d = h->decommitted[i];
        if (d.full_count + 1 < h->full_count) {
            js_os_unmap(d.block, JS_BLOCK_SIZE);
            h->block_count--;
        } else {
            h->decommitted[kept++] = d;
        }
    }
    h->decommitted_count = kept;
}

/* Keeps empty blocks for reuse by any class, as many as the program allocates before the next
 * collection (the nursery): the heap grows that far before then anyway, and a block given back now
 * would have its pages faulted in again one by one. The rest go back to the OS. */
static void release_empty_block(JSHeap *h, JSBlock *b) {
    if (h->empty_count >= h->nursery / JS_BLOCK_SIZE) {
        decommit_block(h, b);
        return;
    }
    b->next = h->empty;
    h->empty = b;
    h->empty_count++;
}

/* Sweeps the next queued block of class `sc`. Returns false when there is none; otherwise sets
 * *out to the block if it has free cells, or to NULL: it's full, or empty and in the pool. An empty
 * block stays in its class when the class is allocating (`allocating`). */
static bool sweep_next(JSRuntime *rt, unsigned sc, bool allocating, JSBlock **out) {
    JSHeap *h = &rt->heap;
    struct JSBlockList *q = &h->to_sweep[sc];
    if (!q->count) return false;
    JSBlock *b = q->items[--q->count];
    b->queued = 0;
    double t0 = h->report ? js_os_now_ms_precise() : 0;
    uint32_t live = sweep_block(b);
    if (h->report) h->stats.sweep_ms += js_os_now_ms_precise() - t0;
    h->stats.blocks_swept++;
    *out = live < b->cell_count ? b : NULL;
    if (!live && !allocating) {
        unlink_block(h, b);  /* an empty block can serve any class */
        release_empty_block(h, b);
        *out = NULL;
    }
    return true;
}

static int should_collect(const JSHeap *h) {
    return h->allocated_since_gc + h->external_since_gc > h->nursery;
}

static int over_limit(const JSRuntime *rt, size_t more) {
    return rt->heap.heap_limit && js_heap_size(rt) + more > rt->heap.heap_limit;
}

static _Noreturn void heap_limit_reached(const JSHeap *h) {
    js_fatal("heap limit reached (%zu MiB)", h->heap_limit >> 20);
}

static void collect_as_needed(JSContext *ctx, bool near_limit);
static void collect_spilled(JSContext *ctx, bool full);
static void mark_slice(JSContext *ctx, size_t budget);
static void start_marking(JSContext *ctx);
static size_t allocation_clock(const JSHeap *h);
static void gc_poll(JSContext *ctx);
static void finish_sweeping(JSRuntime *rt);

#ifdef JS_GC_STRESS
/* Collects on every allocation (every JS_GC_STRESS_INTERVAL-th). */
static void stress_tick(JSContext *ctx) {
    JSHeap *h = &ctx->rt->heap;
    if (!h->in_gc && ++h->stress_counter >= h->stress_interval) {
        h->stress_counter = 0;
        if (h->marker) {  /* a small slice: the marking spans many allocations, and their stores */
            mark_slice(ctx, 4096);
            return;
        }
        switch (++h->stress_collections % 8) {  /* every 4th is full: stopping the world, or incremental */
        case 0: js_gc(ctx); break;
        case 4: if (h->incremental) start_marking(ctx); else js_gc(ctx); break;
        default: js_gc_young(ctx); break;
        }
    }
}
#endif

/* ---- Allocation: a word of the bitmap at a time ---------------------- */

/* Lazily sweeps blocks of class `sc` until one has free cells; NULL if none does. */
static JSBlock *sweep_for(JSRuntime *rt, unsigned sc) {
    JSBlock *b;
    while (sweep_next(rt, sc, true, &b))
        if (b) return b;
    return NULL;
}

static void use_block(JSHeap *h, JSAllocator *a, JSBlock *b, bool fresh) {
    if (!b->young) {
        b->young = 1;
        list_push(&h->young_blocks, b);
    }
    a->block = b;
    a->word = 0;
    a->fresh = fresh;
}

#ifndef JS_GC_VERIFY
/* Zeroes the window's free cells, a run of them at a time. */
static void zero_window(const JSAllocator *a) {
    for (uint64_t m = a->free; m;) {
        unsigned start = js_ctz64(m);
        uint64_t rest = ~(m >> start);  /* its lowest set bit ends the run */
        unsigned n = rest ? js_ctz64(rest) : 64 - start;
        memset((void *)(a->base + start * a->cell_size), 0, n * a->cell_size);
        if (start + n >= 64) break;
        m &= ~UINT64_C(0) << (start + n);
    }
}
#endif

/* Takes the block's next word with free cells, after a->word. Returns false when it has none. */
static bool next_window(JSHeap *h, JSAllocator *a) {
    JSBlock *b = a->block;
    uint32_t words = (b->cell_count + 63) / 64;
    for (uint32_t w = a->word; w < words; w++) {
        uint64_t free = ~b->alloc_bits[w];
        if (w == words - 1 && b->cell_count % 64) free &= (UINT64_C(1) << (b->cell_count % 64)) - 1;
        if (!free) continue;
        b->alloc_bits[w] |= free;  /* any of them may be handed out */
        a->free = free;
        a->base = (uintptr_t)block_cell(b, w * 64);
        a->word = w + 1;
        h->allocated_since_gc += (size_t)popcount64(free) * b->cell_size;
#ifndef JS_GC_VERIFY
        if (!a->fresh) zero_window(a);  /* checking builds zero a cell when it's handed out */
#endif
        return true;
    }
    return false;
}

/* Gives class `sc` a window of free cells when its block has none left: the next swept block with
 * free cells, an empty block, a collection, or a new block, in that order. A young collection
 * comes when the heap would grow, not at every block: after a full collection the blocks' free
 * room serves as a larger nursery (checking the nursery at every block was measured: binary-trees
 * promoted its trees half-built, and collected 2.4 times as long). Not inlined: the slow path's
 * common case is the block's next word, and stays small. */
static JS_NOINLINE void refill(JSContext *ctx, unsigned sc) {
    JSRuntime *rt = ctx->rt;
    JSHeap *h = &rt->heap;
    JSAllocator *a = &h->alloc[sc];
    bool collected = false, collected_full = false;  /* the heap limit's error comes after a full one */
    for (;;) {
        JSBlock *b = sweep_for(rt, sc);
        if (!b && h->ready[sc].count) b = h->ready[sc].items[--h->ready[sc].count];
        if (b) {
            use_block(h, a, b, false);
            if (next_window(h, a)) return;
            continue;  /* can't happen: sweep_for's blocks have free cells */
        }
        if ((b = h->empty)) {
            h->empty = b->next;
            h->empty_count--;
            block_init(h, b, sc);
            use_block(h, a, b, false);
            next_window(h, a);
            return;
        }
        bool near_limit = over_limit(rt, JS_BLOCK_SIZE);
        bool young_due = !collected && !h->marker && should_collect(h);  /* a marking has slices instead */
        if (!h->in_gc && (young_due || (near_limit && !collected_full))) {
            collected = true;
            collected_full |= near_limit || h->full_next;
            collect_as_needed(ctx, near_limit);  /* stops allocation: `a` has no block now */
            continue;
        }
        if (over_limit(rt, JS_BLOCK_SIZE)) heap_limit_reached(h);
        b = new_block(h);
        block_init(h, b, sc);
#ifdef JS_GC_VERIFY
        use_block(h, a, b, false);  /* poisoned */
#else
        use_block(h, a, b, true);
#endif
        next_window(h, a);
        return;
    }
}

/* The window is used up: take the block's next word, or refill. Checking builds take every
 * allocation here (js_alloc_small). */
void *js_alloc_slow(JSContext *ctx, unsigned sc) {
#ifdef JS_GC_STRESS
    stress_tick(ctx);
#endif
    JSHeap *h = &ctx->rt->heap;
    if (JS_UNLIKELY(h->collect_requested || h->marker) && !h->in_gc) gc_poll(ctx);
    JSAllocator *a = &h->alloc[sc];
    if (!a->free && !(a->block && next_window(h, a))) refill(ctx, sc);
    uint64_t free = a->free;
    a->free = free & (free - 1);
    void *c = (void *)(a->base + js_ctz64(free) * a->cell_size);
#ifdef JS_GC_VERIFY
    check_poison(c, (uint32_t)a->cell_size);
    memset(c, 0, a->cell_size);
#endif
    return c;
}

/* ---- Large objects ----------------------------------------------------- */

/* Dead large objects' mappings, kept for the next large objects as the empty-block pool is for
 * blocks, up to a nursery's worth: a large object mapped anew is a system call to map it, one to
 * unmap it, and a page fault per page it uses. Counted in large_bytes (malloc'd). */
static void unmap_large_cache(JSHeap *h) {
    for (size_t i = 0; i < h->large_cache_count; i++) {
        h->large_bytes -= h->large_cache[i]->map_size;
        js_os_unmap(h->large_cache[i], h->large_cache[i]->map_size);
    }
    h->large_cache_count = 0;
    h->large_cache_bytes = 0;
}

static void cache_large(JSHeap *h, JSBlock *b) {
    if (h->large_cache_bytes + b->map_size > h->nursery) {
        h->large_bytes -= b->map_size;
        js_os_unmap(b, b->map_size);
        return;
    }
    if (h->large_cache_count == h->large_cache_cap) {
        h->large_cache_cap = h->large_cache_cap ? h->large_cache_cap * 2 : 16;
        h->large_cache = xrealloc(h->large_cache, h->large_cache_cap * sizeof *h->large_cache);
    }
    h->large_cache[h->large_cache_count++] = b;
    h->large_cache_bytes += b->map_size;
}

/* The smallest cached mapping of at least `map_size` bytes that wastes at most a quarter, zeroed
 * as far as the cell goes; NULL if none. */
static JSBlock *reuse_large(JSHeap *h, size_t map_size, size_t size) {
    size_t best = SIZE_MAX;
    for (size_t i = 0; i < h->large_cache_count; i++) {
        size_t m = h->large_cache[i]->map_size;
        if (m >= map_size && m <= map_size + map_size / 4 && (best == SIZE_MAX || m < h->large_cache[best]->map_size)) best = i;
    }
    if (best == SIZE_MAX) return NULL;
    JSBlock *b = h->large_cache[best];
    h->large_cache[best] = h->large_cache[--h->large_cache_count];
    h->large_cache_bytes -= b->map_size;
    size_t mapped = b->map_size;
    memset(b, 0, JS_BLOCK_FIRST_CELL + size);
    b->map_size = mapped;
    return b;
}

/* Returns empty blocks and cached mappings to the OS to make room under the heap limit. */
static void drain_empty_pool(JSHeap *h) {
    while (h->empty) {
        JSBlock *b = h->empty;
        h->empty = b->next;
        h->empty_count--;
        unmap_block(h, b);
    }
    unmap_large_cache(h);
}

static JSCell *alloc_large(JSContext *ctx, size_t size) {
    JSRuntime *rt = ctx->rt;
    JSHeap *h = &rt->heap;
    size_t page = js_os_page_size();
    size_t map_size = (JS_BLOCK_FIRST_CELL + size + page - 1) & ~(page - 1);
#ifdef JS_GC_STRESS
    stress_tick(ctx);
#endif
    if (!h->in_gc) {
        if (over_limit(rt, map_size) || (!h->marker && should_collect(h))) collect_as_needed(ctx, over_limit(rt, map_size));
        else if (h->marker) gc_poll(ctx);
    }
    JSBlock *b = reuse_large(h, map_size, size);
    if (b) {
        map_size = b->map_size;
    } else {
        if (over_limit(rt, map_size)) {  /* what the collection freed, out of the lazy sweeping's queues */
            finish_sweeping(rt);
            drain_empty_pool(h);
        }
        if (over_limit(rt, map_size)) heap_limit_reached(h);
        b = js_os_map_aligned(map_size, JS_BLOCK_SIZE);  /* zero-filled */
        if (!b) js_fatal("out of memory allocating %zu bytes", size);
        check_address(b, map_size);
        note_mapping(h, b, map_size);
        b->map_size = map_size;
        h->large_bytes += map_size;
    }
    h->allocated_since_gc += map_size;
    b->cell_size = (uint32_t)(size <= UINT32_MAX ? size : UINT32_MAX);
    b->cell_count = 1;
    b->is_large = 1;
    uint8_t shift = 9;  /* cards of 512 bytes, or more for a very large object */
    while ((size + ((size_t)1 << shift) - 1) >> shift > JS_LARGE_CARDS) shift++;
    b->card_shift = shift;
    b->large_alloc = 1;

    if (h->large_count == h->large_cap) {
        h->large_cap = h->large_cap ? h->large_cap * 2 : 16;
        h->large = xrealloc(h->large, h->large_cap * sizeof *h->large);
    }
    size_t i = h->large_count;  /* keep sorted by address */
    while (i > 0 && h->large[i - 1] > b) {
        h->large[i] = h->large[i - 1];
        i--;
    }
    h->large[i] = b;
    h->large_count++;
    note_heap_size(h);
    return (JSCell *)block_cell(b, 0);
}

static void sweep_large(JSRuntime *rt) {
    JSHeap *h = &rt->heap;
    size_t kept = 0;
    for (size_t i = 0; i < h->large_count; i++) {
        JSBlock *b = h->large[i];
        if (b->mark_bits[0] & 1) {
            h->large[kept++] = b;
            continue;
        }
        cache_large(h, b);
    }
    h->large_count = kept;
}

/* ---- Allocation entry points ------------------------------------------- */

JSCell *js_alloc_cell(JSContext *ctx, JSCellKind kind, size_t size) {
    JSCell *c = size <= JS_MAX_SMALL_SIZE ? js_alloc_small(ctx, js_size_class(size))
                                          : alloc_large(ctx, size);
    c->kind = (uint8_t)kind;
    return c;
}

JSValueArray *js_alloc_value_array(JSContext *ctx, uint32_t length) {
    JSCell *c = js_alloc_cell(ctx, JS_CELL_VALUE_ARRAY,
                              sizeof(JSValueArray) + (size_t)length * sizeof(JSValue));
    c->aux = length;
    return (JSValueArray *)c;
}

JSHostCell *js_alloc_host_cell(JSContext *ctx, const JSCellClass *cls, size_t size) {
    if (size < sizeof(JSHostCell)) size = sizeof(JSHostCell);
    JSHostCell *h = (JSHostCell *)js_alloc_cell(ctx, JS_CELL_HOST, size);
    h->cls = cls;
    if (cls->finalize) {
        h->cell.flags |= JS_CELL_FINALIZABLE;
        js_block_of(h)->has_finalizable = 1;
    }
    return h;
}

/* ---- External memory --------------------------------------------------- */

static void stop_allocation(JSHeap *h);

/* Counted as allocated since the last collection, as cells are. A collection can't run here (the
 * caller may be between allocating its bytes and the cell that owns them): stopping allocation
 * sends the next allocation, in any size class, to the slow path, which collects. */
void js_gc_external_add(JSRuntime *rt, size_t bytes) {
    JSHeap *h = &rt->heap;
    h->external_bytes += bytes;
    h->external_since_gc += bytes;
    if (h->external_bytes > h->stats.peak_external_bytes) h->stats.peak_external_bytes = h->external_bytes;
    if (!h->in_gc && !h->collect_requested && (h->marker ? allocation_clock(h) >= h->next_slice : should_collect(h))) {
        h->collect_requested = 1;
        stop_allocation(h);
    }
}

void js_gc_external_sub(JSRuntime *rt, size_t bytes) {
    JSHeap *h = &rt->heap;
#ifdef JS_GC_VERIFY
    if (bytes > h->external_bytes) js_fatal("GC verify: %zu external bytes freed, but only %zu counted", bytes, h->external_bytes);
#endif
    h->external_bytes -= bytes < h->external_bytes ? bytes : h->external_bytes;
}

/* The size goes in a header before the bytes, a max_align_t's worth so they stay aligned. */
#define EXTERNAL_HEADER sizeof(max_align_t)

void *js_gc_external_malloc(JSRuntime *rt, size_t bytes) {
    if (bytes > SIZE_MAX - EXTERNAL_HEADER) return NULL;
    char *p = malloc(EXTERNAL_HEADER + bytes);
    if (!p) return NULL;
    *(size_t *)p = bytes;
    js_gc_external_add(rt, bytes);
    return p + EXTERNAL_HEADER;
}

void js_gc_external_free(JSRuntime *rt, void *p) {
    if (!p) return;
    char *start = (char *)p - EXTERNAL_HEADER;
    js_gc_external_sub(rt, *(size_t *)start);
    free(start);
}

/* ---- Roots ------------------------------------------------------------- */

void js_register_roots(JSRuntime *rt, JSValue *slots, size_t n) {
    JSHeap *h = &rt->heap;
    if (h->root_table_count == h->root_table_cap) {
        h->root_table_cap = h->root_table_cap ? h->root_table_cap * 2 : 8;
        h->root_tables = xrealloc(h->root_tables, h->root_table_cap * sizeof *h->root_tables);
    }
    h->root_tables[h->root_table_count++] = (struct JSRootTable){ slots, n };
}

void js_add_root(JSRuntime *rt, JSValue *slot) {
    JSHeap *h = &rt->heap;
    if (h->root_count == h->root_cap) {
        h->root_cap = h->root_cap ? h->root_cap * 2 : 16;
        h->roots = xrealloc(h->roots, h->root_cap * sizeof *h->roots);
    }
    h->roots[h->root_count++] = slot;
}

void js_remove_root(JSRuntime *rt, JSValue *slot) {
    JSHeap *h = &rt->heap;
    for (size_t i = h->root_count; i-- > 0;) {
        if (h->roots[i] == slot) {
            h->roots[i] = h->roots[--h->root_count];
            return;
        }
    }
}

/* ---- Generations: the write barrier's remembered set ------------------- */

static bool is_object_kind(const JSCell *c) {
    return c->kind == JS_CELL_OBJECT || c->kind == JS_CELL_ARRAY || c->kind == JS_CELL_FUNCTION;
}

static void push_remembered(JSHeap *h, JSCell *c) {
    if (h->remembered_count == h->remembered_cap) {
        h->remembered_cap = h->remembered_cap ? h->remembered_cap * 2 : 1024;
        h->remembered = xrealloc(h->remembered, h->remembered_cap * sizeof *h->remembered);
    }
    h->remembered[h->remembered_count++] = c;
}

/* Marks the cards of large `c` that bytes [from, from + bytes) are in; all of them when `from` is
 * NULL or outside the cell (malloc'd memory its visit traces). It stays JS_GC_OLD_LARGE, so its
 * next stores of young cells mark their own cards. */
static void mark_cards(JSHeap *h, JSCell *c, const void *from, size_t bytes) {
    JSBlock *b = js_block_of(c);
    unsigned shift = b->card_shift;
    size_t size = b->cell_size, off = (size_t)((const char *)from - (const char *)c);
    if (!from || (const char *)from < (const char *)c || off >= size) off = 0, bytes = size;
    if (!bytes) bytes = 1;
    size_t last = (off + bytes - 1 < size ? off + bytes - 1 : size - 1) >> shift;
    for (size_t k = off >> shift; k <= last; k++) b->cards[k / 64] |= UINT64_C(1) << (k % 64);
    if (!b->remembered) {
        b->remembered = 1;
        push_remembered(h, c);
    }
}

static void remember_one(JSHeap *h, JSCell *c) {
    if (c->gc == JS_GC_OLD_LARGE) {
        mark_cards(h, c, NULL, 0);
        return;
    }
    c->gc = JS_GC_REMEMBERED;  /* below the barrier's threshold: its next stores are fast */
    push_remembered(h, c);
}

/* An object's out-of-line slots are stored with the object as the owner (js_object_slot), so
 * remembering an object remembers them too, while they're old: then the next stores, which skip
 * the barrier, are covered. A new slot array is young. Remembering the array itself, not the
 * object, keeps it exact: an array the object drops still keeps what it was given until the next
 * young collection, as every remembered cell does. */
static JS_NOINLINE void remember(JSHeap *h, JSCell *c) {
    remember_one(h, c);
    if (is_object_kind(c)) {
        JSValueArray *ool = ((JSObject *)c)->ool;
        if (ool && ool->cell.gc >= JS_GC_OLD) remember_one(h, &ool->cell);
    }
}

static void shade(JSTracer *trc, JSCell *c);

/* During an incremental marking the barrier marks what's stored
 * (Dijkstra's): a cell the marker has visited never gets an unmarked one behind its back. The
 * slow path runs for every owner at or above JS_GC_OLD, which every marked cell is (mark sets
 * it), and old cells the marker hasn't reached yet: marking what they're given only keeps it
 * one collection longer. There are no young collections during a marking, so nothing is
 * remembered. */
void js_write_barrier_slow(JSContext *ctx, JSCell *owner, const void *slot, const JSCell *c) {
    JSHeap *h = &ctx->rt->heap;
    if (JS_UNLIKELY(h->marker)) {
        shade(h->marker, (JSCell *)c);
        return;
    }
    if (c->gc != JS_GC_YOUNG || js_cell_is_static(c)) return;
    if (owner->gc == JS_GC_OLD) remember(h, owner);
    else if (owner->gc == JS_GC_OLD_LARGE) mark_cards(h, owner, slot, sizeof(JSValue));
}

/* js_store_range's: `from` is `bytes` of JSValues. */
void js_remember(JSContext *ctx, JSCell *owner, const void *from, size_t bytes) {
    JSHeap *h = &ctx->rt->heap;
    if (JS_UNLIKELY(h->marker)) {
        const JSValue *v = from;
        for (size_t i = 0; i < bytes / sizeof *v; i++)
            if (js_is_cell(v[i])) shade(h->marker, js_as_cell(v[i]));
        return;
    }
    if (owner->gc == JS_GC_OLD) remember(h, owner);
    else if (owner->gc == JS_GC_OLD_LARGE) mark_cards(h, owner, from, bytes);
}

/* ---- Marking ----------------------------------------------------------- */

#ifdef JS_GC_VERIFY
static JSCell *find_cell(const JSHeap *h, uintptr_t w);
static JSBlock *find_large(const JSHeap *h, uintptr_t w);

static const char *kind_name(const JSCell *c) {
    if (!c) return "a root";
    if (c->kind == JS_CELL_HOST) return ((const JSHostCell *)c)->cls->name;
    return c->kind > JS_CELL_INVALID && c->kind < JS_CELL_KIND_COUNT ? cell_classes[c->kind]->name : "a cell of no kind";
}

static bool in_heap(const JSHeap *h, uintptr_t w) {
    return w >= h->min_addr && w < h->max_addr &&
           (block_set_contains(h, w & ~(uintptr_t)(JS_BLOCK_SIZE - 1)) || find_large(h, w));
}

/* Every pointer the marker follows must be a static cell outside the heap, or the start of a cell
 * in it that's allocated and has a kind. Which one is decided by the address: a dead cell's header
 * is stale (or poison), and its bits can read as the static flag. Returns whether `c` is static. */
static bool verify_edge(const JSTracer *trc, const JSCell *c) {
    const char *what = NULL;
    if (!in_heap(trc->heap, (uintptr_t)c)) {
        if (js_cell_is_static(c)) return true;
        what = "not in the heap, and not a static cell";
    } else {
        JSCell *found = find_cell(trc->heap, (uintptr_t)c);
        if (!found) what = "not an allocated cell (dead, or not in the heap)";
        else if (found != c) what = "inside a cell, not at its start";
        else if (c->kind == JS_CELL_INVALID || c->kind >= JS_CELL_KIND_COUNT) what = "a cell with no valid kind";
        else if (js_cell_is_static(c)) what = "a heap cell flagged static";
    }
    if (what) js_fatal("GC verify: %s %p points to %p, which is %s", kind_name(trc->visiting), (const void *)trc->visiting, (const void *)c, what);
    return false;
}
#endif

/* Kinds that hold no cells: marked, never pushed or visited. */
static const bool leaf_kind[JS_CELL_KIND_COUNT] = { [JS_CELL_STR_FLAT] = true, [JS_CELL_BIGINT] = true };

static bool has_children(const JSCell *c) {
    return !leaf_kind[c->kind] && !(c->kind == JS_CELL_HOST && !((const JSHostCell *)c)->cls->visit);
}

static JS_NOINLINE void grow_stack(JSTracer *trc) {
    trc->cap = trc->cap ? trc->cap * 2 : 4096;
    trc->stack = xrealloc(trc->stack, trc->cap * sizeof *trc->stack);
}

/* Sets a mark bit; returns whether it was clear: this marker marked the cell, and visits it. */
static inline bool set_mark(JSTracer *trc, uint64_t *word, uint64_t bit) {
    if (trc->parallel) {
        if (atomic_load64(word) & bit) return false;
        return !(atomic_or64(word, bit) & bit);
    }
    if (*word & bit) return false;
    *word |= bit;
    return true;
}

static inline void push(JSTracer *trc, JSCell *c) {
    if (trc->sp == trc->cap) grow_stack(trc);
    trc->stack[trc->sp++] = c;
}

/* Sets heap cell `c`'s mark bit. Returns whether it was clear: this marker marked it, and it's old
 * from now on. In a young collection every old cell's already is. */
static inline bool mark_bit(JSTracer *trc, JSCell *c) {
    JSBlock *b = js_block_of(c);
    uint32_t i = cell_index(b, c);
    if (!set_mark(trc, &b->mark_bits[i / 64], UINT64_C(1) << (i % 64))) return false;
    c->gc = b->is_large ? JS_GC_OLD_LARGE : JS_GC_OLD;
    trc->marked++;
    trc->marked_bytes += b->is_large ? b->map_size : b->cell_size;
    return true;
}

/* Marks `c`, and pushes it if it holds cells. Its header is read here, the first touch of the
 * cell: trace_cell prefetched it. */
static inline void mark(JSTracer *trc, JSCell *c) {
#ifdef JS_GC_VERIFY
    if (verify_edge(trc, c)) return;
#else
    if (js_cell_is_static(c)) return;
#endif
    if (mark_bit(trc, c) && has_children(c)) push(trc, c);
}

/* The marking barrier's: marked now, and on the marker's stack to be visited. */
static void shade(JSTracer *trc, JSCell *c) { mark(trc, c); }

/* An edge: its cell is prefetched and marked MARK_FIFO edges later, when the cache line has
 * arrived (most of the marker's time was that miss). A checking build marks at once, so a bad
 * edge is reported with the cell it came from. */
#ifdef JS_GC_VERIFY
static JS_NOINLINE void check_old_edge(JSTracer *trc, JSCell *c) {
    if (verify_edge(trc, c) || js_gc_is_marked(c)) return;
    if (trc->check_black)
        js_fatal("GC verify: marked %s %p points to unmarked %s %p after the marking: a store without js_store?",
                 kind_name(trc->visiting), (const void *)trc->visiting, kind_name(c), (const void *)c);
    js_fatal("GC verify: old %s %p points to young %s %p but isn't remembered: a store without js_store?",
             kind_name(trc->visiting), (const void *)trc->visiting, kind_name(c), (const void *)c);
}
#endif

static inline void trace_cell(JSTracer *trc, JSCell *c) {
#ifdef JS_GC_VERIFY
    if (trc->check_old) check_old_edge(trc, c);
    else mark(trc, c);
#else
#if defined(__clang__) || defined(__GNUC__)
    __builtin_prefetch(c);
#endif
    if (trc->fifo_count < MARK_FIFO) {
        trc->fifo[(trc->fifo_head + trc->fifo_count++) % MARK_FIFO] = c;
        return;
    }
    JSCell *oldest = trc->fifo[trc->fifo_head];
    trc->fifo[trc->fifo_head] = c;
    trc->fifo_head = (trc->fifo_head + 1) % MARK_FIFO;
    mark(trc, oldest);
#endif
}

static inline void trace_value(JSTracer *trc, JSValue v) {
    if (js_is_cell(v)) trace_cell(trc, js_as_cell(v));
}

/* An object's out-of-line slots are traced with the object, by its visit: marked, never pushed.
 * Stores into them have the object as their owner (js_object_slot), so it's the object the
 * barrier sees; during an incremental marking a stack word (an interior pointer to a slot) can
 * have marked the slots first, and when the object is young those stores skip the barrier. The
 * object's visit traces them anyway. */
static inline void mark_ool(JSTracer *trc, JSValueArray *a) {
    JSCell *c = &a->cell;
#ifdef JS_GC_VERIFY
    if (trc->check_old) {  /* the verifiers: the slots are an old cell of their own, checked as one */
        check_old_edge(trc, c);
        return;
    }
    if (verify_edge(trc, c)) return;
#endif
    mark_bit(trc, c);
    for (uint32_t k = 0; k < c->aux; k++) trace_value(trc, a->values[k]);
}

#include "gc_visit.h"

void js_trace_cell(JSTracer *trc, JSCell *c) { trace_cell(trc, c); }
void js_trace_value(JSTracer *trc, JSValue v) { trace_value(trc, v); }

bool js_gc_is_marked(const JSCell *c) {
    if (js_cell_is_static(c)) return true;
    JSBlock *b = js_block_of(c);
    return bit_get(b->mark_bits, cell_index(b, c));
}

/* Inlined into drain, the marker's loop: the rest of its callers are rare. */
static JS_ALWAYS_INLINE void visit(JSTracer *trc, JSCell *c) {
#ifdef JS_GC_VERIFY
    trc->visiting = c;
#endif
    switch (c->kind) {
    case JS_CELL_OBJECT: case JS_CELL_ARRAY: case JS_CELL_FUNCTION: visit_object(c, trc); break;
    case JS_CELL_ENV: visit_env(c, trc); break;
    case JS_CELL_VALUE_ARRAY: visit_value_array(c, trc); break;
    case JS_CELL_ELEMENTS: visit_elements(c, trc); break;
    case JS_CELL_STR_ROPE: visit_rope(c, trc); break;
    case JS_CELL_STR_SLICE: visit_slice(c, trc); break;
    case JS_CELL_SHAPE: visit_shape(c, trc); break;
    case JS_CELL_ACCESSOR: visit_accessor(c, trc); break;
    case JS_CELL_SYMBOL: visit_symbol(c, trc); break;
    case JS_CELL_HOST: ((JSHostCell *)c)->cls->visit(c, trc); break;  /* mark() pushes only those with a visit */
    default: js_fatal("GC: a cell of kind %d on the mark stack", c->kind);
    }
}

/* ---- Parallel marking -------------------------------------------------- */

static void flush_fifo(JSTracer *trc);
static bool visit_range(JSTracer *trc, JSCell *c, size_t from, size_t to);

/* Helper threads join a pause's marking once the marker has visited this many cells: below it,
 * waking them costs more than they'd do. Markers hand each other cells in packets, through a pool
 * under a lock: while another marker waits, one with work gives half its stack away (PACKET at
 * most), from the bottom, where the oldest cells are: a tree's big subtrees, not its leaves. A
 * marker with none takes a packet. The marking ends when every marker waits and none is left. */
#define PACKET 512
#define PARALLEL_AFTER 32768
/* A large cell is visited this much at a time: by a slice (incremental marking), or a marker that
 * shares the rest with the others; and one this large brings the helpers in at once. */
#define MARK_CHUNK ((size_t)64 << 10)
#define PARALLEL_CELL (4 * MARK_CHUNK)
#define MAX_HELPERS 15

typedef struct Packet {
    struct Packet *next;
    uint32_t count;
    JSCell  *cells[PACKET];
} Packet;

typedef struct JSMarkHelper {
    struct JSMarkPool *pool;
    JSOsThread *thread;
    JSTracer trc;
    uint64_t joined;       /* the marking it joined last */
} JSMarkHelper;

/* A part of a large cell to visit: a young collection's marked cards, shared out before the
 * markers steal from each other. */
typedef struct MarkTask {
    JSCell *cell;
    size_t  from, to;
} MarkTask;

typedef struct JSMarkPool {
    JSOsLock *lock;
    JSOsCond *wake;        /* helpers: a marking to join, or the runtime's end */
    JSOsCond *work;        /* markers: a packet, or the marking's end */
    Packet  *full, *spare; /* packets of cells to visit; empty ones, for reuse */
    unsigned helpers;
    unsigned markers, idle;  /* this marking's: markers that joined it, those waiting */
    int      waiting;      /* idle, read without the lock: whether to give a packet away */
    int      news;         /* bumped when work comes or the marking ends: what a spinning marker watches */
    bool     done, quit;
    uint64_t epoch;        /* a new marking for the helpers */
    JSMarkHelper *helper;
    MarkTask *tasks;       /* this marking's, taken in turn (task_next) by every marker first */
    size_t   ntasks, task_cap, task_next;
} JSMarkPool;

static void add_task(JSMarkPool *p, JSCell *c, size_t from, size_t to) {
    if (p->ntasks == p->task_cap) {
        p->task_cap = p->task_cap ? p->task_cap * 2 : 256;
        p->tasks = xrealloc(p->tasks, p->task_cap * sizeof *p->tasks);
    }
    p->tasks[p->ntasks++] = (MarkTask){ c, from, to };
    atomic_store_int(&p->news, p->news + 1);
}

/* Bytes [from, to) of `c` as tasks of MARK_CHUNK bytes at most. */
static void add_chunk_tasks(JSMarkPool *p, JSCell *c, size_t from, size_t to) {
    for (; from < to; from += MARK_CHUNK) add_task(p, c, from, to - from > MARK_CHUNK ? from + MARK_CHUNK : to);
}

static void give_packet(JSTracer *trc, JSMarkPool *p) {
    size_t n = (trc->sp - trc->base) / 2;
    if (n > PACKET) n = PACKET;
    js_os_lock(p->lock);
    Packet *k = p->spare;
    if (k) p->spare = k->next;
    else k = xrealloc(NULL, sizeof *k);
    k->count = (uint32_t)n;
    memcpy(k->cells, &trc->stack[trc->base], n * sizeof *k->cells);
    trc->base += n;
    k->next = p->full;
    p->full = k;
    atomic_store_int(&p->news, p->news + 1);
    js_os_cond_signal(p->work);
    js_os_unlock(p->lock);
}

#if defined(__x86_64__) || defined(__i386__)
#define CPU_RELAX() __builtin_ia32_pause()
#else
#define CPU_RELAX() ((void)0)
#endif

/* Waits for work: a packet onto the stack (1), or a task (2, in *task); 0 when marking `epoch` is
 * over: every marker that joined it waits, and nothing is left. A marker spins a little first:
 * work often comes within microseconds, and a thread put to sleep takes much longer to come
 * back. */
static int take_work(JSTracer *trc, JSMarkPool *p, uint64_t epoch, MarkTask *task) {
    js_os_lock(p->lock);
    for (;;) {
        /* woken late: that marking is over, and the next one's work (posted before its epoch) isn't ours */
        if (p->epoch != epoch || p->done) break;
        if (p->task_next < p->ntasks) {
            *task = p->tasks[p->task_next++];
            js_os_unlock(p->lock);
            return 2;
        }
        Packet *k = p->full;
        if (k) {
            p->full = k->next;
            while (trc->sp + k->count > trc->cap) grow_stack(trc);
            memcpy(&trc->stack[trc->sp], k->cells, k->count * sizeof *k->cells);
            trc->sp += k->count;
            k->next = p->spare;
            p->spare = k;
            js_os_unlock(p->lock);
            return 1;
        }
        p->idle++;
        atomic_store_int(&p->waiting, (int)p->idle);
        if (p->idle == p->markers) {
            p->done = true;
            atomic_store_int(&p->news, p->news + 1);
            js_os_cond_broadcast(p->work);
            break;
        }
        int news = p->news;
        js_os_unlock(p->lock);
        for (int spin = 0; spin < 2000 && atomic_load_int(&p->news) == news; spin++) CPU_RELAX();
        js_os_lock(p->lock);
        if (p->epoch != epoch) break;
        if (!p->full && !p->done && p->task_next >= p->ntasks) js_os_cond_wait(p->work, p->lock);
        if (p->epoch != epoch) break;
        p->idle--;
        atomic_store_int(&p->waiting, (int)p->idle);
    }
    js_os_unlock(p->lock);
    return 0;
}

/* The slots' bytes of a cell whose visit can be split (exact range visits), else 0: computed
 * from the cell itself, not its block's header, which would be one more cache miss per visit. */
static size_t splittable_bytes(const JSCell *c) {
    switch (c->kind) {
    case JS_CELL_VALUE_ARRAY: case JS_CELL_ENV: return (size_t)c->aux * sizeof(JSValue);
    case JS_CELL_ELEMENTS:
        return ((const JSElements *)c)->kind == JS_ELEMENTS_DENSE ? (size_t)((const JSElements *)c)->length * sizeof(JSValue) : 0;
    default: return 0;
    }
}

/* A large cell met while marking with others: its chunks but the first become tasks, for
 * whoever is free; this marker visits the first. */
static void split_cell(JSTracer *trc, JSMarkPool *p, JSCell *c) {
    js_os_lock(p->lock);
    add_chunk_tasks(p, c, MARK_CHUNK, js_block_of(c)->cell_size);
    js_os_cond_broadcast(p->work);
    js_os_unlock(p->lock);
#ifdef JS_GC_VERIFY
    trc->visiting = c;
#endif
    visit_range(trc, c, 0, MARK_CHUNK);
}

/* One marker's part, the main one's or a helper's, until marking `epoch` ends: its stack, then
 * tasks and what it takes from the others'. */
static void mark_with_others(JSTracer *trc, JSMarkPool *p, uint64_t epoch) {
    MarkTask task;
    for (;;) {
        while (trc->sp > trc->base) {
            JSCell *c = trc->stack[--trc->sp];
            if (splittable_bytes(c) >= 2 * MARK_CHUNK) split_cell(trc, p, c);
            else visit(trc, c);
            if (trc->sp - trc->base >= 8 && atomic_load_int(&p->waiting)) give_packet(trc, p);
        }
        trc->sp = trc->base = 0;
        flush_fifo(trc);
        if (trc->sp) continue;
        int got = take_work(trc, p, epoch, &task);
        if (!got) break;
        if (got == 2) {
#ifdef JS_GC_VERIFY
            trc->visiting = task.cell;
#endif
            visit_range(trc, task.cell, task.from, task.to);
        }
    }
#ifdef JS_GC_VERIFY
    trc->visiting = NULL;
#endif
}

/* A helper joins each marking it wakes up for in time: one already done goes on without it. */
static void helper_main(void *arg) {
    JSMarkHelper *me = arg;
    JSMarkPool *p = me->pool;
    uint64_t seen = 0;
    js_os_lock(p->lock);
    for (;;) {
        while (!p->quit && p->epoch == seen) js_os_cond_wait(p->wake, p->lock);
        if (p->quit) break;
        seen = p->epoch;
        if (p->done) continue;
        p->markers++;
        me->trc.marked = me->trc.marked_bytes = 0;
        me->trc.parallel = true;
        me->joined = seen;
        js_os_unlock(p->lock);
        mark_with_others(&me->trc, p, seen);
        js_os_lock(p->lock);
    }
    js_os_unlock(p->lock);
}

/* The helpers, started at the first marking that needs them; NULL when there are none
 * (JS_GC_THREADS=0, one processor, or the threads couldn't start). */
static JSMarkPool *mark_pool(JSHeap *h) {
    if (h->pool || !h->gc_helpers) return h->pool;
    JSMarkPool *p = xrealloc(NULL, sizeof *p);
    memset(p, 0, sizeof *p);
    p->lock = js_os_lock_new();
    p->wake = js_os_cond_new();
    p->work = js_os_cond_new();
    p->helper = xrealloc(NULL, h->gc_helpers * sizeof *p->helper);
    memset(p->helper, 0, h->gc_helpers * sizeof *p->helper);
    h->pool = p;
    if (!p->lock || !p->wake || !p->work) {
        h->gc_helpers = 0;
        return NULL;
    }
    for (unsigned i = 0; i < h->gc_helpers; i++) {
        p->helper[i].pool = p;
        p->helper[i].trc.heap = h;
        p->helper[i].thread = js_os_thread_start(helper_main, &p->helper[i]);
        if (!p->helper[i].thread) break;
        p->helpers++;
    }
    if (!p->helpers) h->gc_helpers = 0;
    return p->helpers ? p : NULL;
}

static void free_mark_pool(JSHeap *h) {
    JSMarkPool *p = h->pool;
    if (!p) return;
    if (p->lock) {
        js_os_lock(p->lock);
        p->quit = true;
        js_os_cond_broadcast(p->wake);
        js_os_unlock(p->lock);
    }
    for (unsigned i = 0; i < p->helpers; i++) {
        js_os_thread_join(p->helper[i].thread);
        free(p->helper[i].trc.stack);
    }
    for (Packet *k = p->spare, *next; k; k = next) {
        next = k->next;
        free(k);
    }
    if (p->lock) js_os_lock_free(p->lock);
    if (p->wake) js_os_cond_free(p->wake);
    if (p->work) js_os_cond_free(p->work);
    free(p->helper);
    free(p->tasks);
    free(p);
    h->pool = NULL;
}

/* Marks what's left with the helpers. Returns false, having done nothing, when there are none. */
static bool drain_in_parallel(JSTracer *trc) {
    JSHeap *h = trc->heap;
    JSMarkPool *p = mark_pool(h);
    if (!p) return false;
    js_os_lock(p->lock);
    uint64_t epoch = ++p->epoch;
    p->markers = 1;  /* the helpers count themselves in as they join */
    p->idle = 0;
    atomic_store_int(&p->waiting, 0);
    p->done = false;
    trc->parallel = true;
    js_os_cond_broadcast(p->wake);
    js_os_unlock(p->lock);

    mark_with_others(trc, p, epoch);

    /* done: every marker that joined waits, so their counts are final; the others didn't mark */
    js_os_lock(p->lock);
    for (unsigned i = 0; i < p->helpers; i++) {
        JSMarkHelper *m = &p->helper[i];
        if (m->joined != epoch) continue;
        trc->marked += m->trc.marked;
        trc->marked_bytes += m->trc.marked_bytes;
    }
    p->ntasks = p->task_next = 0;
    js_os_unlock(p->lock);
    trc->parallel = false;
    h->stats.parallel_markings++;
    return true;
}

/* Until there's nothing left: visits the marked cells on the stack, and when it's empty marks
 * the edges still waiting in the FIFO. Explicit stack, never recursion: ropes and linked lists
 * can be very deep. With much to visit, the helpers join (in a pause; a slice marks alone). */
static void drain(JSTracer *trc) {
    JSMarkPool *p = trc->heap->pool;
    if (p && p->ntasks && drain_in_parallel(trc)) return;
    size_t visited = 0;
    for (;;) {
        while (trc->sp) {
            JSCell *c = trc->stack[trc->sp - 1];
            if (trc->heap->gc_helpers && ((++visited > PARALLEL_AFTER && trc->sp >= 2) || splittable_bytes(c) >= PARALLEL_CELL) &&
                drain_in_parallel(trc))
                return;
            trc->sp--;
            visit(trc, c);
        }
        if (!trc->fifo_count) break;
        JSCell *c = trc->fifo[trc->fifo_head];
        trc->fifo_head = (trc->fifo_head + 1) % MARK_FIFO;
        trc->fifo_count--;
        mark(trc, c);
    }
#ifdef JS_GC_VERIFY
    trc->visiting = NULL;
#endif
}

/* The slots of `slots[0..n)` (at byte `base` of their cell) in bytes [from, to) of it. */
static void trace_slots_in(JSTracer *trc, const JSValue *slots, size_t n, size_t base, size_t from, size_t to) {
    size_t first = from <= base ? 0 : (from - base) / sizeof(JSValue);
    size_t last = to <= base ? 0 : (to - base + sizeof(JSValue) - 1) / sizeof(JSValue);
    for (size_t i = first; i < last && i < n; i++) trace_value(trc, slots[i]);
}

/* Traces what large `c` holds in bytes [from, to) of it, at least; the whole cell for a kind
 * that can't tell. Returns whether it was exact: only what's in the range. */
static bool visit_range(JSTracer *trc, JSCell *c, size_t from, size_t to) {
    switch (c->kind) {
    case JS_CELL_VALUE_ARRAY:
        trace_slots_in(trc, ((JSValueArray *)c)->values, c->aux, offsetof(JSValueArray, values), from, to);
        return true;
    case JS_CELL_ELEMENTS: {
        JSElements *e = (JSElements *)c;
        if (e->kind != JS_ELEMENTS_DENSE) break;  /* a sparse store's entries are malloc'd */
        trace_slots_in(trc, e->data, e->length, offsetof(JSElements, data), from, to);
        return true;
    }
    case JS_CELL_ENV: {
        JSEnv *e = (JSEnv *)c;
        if (from < offsetof(JSEnv, vars) && e->parent) trace_cell(trc, &e->parent->cell);
        trace_slots_in(trc, e->vars, c->aux, offsetof(JSEnv, vars), from, to);
        return true;
    }
    case JS_CELL_HOST: {
        const JSCellClass *cls = ((JSHostCell *)c)->cls;
        if (!cls->visit_range) break;
        cls->visit_range(c, trc, from, to);
        return false;  /* a class may trace a little more than the range */
    }
    default:
        break;
    }
    if (has_children(c)) visit(trc, c);
    return false;
}

/* Whether visit_range can visit part of `c`, not the whole cell whatever the range. */
static bool visits_part(const JSCell *c) {
    if (c->kind == JS_CELL_HOST) return ((const JSHostCell *)c)->cls->visit_range != NULL;
    return splittable_bytes(c) != 0;
}

static bool card_marked(const JSBlock *b, size_t k) { return (b->cards[k / 64] >> (k % 64)) & 1; }

/* The next run of large `b`'s cards from card *k that are marked (`marked`) or not: bytes
 * [*from, *to) of its cell. Returns false when there's none left. */
static bool next_card_run(const JSBlock *b, bool marked, size_t *k, size_t *from, size_t *to) {
    unsigned shift = b->card_shift;
    size_t n = (b->cell_size + ((size_t)1 << shift) - 1) >> shift;
    while (*k < n && card_marked(b, *k) != marked) (*k)++;
    if (*k == n) return false;
    size_t end = *k + 1;
    while (end < n && card_marked(b, end) == marked) end++;
    *from = *k << shift;
    *to = end << shift < b->cell_size ? end << shift : b->cell_size;
    *k = end;
    return true;
}

static void forget_cards(JSBlock *b) {
    memset(b->cards, 0, sizeof b->cards);
    b->remembered = 0;
}

/* A remembered large cell: visits its marked cards, a run of them at a time (`marked`), or, for
 * the barrier verifier, the others; then, when visiting the marked ones, forgets them. */
static void visit_cards(JSTracer *trc, JSCell *c, bool marked) {
    JSBlock *b = js_block_of(c);
    size_t from, to;
    for (size_t k = 0; next_card_run(b, marked, &k, &from, &to);) {
#ifdef JS_GC_VERIFY
        trc->visiting = c;
#endif
        if (!visit_range(trc, c, from, to) && !marked) return;  /* inexact: can't check part */
    }
    if (marked) forget_cards(b);
}

/* ---- Incremental marking: slices ---------------------------------------- */

/* The next chunk of the partly visited cell. Returns the bytes it covered. */
static size_t visit_chunk(JSTracer *trc) {
    JSCell *c = trc->partial;
    size_t size = js_block_of(c)->cell_size, from = trc->partial_from;
    size_t to = size - from > MARK_CHUNK ? from + MARK_CHUNK : size;
#ifdef JS_GC_VERIFY
    trc->visiting = c;
#endif
    visit_range(trc, c, from, to);
    trc->partial_from = to;
    if (to == size) trc->partial = NULL;
    return to - from;
}

/* Marks the edges waiting in the FIFO: between slices, what the marker found is on its stack. */
static void flush_fifo(JSTracer *trc) {
    while (trc->fifo_count) {
        JSCell *c = trc->fifo[trc->fifo_head];
        trc->fifo_head = (trc->fifo_head + 1) % MARK_FIFO;
        trc->fifo_count--;
        mark(trc, c);
    }
}

/* A slice: visits marked cells until about `budget` bytes were marked or scanned, or there are
 * none left (then returns true). */
static bool drain_some(JSTracer *trc, size_t budget) {
    size_t start = trc->marked_bytes, scanned = 0;
    for (;;) {
        while (trc->marked_bytes - start + scanned < budget) {
            if (trc->partial) {
                scanned += visit_chunk(trc);
                continue;
            }
            if (!trc->sp) break;
            JSCell *c = trc->stack[--trc->sp];
            if (splittable_bytes(c) > MARK_CHUNK) {
                trc->partial = c;
                trc->partial_from = 0;
                continue;
            }
            visit(trc, c);
        }
        flush_fifo(trc);
        if (!trc->sp && !trc->partial) return true;
        if (trc->marked_bytes - start + scanned >= budget) return false;
    }
}

/* Everything left: the final pause's. */
static void drain_all(JSTracer *trc) {
    while (trc->partial) visit_chunk(trc);
    drain(trc);
}

/* Below this much in marked cards, a young collection visits them itself. */
#define PARALLEL_CARDS ((size_t)256 << 10)

/* Large `c`'s marked card runs, as tasks of MARK_CHUNK bytes at most (the whole cell, once, for a
 * kind that can't visit part of it); then its cards are forgotten. Returns the tasks' bytes. */
static size_t card_tasks(JSMarkPool *p, JSCell *c) {
    JSBlock *b = js_block_of(c);
    size_t bytes = 0, from, to;
    if (!visits_part(c)) {
        add_task(p, c, 0, b->cell_size);
        bytes = b->cell_size;
    } else {
        for (size_t k = 0; next_card_run(b, true, &k, &from, &to);) {
            add_chunk_tasks(p, c, from, to);
            bytes += to - from;
        }
    }
    forget_cards(b);
    return bytes;
}

/* A young collection's other roots: the old cells a store gave a young cell. They're marked
 * already, so they're pushed to be visited, dead or alive: a remembered cell that died since keeps
 * its young cells until the next collection, so nothing it points to is freed under it (a stale
 * stack word could still find it). Each becomes plain old again. With helpers, large cells' marked
 * cards become tasks that every marker takes a share of (drain), when there are enough of them. */
static void mark_remembered(JSHeap *h, JSTracer *trc) {
    JSMarkPool *p = h->gc_helpers ? mark_pool(h) : NULL;
    size_t task_bytes = 0;
    if (p) js_os_lock(p->lock);  /* a helper may still be leaving the last marking */
    for (size_t i = 0; i < h->remembered_count; i++) {
        JSCell *c = h->remembered[i];
        if (c->gc == JS_GC_OLD_LARGE) {
            if (p) task_bytes += card_tasks(p, c);
            else visit_cards(trc, c, true);
            continue;
        }
        c->gc = JS_GC_OLD;
        if (has_children(c)) push(trc, c);
    }
    if (p) js_os_unlock(p->lock);
    if (p && task_bytes < PARALLEL_CARDS) {  /* not worth waking the helpers for */
        for (size_t i = 0; i < p->ntasks; i++) {
#ifdef JS_GC_VERIFY
            trc->visiting = p->tasks[i].cell;
#endif
            visit_range(trc, p->tasks[i].cell, p->tasks[i].from, p->tasks[i].to);
        }
        p->ntasks = 0;
    }
}

/* Forgets the remembered set: a full collection marks everything. */
static void forget_remembered(JSHeap *h) {
    for (size_t i = 0; i < h->remembered_count; i++) {
        JSCell *c = h->remembered[i];
        if (c->gc == JS_GC_OLD_LARGE) forget_cards(js_block_of(c));  /* the others: JS_GC_OLD again when they're marked */
    }
    h->remembered_count = 0;
}

#ifdef JS_GC_VERIFY
/* Calls `f` on every allocated old cell that isn't remembered. */
static void each_old_cell(JSHeap *h, void (*f)(JSTracer *, JSCell *), JSTracer *trc) {
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++)
        for (JSBlock *b = h->blocks[sc]; b; b = b->next)
            for (uint32_t w = 0; w < (b->cell_count + 63) / 64; w++)
                for (uint64_t m = b->alloc_bits[w] & b->mark_bits[w]; m; m &= m - 1) {
                    JSCell *c = (JSCell *)block_cell(b, w * 64 + js_ctz64(m));
                    if (c->gc >= JS_GC_OLD) f(trc, c);
                }
    for (size_t i = 0; i < h->large_count; i++) {
        JSCell *c = (JSCell *)block_cell(h->large[i], 0);
        if ((h->large[i]->mark_bits[0] & 1) && c->gc >= JS_GC_OLD) f(trc, c);
    }
}

static void check_old_cell(JSTracer *trc, JSCell *c) {
    if (c->gc == JS_GC_OLD_LARGE && js_block_of(c)->remembered) visit_cards(trc, c, false);  /* the unmarked cards */
    else if (has_children(c)) visit(trc, c);
}

/* The barrier verifier, before a young collection: an old cell that isn't remembered, dead or
 * alive, points only to old cells. A store that skipped the barrier stops here, naming the old
 * cell, at the first collection that could have freed what it stored. */
static void verify_remembered(JSHeap *h, JSTracer *trc) {
    trc->check_old = true;
    each_old_cell(h, check_old_cell, trc);
    trc->check_old = false;
    trc->visiting = NULL;
}

/* The marking barrier's verifier, in the final pause of an incremental marking, before the roots
 * and the stack are scanned again: once the marker has visited everything it found, a marked
 * cell points only to marked cells. One that doesn't was given a cell without the barrier,
 * after the marker visited it: that cell would be freed while it's reachable. */
static void verify_marking(JSHeap *h, JSTracer *trc) {
    trc->check_old = trc->check_black = true;
    each_old_cell(h, check_old_cell, trc);
    trc->check_old = trc->check_black = false;
    trc->visiting = NULL;
}
#endif

static void mark_roots(JSRuntime *rt, JSTracer *trc) {
    JSHeap *h = &rt->heap;
    js_trace_value(trc, rt->exception);  /* the pending exception is a root */
    js_trace_value(trc, rt->symbol_registry);
    js_trace_value(trc, rt->async_context);
    js_jobs_trace(rt, trc);  /* queued jobs, unhandled rejections */
    js_weak_trace_roots(rt, trc);  /* the WeakRef kept-alive set */
    for (JSContext *realm = rt->realms; realm; realm = realm->next_realm) {
        for (unsigned i = 0; i < JS_INTRINSIC_COUNT; i++) js_trace_value(trc, realm->intrinsics[i]);
        if (realm->array_shape) js_trace_cell(trc, &realm->array_shape->cell);
    }
    for (size_t t = 0; t < h->root_table_count; t++)
        for (size_t i = 0; i < h->root_tables[t].n; i++) js_trace_value(trc, h->root_tables[t].slots[i]);
    for (size_t i = 0; i < h->root_count; i++) js_trace_value(trc, *h->roots[i]);
}

/* ---- Conservative roots ------------------------------------------------ */

static JSBlock *find_large(const JSHeap *h, uintptr_t w) {
    size_t lo = 0, hi = h->large_count;
    while (lo < hi) {  /* last object starting at or below w */
        size_t mid = (lo + hi) / 2;
        if ((uintptr_t)h->large[mid] <= w) lo = mid + 1;
        else hi = mid;
    }
    if (!lo) return NULL;
    JSBlock *b = h->large[lo - 1];
    return w < (uintptr_t)b + b->map_size ? b : NULL;
}

/* The allocated cell that `w` points into (interior pointers included), or NULL. */
static JSCell *find_cell(const JSHeap *h, uintptr_t w) {
    if (w < h->min_addr || w >= h->max_addr) return NULL;  /* also rejects doubles, int32s */
    uintptr_t base = w & ~(uintptr_t)(JS_BLOCK_SIZE - 1);
    JSBlock *b;
    uint32_t i;
    if (block_set_contains(h, base)) {
        b = (JSBlock *)base;
        if (w < base + JS_BLOCK_FIRST_CELL) return NULL;
        i = (uint32_t)((w - base - JS_BLOCK_FIRST_CELL) / b->cell_size);
        if (i >= b->cell_count) return NULL;
        if (b->queued) return bit_get(b->mark_bits, i) ? (JSCell *)block_cell(b, i) : NULL;  /* unswept */
    } else {
        b = find_large(h, w);
        if (!b || w < (uintptr_t)b + JS_BLOCK_FIRST_CELL) return NULL;
        i = 0;
    }
    return bit_get(b->alloc_bits, i) ? (JSCell *)block_cell(b, i) : NULL;
}


#if defined(__SANITIZE_ADDRESS__)
#define JS_ASAN 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define JS_ASAN 1
#endif
#endif

#ifdef JS_ASAN
/* ASan's use-after-return mode moves locals to a "fake stack" in heap memory,
 * where the conservative scan can't see them. Keep them on the real stack. */
const char *__asan_default_options(void);
const char *__asan_default_options(void) { return "detect_stack_use_after_return=0"; }
#endif

/* Scans the mutator's stack: from js_gc's frame (which holds the spilled
 * registers) up to the stack base. The collector's own deeper frames are
 * not roots, and would hold stale pointers from sweeping.
 * Reads the whole range on purpose, redzones included. */
static JS_NO_ASAN void mark_stack(JSTracer *trc) {
    const uintptr_t *p = (const uintptr_t *)((uintptr_t)trc->stack_low & ~(uintptr_t)(sizeof(uintptr_t) - 1));
    const uintptr_t *end = (const uintptr_t *)trc->heap->stack_base;
    for (; p < end; p++) {
        JSCell *c = find_cell(trc->heap, *p);
        if (c) js_trace_cell(trc, c);
    }
}

/* ---- Collection -------------------------------------------------------- */

/* Makes the allocation bits exact: the cells left in each class's window weren't handed out. */
static void stop_allocation(JSHeap *h) {
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++) {
        JSAllocator *a = &h->alloc[sc];
        if (a->free) {
            a->block->alloc_bits[a->word - 1] &= ~a->free;
            h->allocated_since_gc -= (size_t)popcount64(a->free) * a->cell_size;
        }
        a->free = 0;
        a->block = NULL;
    }
}

/* Unswept blocks may hold dead cells whose children are already reused: a full collection sweeps
 * them before marking (it clears the mark bits) so that nothing can resurrect such a cell. A young
 * collection doesn't need to: an unswept block holds no young cell, and its mark bits say which
 * of its cells are alive (find_cell). */
static void finish_sweeping(JSRuntime *rt) {
    JSHeap *h = &rt->heap;
    JSBlock *b;
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++)
        while (sweep_next(rt, sc, false, &b))
            if (b) list_push(&h->ready[sc], b);  /* free cells: the allocator's, swept */
}


/* Runs the finalizers of the dead cells, all of them, before any memory is freed or reused. A
 * finalizer may read other cells: an object's reaches its class through its shape, which may be
 * dead too, and which lazy sweeping could otherwise free and reuse before the object's own block
 * is swept. Each finalized cell loses JS_CELL_FINALIZABLE, so nothing finalizes it twice. */
static void finalize_dead_in(JSRuntime *rt, JSBlock *b) {
    if (!b->has_finalizable) return;
    for (uint32_t w = 0; w < (b->cell_count + 63) / 64; w++)
        for (uint64_t dead = b->alloc_bits[w] & ~b->mark_bits[w]; dead; dead &= dead - 1) {
            JSCell *c = (JSCell *)block_cell(b, w * 64 + js_ctz64(dead));
            if (c->flags & JS_CELL_FINALIZABLE) {
                finalize_cell(rt, c);
                c->flags &= (uint16_t)~JS_CELL_FINALIZABLE;
            }
        }
}

/* After a young collection only young cells died: they're in the blocks the allocator took. */
static void finalize_dead(JSRuntime *rt, bool full) {
    JSHeap *h = &rt->heap;
    if (full) {
        for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++)
            for (JSBlock *b = h->blocks[sc]; b; b = b->next) finalize_dead_in(rt, b);
    } else {
        for (size_t i = 0; i < h->young_blocks.count; i++) finalize_dead_in(rt, h->young_blocks.items[i]);
    }
    for (size_t i = 0; i < h->large_count; i++) {
        JSBlock *b = h->large[i];
        JSCell *c = (JSCell *)block_cell(b, 0);
        if (!(b->mark_bits[0] & 1) && (c->flags & JS_CELL_FINALIZABLE)) {
            finalize_cell(rt, c);
            c->flags &= (uint16_t)~JS_CELL_FINALIZABLE;
        }
    }
}

/* One line per collection (JS_GC_TRACE=1), on stderr. Its format is for people and scripts: fields
 * are added at the end. */
static void trace_collection(const JSHeap *h, bool full, double pause, double mark, double weak, double finish, size_t heap_before,
                             unsigned slices, double marking_ms) {
    const char *kind = !full ? "young" : h->idle ? "idle" : "full";
    char incremental[96] = "";  /* the final pause of an incremental marking: its slices before it */
    if (slices) snprintf(incremental, sizeof incremental, ", incremental: %u slices, %.3f ms", slices, marking_ms);
    fprintf(stderr, "[gc] #%zu %s: pause %.3f ms (mark %.3f, weak %.3f, finish %.3f), heap %zu KiB -> live %zu KiB, %llu cells marked, external %zu KiB, old limit %zu KiB%s\n",
            h->gc_count, kind, pause, mark, weak, finish, heap_before >> 10, h->live_after_gc >> 10, (unsigned long long)h->stats.marked_cells,
            h->external_bytes >> 10, h->old_limit >> 10, incremental);
}

/* ---- Policy ------------------------------------------------------------ */

/* Full collections should take about this share of the program's CPU time. */
#define GC_TARGET 0.05
/* The old generation's growth between full collections, as a factor of its size after one. */
#define GROWTH_MIN 1.25
#define GROWTH_MAX 2.0

/* The old generation's size: its cells, and the external memory. The external memory of young
 * cells is in it too, which a young collection frees or makes old. */
static size_t old_size(const JSHeap *h) { return h->live_after_gc + h->external_bytes; }

/* The program's growth rate of the old generation, in bytes per ms of its CPU time, since the
 * last full collection; read when a full collection starts. -1 when it ran too briefly to tell. */
static double promotion_rate(const JSHeap *h) {
    double mutator = js_os_thread_cpu_ms() - h->full_end_cpu - h->pause_since_full;
    size_t now = old_size(h);
    if (mutator < 1) return -1;
    return now > h->old_after_full ? (double)(now - h->old_after_full) / mutator : 0;
}

/* After a full collection that took `cost` ms: how big the old generation may grow before the
 * next one. Growing at `rate`, by rate × cost / GC_TARGET bytes, the next full collection comes
 * after cost / GC_TARGET ms of the program's time: full collections take GC_TARGET of it (Go's
 * and V8's heap controllers aim at a share of time too). Bounded by GROWTH_MIN and GROWTH_MAX,
 * and never below JS_GC_MIN_HEAP; JS_GC_GROWTH fixes the factor instead. */
static size_t next_old_limit(const JSHeap *h, double rate, double cost) {
    double old = (double)h->old_after_full, grow;
    if (h->growth > 0) grow = (h->growth - 1) * old;
    else if (rate < 0) grow = (GROWTH_MAX - 1) * old;
    else {
        grow = rate * cost / GC_TARGET;
        if (grow < (GROWTH_MIN - 1) * old) grow = (GROWTH_MIN - 1) * old;
        if (grow > (GROWTH_MAX - 1) * old) grow = (GROWTH_MAX - 1) * old;
    }
    size_t limit = h->old_after_full + (size_t)grow;
    return limit > h->min_heap ? limit : h->min_heap;
}

/* A full collection's start: the sweeping finished (a full collection clears the mark bits, and an
 * unswept block's dead cells must not come back), every mark bit cleared, the remembered set
 * forgotten (everything is marked). */
static void begin_full(JSRuntime *rt) {
    JSHeap *h = &rt->heap;
    finish_sweeping(rt);
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++)
        for (JSBlock *b = h->blocks[sc]; b; b = b->next) memset(b->mark_bits, 0, sizeof b->mark_bits);
    for (size_t i = 0; i < h->large_count; i++) h->large[i]->mark_bits[0] = 0;
    forget_remembered(h);
}

/* The allocation so far, cells and external memory, since the last collection: incremental
 * marking's clock. */
static size_t allocation_clock(const JSHeap *h) { return h->allocated_since_gc + h->external_since_gc; }

/* Counts what was allocated since the last collection as done with: the next one counts anew. */
static void reset_allocation_clock(JSHeap *h) {
    h->stats.allocated_bytes += h->allocated_since_gc;
    h->allocated_since_idle += h->allocated_since_gc + h->external_since_gc;
    h->allocated_since_gc = 0;
    h->external_since_gc = 0;
    h->collect_requested = 0;
}

static void count_pause(JSHeap *h, double pause) {
    JSGCStats *st = &h->stats;
    st->pause_ms += pause;
    if (pause > st->max_pause_ms) st->max_pause_ms = pause;
}

/* A full collection marks everything; a young one keeps the old cells' mark bits, and marks
 * from the roots, the stack and the remembered set what's new. With an incremental marking in
 * progress, any collection is its final pause: the marker has visited what it found while the
 * program ran; the roots and the stack, which no barrier watches, are marked again, and what
 * they reach. */
static JS_NOINLINE void collect(JSContext *ctx, const void *stack_low, bool full) {
    JSRuntime *rt = ctx->rt;
    JSHeap *h = &rt->heap;
    if (h->in_gc) js_fatal("js_gc called during a collection (from a finalizer?)");
    h->in_gc = 1;
    double start = js_os_now_ms_precise();
    size_t heap_before = js_heap_size(rt);
    JSTracer *marker = h->marker;
    if (marker && h->exact) {  /* js_gc, the heap limit: a marking from scratch, without what the one in progress kept */
        h->mark_stack = marker->stack;
        h->mark_stack_cap = marker->cap;
        free(marker);
        h->marker = marker = NULL;
        h->marking_ms = 0;
        h->marking_slices = 0;
    }
    h->exact = false;
    if (marker) full = true;  /* no young collection during a marking: it cleared the old cells' marks */
    double rate = marker ? h->mark_rate : full ? promotion_rate(h) : 0;
    stop_allocation(h);

    JSTracer local, *trc = marker;
    if (marker) {
        trc->stack_low = stack_low;
        drain_all(trc);  /* what the slices left */
#ifdef JS_GC_VERIFY
        verify_marking(h, trc);
#endif
    } else {
        local = (JSTracer){ .heap = h, .stack = h->mark_stack, .cap = h->mark_stack_cap, .stack_low = stack_low };
        trc = &local;
        if (full) {
            begin_full(rt);
        } else {  /* a young collection reads a queued block's marks: no sweeping first */
#ifdef JS_GC_VERIFY
            verify_remembered(h, trc);
#endif
            mark_remembered(h, trc);
            forget_remembered(h);
        }
    }
    mark_roots(rt, trc);
    mark_stack(trc);
    drain(trc);
    while (js_weak_ephemerons(rt, trc, full)) drain(trc);  /* a WeakMap value lives if its key does */
    h->mark_stack = trc->stack;  /* kept for the next collection */
    h->mark_stack_cap = trc->cap;
    double marked = js_os_now_ms_precise();

    js_weak_sweep(rt, full);
    js_atoms_sweep(rt, full);  /* weak references, before anything is freed */
    js_shapes_sweep(rt, full);
    js_prop_caches_sweep(rt);
    double weak = js_os_now_ms_precise();

    finalize_dead(rt, full);
    sweep_large(rt);
    if (full) {
        for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++) {
            for (JSBlock *b = h->blocks[sc]; b; b = b->next) queue_sweep(h, b);
            h->ready[sc].count = 0;  /* queued: swept again before they're used */
        }
    }
    for (size_t i = 0; i < h->young_blocks.count; i++) {
        JSBlock *b = h->young_blocks.items[i];
        b->young = 0;
        if (!full) queue_sweep(h, b);
    }
    h->young_blocks.count = 0;
    h->gc_count++;
    /* the old generation: a young collection adds its survivors, a full one counts them all; the
     * finalizers have freed the dead cells' external memory */
    h->live_after_gc = full ? trc->marked_bytes : h->live_after_gc + trc->marked_bytes;
    size_t marked_cells = trc->marked;
    reset_allocation_clock(h);

    double end = js_os_now_ms_precise(), pause = end - start;
    double incremental_ms = marker ? h->marking_ms : 0;
    unsigned slices = marker ? h->marking_slices : 0;
    if (marker) {
        free(marker);
        h->marker = NULL;
        h->marking_ms = 0;
        h->marking_slices = 0;
    }
    if (full) {
        h->full_count++;
        unmap_unused_blocks(h);
        h->old_after_full = old_size(h);
        h->old_limit = next_old_limit(h, rate, pause + incremental_ms);  /* the marking's whole cost */
        h->full_end_cpu = js_os_thread_cpu_ms();
        h->pause_since_full = 0;
    } else {
        h->pause_since_full += pause;
    }
    h->full_next = old_size(h) > h->old_limit;  /* the old generation outgrew its limit */
    h->in_gc = 0;

    JSGCStats *st = &h->stats;
    st->collections++;
    if (!full) st->young_collections++;
    if (h->idle) st->idle_collections++;
    count_pause(h, pause);
    st->mark_ms += marked - start;
    st->weak_ms += weak - marked;
    st->finish_ms += end - weak;
    st->marked_cells = marked_cells;
    if (h->report & 1) trace_collection(h, full, pause, marked - start, weak - marked, end - weak, heap_before, slices, incremental_ms);
}

/* Starts an old collection's marking, in a short pause: the
 * sweeping finished, the mark bits cleared, the precise roots marked. Then the program runs, and
 * allocating mark_ratio bytes for a byte marks a slice every SLICE_BYTES, so the marking is done
 * when the program has allocated about an eighth of the old generation (at least two
 * nurseries): there are no young collections meanwhile, and that's what the heap grows by. */
#define SLICE_BYTES ((size_t)256 << 10)
/* A slice marks at most this much, about a millisecond: one large allocation (an 8 MB array's new
 * elements) would otherwise owe the whole marking at once. What's owed is marked by the next
 * slices, or the final pause. */
#define MAX_SLICE ((size_t)4 << 20)

static JS_NOINLINE void start_marking_at(JSContext *ctx, const void *stack_low) {
    JSRuntime *rt = ctx->rt;
    JSHeap *h = &rt->heap;
    h->in_gc = 1;
    double start = js_os_now_ms_precise();
    h->mark_rate = promotion_rate(h);
    JSBlock *current[JS_NUM_SIZE_CLASSES];
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++) current[sc] = h->alloc[sc].block;
    stop_allocation(h);  /* exact allocation bits, for the stack scan */
    begin_full(rt);
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++)  /* the rest of the blocks they were in, for the marking's allocation */
        if (current[sc]) list_push(&h->ready[sc], current[sc]);
    JSTracer *trc = xrealloc(NULL, sizeof *trc);
    *trc = (JSTracer){ .heap = h, .stack = h->mark_stack, .cap = h->mark_stack_cap, .stack_low = stack_low };
    h->mark_stack = NULL;  /* the marker's until the final pause */
    h->mark_stack_cap = 0;
    mark_roots(rt, trc);
    mark_stack(trc);  /* the final pause scans it again: this is a head start (a program's data is often only there) */
    flush_fifo(trc);
    h->marker = trc;

    size_t work = h->live_after_gc > h->min_heap ? h->live_after_gc : h->min_heap;  /* about what's to mark */
    size_t during = work / 8 > 2 * h->nursery ? work / 8 : 2 * h->nursery;
    h->mark_ratio = 1.25 * (double)work / (double)during;  /* some headroom: what the barrier marks too */
    h->mark_alloc_limit = 2 * during;
    reset_allocation_clock(h);
    h->full_next = 0;
    h->slice_clock = 0;
    h->next_slice = SLICE_BYTES;
    h->in_gc = 0;

    double pause = js_os_now_ms_precise() - start;
    h->marking_ms = pause;
    h->marking_slices = 1;
    count_pause(h, pause);
    h->stats.mark_ms += pause;
    h->stats.mark_slices++;
}

static JS_NOINLINE void start_marking(JSContext *ctx) {
    jmp_buf regs;  /* the mutator's registers, for the stack scan: as collect_spilled */
    memset(&regs, 0, sizeof regs);
#if defined(__clang__) || defined(__GNUC__)
    __builtin_unwind_init();
#endif
    setjmp(regs);
    start_marking_at(ctx, &regs);
    (void)*(volatile char *)&regs;
}

/* A slice of `budget` bytes, or of what the allocation since the last one calls for (0). When the
 * marker has nothing left, or the program allocated as much as the marking may take, the final
 * pause comes next. */
static void mark_slice(JSContext *ctx, size_t budget) {
    JSHeap *h = &ctx->rt->heap;
    h->in_gc = 1;
    h->collect_requested = 0;
    double start = js_os_now_ms_precise();
    size_t clock = allocation_clock(h);
    if (budget) {
        h->slice_clock = clock;
    } else {  /* what the allocation since the last slice calls for, up to MAX_SLICE: the rest is owed */
        budget = (size_t)((double)(clock - h->slice_clock) * h->mark_ratio);
        if (budget > MAX_SLICE) budget = MAX_SLICE;
        h->slice_clock += (size_t)((double)budget / h->mark_ratio);
        if (h->slice_clock > clock) h->slice_clock = clock;
    }
    h->next_slice = clock + SLICE_BYTES;
    bool done = drain_some(h->marker, budget);
    h->in_gc = 0;

    double pause = js_os_now_ms_precise() - start;
    h->marking_ms += pause;
    h->marking_slices++;
    count_pause(h, pause);
    h->stats.mark_ms += pause;
    h->stats.mark_slices++;
    if (done || clock >= h->mark_alloc_limit) collect_spilled(ctx, true);
}

/* Spills the mutator's callee-saved registers into this frame, then
 * collects in deeper frames that the stack scan doesn't cover. */
static JS_NOINLINE void collect_spilled(JSContext *ctx, bool full) {
    jmp_buf regs;
    memset(&regs, 0, sizeof regs);  /* no stale words in the parts setjmp skips */
#if defined(__clang__) || defined(__GNUC__)
    __builtin_unwind_init();
#endif
    setjmp(regs);
    collect(ctx, &regs, full);
    (void)*(volatile char *)&regs;  /* keep this frame alive: no tail call */
}

JS_NOINLINE void js_gc(JSContext *ctx) {
    ctx->rt->heap.exact = true;  /* everything unreachable now: a marking in progress keeps some */
    collect_spilled(ctx, true);
}
JS_NOINLINE void js_gc_young(JSContext *ctx) { collect_spilled(ctx, false); }

/* Worth it when the program allocated, since the last idle collection, as much as a young
 * collection's worth, and a quarter of the old generation: what a full collection would find
 * free, and what the program would grow by before the next one anyway. */
bool js_gc_idle_wanted(const JSRuntime *rt) {
    const JSHeap *h = &rt->heap;
    if (h->marker) return true;  /* a marking in progress is finished while nothing else runs */
    size_t allocated = h->allocated_since_idle + h->allocated_since_gc + h->external_since_gc;
    size_t enough = old_size(h) / 4 > h->nursery ? old_size(h) / 4 : h->nursery;
    return allocated >= enough;
}

void js_gc_idle(JSContext *ctx) {
    JSRuntime *rt = ctx->rt;
    JSHeap *h = &rt->heap;
    h->idle = true;
    collect_spilled(ctx, true);
    h->idle = false;
    finish_sweeping(rt);  /* the empty blocks go to the pool, or back to the OS */
    while (h->empty) {    /* and the pool's too: the program is waiting */
        JSBlock *b = h->empty;
        h->empty = b->next;
        h->empty_count--;
        decommit_block(h, b);
    }
    unmap_large_cache(h);
    js_os_trim();  /* what the finalizers freed: buffers' bytes */
    h->allocated_since_idle = 0;
}

/* Below this much old generation, a full collection's pause is about a millisecond: it isn't
 * worth marking incrementally (no young collections meanwhile, and the barrier's slow path). */
#define INCREMENTAL_MIN ((size_t)8 << 20)

/* The collection the policy asks for: young, or full when the old generation has outgrown its
 * limit, which starts an incremental marking when it's large enough; full at once when the heap
 * is near its limit (and it finishes a marking in progress). */
static void collect_as_needed(JSContext *ctx, bool near_limit) {
    JSHeap *h = &ctx->rt->heap;
    if (h->full_next && !near_limit && !h->marker && h->incremental && h->live_after_gc >= INCREMENTAL_MIN) {
        start_marking(ctx);
        return;
    }
    if (near_limit) h->exact = true;
    collect_spilled(ctx, near_limit || h->full_next || h->marker);
}

/* What allocation's slow paths owe the collector, when it's anything: a collection the external
 * memory asked for, or a marking slice. */
static JS_NOINLINE void gc_poll(JSContext *ctx) {
    JSHeap *h = &ctx->rt->heap;
    if (h->marker) {
        if (h->collect_requested || allocation_clock(h) >= h->next_slice) mark_slice(ctx, 0);
    } else if (h->collect_requested) {
        collect_as_needed(ctx, false);
    }
}

void js_gc_start_marking(JSContext *ctx) {
    if (!ctx->rt->heap.marker) start_marking(ctx);
}

bool js_gc_marking(const JSRuntime *rt) { return rt->heap.marker != NULL; }

void js_gc_mark_slice(JSContext *ctx, size_t bytes) {
    if (ctx->rt->heap.marker) mark_slice(ctx, bytes ? bytes : 1);
}

/* ---- Runtime lifetime -------------------------------------------------- */

/* JS_GC_STATS=1: one JSON line on stderr when the runtime ends, or when the process exits first
 * (process.exit). Prefixed `[gc-stats] ` so tools can find it among the program's output. */
static JSRuntime *stats_runtime;  /* the runtime whose statistics the exit handler prints */

static void print_stats(const JSRuntime *rt) {
    const JSGCStats *s = &rt->heap.stats;
    fprintf(stderr,
            "[gc-stats] {\"collections\":%llu,\"young_collections\":%llu,\"pause_ms\":%.3f,\"max_pause_ms\":%.3f,\"mark_ms\":%.3f,"
            "\"weak_ms\":%.3f,\"finish_ms\":%.3f,\"sweep_ms\":%.3f,\"blocks_swept\":%llu,"
            "\"allocated_bytes\":%llu,\"peak_heap_bytes\":%zu,\"peak_rss_bytes\":%zu,\"peak_external_bytes\":%zu,\"idle_collections\":%llu,\"mark_slices\":%llu,"
            "\"parallel_markings\":%llu,\"gc_threads\":%u}\n",
            (unsigned long long)s->collections, (unsigned long long)s->young_collections, s->pause_ms, s->max_pause_ms, s->mark_ms, s->weak_ms, s->finish_ms,
            s->sweep_ms, (unsigned long long)s->blocks_swept,
            (unsigned long long)(s->allocated_bytes + rt->heap.allocated_since_gc), s->peak_heap_bytes, js_os_peak_rss(), s->peak_external_bytes, (unsigned long long)s->idle_collections, (unsigned long long)s->mark_slices,
            (unsigned long long)s->parallel_markings, rt->heap.pool ? rt->heap.pool->helpers : 0);
}

static void print_stats_at_exit(void) {
    if (stats_runtime) print_stats(stats_runtime);
}

static int report_flags(void) {
    const char *trace = getenv("JS_GC_TRACE"), *stats = getenv("JS_GC_STATS");
    return (trace && *trace && *trace != '0' ? 1 : 0) | (stats && *stats && *stats != '0' ? 2 : 0);
}

const JSGCStats *js_gc_stats(const JSRuntime *rt) {
    return &rt->heap.stats;
}

JSRuntime *js_runtime_new(void) {
    JSRuntime *rt = calloc(1, sizeof *rt);
    if (!rt) js_fatal("out of memory creating a runtime");
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++) rt->heap.alloc[sc].cell_size = js_size_class_bytes[sc];
    void *stack_low;
    js_os_stack_bounds(&stack_low, &rt->heap.stack_base);
    rt->stack_limit = (uintptr_t)stack_low + JS_STACK_MARGIN;
    rt->exception = JS_EMPTY;
    rt->symbol_registry = JS_UNDEFINED;
    rt->async_context = JS_UNDEFINED;
    rt->heap.min_heap = JS_GC_MIN_HEAP;
    rt->heap.nursery = JS_GC_NURSERY;
    rt->heap.old_limit = JS_GC_MIN_HEAP;
    /* helper threads for the pauses' marking: two, or one less than the processors (env
     * JS_GC_THREADS: how many; 0 marks alone). A third was measured: no shorter pauses. */
    unsigned cpus = js_os_cpu_count();
    rt->heap.gc_helpers = cpus > 3 ? 2 : cpus - 1;
    const char *threads = getenv("JS_GC_THREADS");
    if (threads && *threads) rt->heap.gc_helpers = (unsigned)strtoul(threads, NULL, 10);
    if (rt->heap.gc_helpers > MAX_HELPERS) rt->heap.gc_helpers = MAX_HELPERS;
    const char *incremental = getenv("JS_GC_INCREMENTAL");  /* 0: old collections stop the world */
    rt->heap.incremental = !(incremental && *incremental == '0');
    const char *growth = getenv("JS_GC_GROWTH");  /* a fixed growth factor, for experiments */
    if (growth && strtod(growth, NULL) >= 1) rt->heap.growth = strtod(growth, NULL);
    const char *nursery = getenv("JS_GC_NURSERY_MB");  /* for tuning experiments */
    if (nursery && strtoull(nursery, NULL, 10)) rt->heap.nursery = (size_t)strtoull(nursery, NULL, 10) << 20;
    const char *limit = getenv("JS_HEAP_LIMIT_MB");
    if (limit) rt->heap.heap_limit = (size_t)strtoull(limit, NULL, 10) << 20;
    const char *interval = getenv("JS_GC_STRESS_INTERVAL");
    rt->heap.stress_interval = interval ? (size_t)strtoull(interval, NULL, 10) : 1;
    rt->heap.report = report_flags();
    if (rt->heap.report & 2) {
        static int registered;
        if (!registered) atexit(print_stats_at_exit);
        registered = 1;
        stats_runtime = rt;
    }
    js_atoms_init(rt);
    return rt;
}

void js_set_heap_limit(JSRuntime *rt, size_t bytes) {
    rt->heap.heap_limit = bytes;
}

size_t js_heap_size(const JSRuntime *rt) {
    return (rt->heap.block_count - rt->heap.decommitted_count) * JS_BLOCK_SIZE + rt->heap.large_bytes;
}

/* Runs the finalizers of every allocated cell in `b` that has one. */
static void finalize_block(JSRuntime *rt, JSBlock *b) {
    if (!b->has_finalizable) return;
    for (uint32_t i = 0; i < b->cell_count; i++) {
        JSCell *c = (JSCell *)block_cell(b, i);
        if (bit_get(b->alloc_bits, i) && (c->flags & JS_CELL_FINALIZABLE)) finalize_cell(rt, c);
    }
}

void js_runtime_free(JSRuntime *rt) {
    JSHeap *h = &rt->heap;
    if (h->report & 2) print_stats(rt);
    if (stats_runtime == rt) stats_runtime = NULL;
    stop_allocation(h);
    /* every finalizer first, then the memory: a finalizer may read cells in other blocks (shapes) */
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++)
        for (JSBlock *b = h->blocks[sc]; b; b = b->next) finalize_block(rt, b);
    for (size_t i = 0; i < h->large_count; i++) finalize_block(rt, h->large[i]);
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++) {
        for (JSBlock *b = h->blocks[sc], *next; b; b = next) {
            next = b->next;
            js_os_unmap(b, JS_BLOCK_SIZE);
        }
    }
    for (JSBlock *b = h->empty, *next; b; b = next) {
        next = b->next;
        js_os_unmap(b, JS_BLOCK_SIZE);
    }
    for (size_t i = 0; i < h->large_count; i++) js_os_unmap(h->large[i], h->large[i]->map_size);
    for (size_t i = 0; i < h->decommitted_count; i++) js_os_unmap(h->decommitted[i].block, JS_BLOCK_SIZE);
    unmap_large_cache(h);
    js_atoms_free(rt);
    js_shapes_free(rt);
    js_prop_caches_free(rt);
    js_jobs_free(rt);
    js_weak_free(rt);
    while (rt->realms) js_context_free(rt->realms);  /* e.g. $262.createRealm()'s */
    free(h->large);
    free(h->block_set);
    free(h->root_tables);
    free(h->roots);
    free_mark_pool(h);
    free(h->mark_stack);
    if (h->marker) {
        free(h->marker->stack);
        free(h->marker);
    }
    free(h->remembered);
    free(h->decommitted);
    free(h->large_cache);
    for (unsigned sc = 0; sc < JS_NUM_SIZE_CLASSES; sc++) {
        free(h->to_sweep[sc].items);
        free(h->ready[sc].items);
    }
    free(h->young_blocks.items);
    free(rt);
}

JSContext *js_context_new(JSRuntime *rt) {
    JSContext *ctx = calloc(1, sizeof *ctx);
    if (!ctx) js_fatal("out of memory creating a context");
    ctx->rt = rt;
    ctx->stack_limit = rt->stack_limit;
    ctx->barrier_threshold = JS_GC_OLD;
    for (unsigned i = 0; i < JS_INTRINSIC_COUNT; i++) ctx->intrinsics[i] = JS_UNDEFINED;
    ctx->next_realm = rt->realms;
    rt->realms = ctx;
    js_realm_init(ctx);
    js_install_recorded_components(ctx);  /* the program's optional built-ins */
    return ctx;
}

void js_context_free(JSContext *ctx) {
    JSContext **link = &ctx->rt->realms;
    while (*link != ctx) link = &(*link)->next_realm;
    *link = ctx->next_realm;
    free(ctx);
}
