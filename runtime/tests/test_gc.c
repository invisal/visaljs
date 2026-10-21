/* Heap and GC. */
#include <stdlib.h>
#include <string.h>

#include "js_builtins.h"
#include "js_object.h"
#include "jscontext.h"
#include "jstest.h"

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif

/* GC-stress builds collect on every allocation: shrink the big loops. */
#ifdef JS_GC_STRESS
#define SCALED(n) ((n) / 200 + 1)
#else
#define SCALED(n) (n)
#endif

TEST(gc_size_classes) {
    for (unsigned c = 0; c < JS_NUM_SIZE_CLASSES; c++) {
        CHECK_EQ_INT(js_size_class_bytes[c] % JS_CELL_ALIGN, 0);
        if (c) CHECK(js_size_class_bytes[c] > js_size_class_bytes[c - 1]);
    }
    CHECK_EQ_INT(js_size_class_bytes[JS_NUM_SIZE_CLASSES - 1], JS_MAX_SMALL_SIZE);
    for (size_t size = 1; size <= JS_MAX_SMALL_SIZE; size++) {
        unsigned c = js_size_class(size);
        if (c >= JS_NUM_SIZE_CLASSES) {
            JST_FAIL_("size %zu: class %u out of range", size, c);
            return;
        }
        /* the smallest class that fits */
        if (js_size_class_bytes[c] < size || (c > 0 && js_size_class_bytes[c - 1] >= size)) {
            JST_FAIL_("size %zu: class %u (%u bytes)", size, c, js_size_class_bytes[c]);
            return;
        }
    }
    /* a few sizes and the classes they round up to */
    CHECK_EQ_INT(js_size_class_bytes[js_size_class(22)], 32);
    CHECK_EQ_INT(js_size_class_bytes[js_size_class(64)], 64);
    CHECK_EQ_INT(js_size_class_bytes[js_size_class(129)], 160);
    CHECK_EQ_INT(js_size_class_bytes[js_size_class(257)], 320);
}

TEST(gc_block_layout) {
    CHECK_EQ_INT(JS_BLOCK_FIRST_CELL % JS_CELL_ALIGN, 0);
    CHECK((JS_BLOCK_SIZE - JS_BLOCK_FIRST_CELL) / 16 <= JS_BLOCK_MAX_CELLS);
    CHECK((JS_BLOCK_SIZE - JS_BLOCK_FIRST_CELL) / JS_MAX_SMALL_SIZE >= 7);
}

static int all_zero(const void *p, size_t n) {
    const unsigned char *b = p;
    for (size_t i = 0; i < n; i++)
        if (b[i]) return 0;
    return 1;
}

TEST(gc_alloc_small) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    static const size_t sizes[] = { 8, 16, 17, 40, 128, 200, 1000, 4096, 8192 };
    for (size_t i = 0; i < sizeof sizes / sizeof sizes[0]; i++) {
        JSCell *c = js_alloc_cell(ctx, JS_CELL_VALUE_ARRAY, sizes[i]);
        CHECK(((uintptr_t)c & (JS_CELL_ALIGN - 1)) == 0);
        CHECK_EQ_INT(c->kind, JS_CELL_VALUE_ARRAY);
        CHECK(all_zero((char *)c + 1, sizes[i] - 1));
        JSBlock *b = js_block_of(c);
        CHECK_EQ_INT(b->size_class, js_size_class(sizes[i]));
        CHECK((char *)c >= (char *)b + JS_BLOCK_FIRST_CELL);
        CHECK((char *)c + b->cell_size <= (char *)b + JS_BLOCK_SIZE);
        CHECK(js_is_cell(js_cell(c)));
        CHECK(((uintptr_t)c >> 48) == 0);
    }
    js_context_free(ctx);
    js_runtime_free(rt);
}

TEST(gc_alloc_many_blocks) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    enum { N = 20000 };
    size_t base = rt->heap.block_count;  /* the realm's own objects (Object.prototype, its shape) */
    JSValue *root = malloc(sizeof *root);
    JSValueArray *all = js_alloc_value_array(ctx, N);  /* large object, keeps the cells */
    *root = js_cell(&all->cell);
    js_add_root(rt, root);
    for (int i = 0; i < N; i++) {
        JSCell *c = js_alloc_cell(ctx, JS_CELL_VALUE_ARRAY, 48);
        c->aux = 0;
        js_store(ctx, &all->cell, &all->values[i], js_cell(c));
        ((JSValueArray *)c)->values[0] = js_int32(i);  /* 48 bytes: header + 5 values */
    }
    int distinct = 1;  /* no overlap: every cell keeps its own value */
    for (int i = 0; i < N; i++)
        distinct &= js_as_int32(((JSValueArray *)js_as_cell(all->values[i]))->values[0]) == i;
    CHECK(distinct);
    size_t per_block = (JS_BLOCK_SIZE - JS_BLOCK_FIRST_CELL) / 48;
    /* the realm may have left room in a block of this size class */
    CHECK(rt->heap.block_count - base >= N / per_block && rt->heap.block_count - base <= (N + per_block - 1) / per_block);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

TEST(gc_alloc_large) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    size_t base = rt->heap.block_count;
    JSCell *a = js_alloc_cell(ctx, JS_CELL_VALUE_ARRAY, 100000);
    JSCell *b = js_alloc_cell(ctx, JS_CELL_VALUE_ARRAY, JS_MAX_SMALL_SIZE + 1);
    JSCell *c = js_alloc_cell(ctx, JS_CELL_VALUE_ARRAY, 1 << 20);
    CHECK(((uintptr_t)a & (JS_CELL_ALIGN - 1)) == 0 && ((uintptr_t)b & (JS_CELL_ALIGN - 1)) == 0);
    CHECK(all_zero((char *)a + 8, 100000 - 8) && all_zero((char *)c + 8, (1 << 20) - 8));
    CHECK_EQ_INT(a->kind, JS_CELL_VALUE_ARRAY);
    CHECK_EQ_INT(rt->heap.block_count, base);
    CHECK_EQ_INT(rt->heap.large_count, 3);
    for (size_t i = 1; i < rt->heap.large_count; i++) CHECK(rt->heap.large[i - 1] < rt->heap.large[i]);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* ---- Collection -------------------------------------------------------- */
/*
 * The stack scan is conservative, so a stale pointer on the stack or in a
 * callee-saved register keeps its cell alive. So in these tests a cell pointer
 * never passes through a TEST body: NOINLINE helpers allocate and read cells
 * through root slots, and the dead stack area below them is scrubbed before
 * collecting so the GC's own frames don't inherit old pointers.
 */


/* Not ASan-instrumented: its frame must be just the buffer, with no redzones
 * that would keep stale words. */
static NOINLINE JST_NO_ASAN void scrub_stack(void) {
    volatile char buf[64 * 1024];
    for (size_t i = 0; i < sizeof buf; i++) buf[i] = 0;
}

/* The first GC marks; the second one's pre-marking sweep finalizes the dead.
 * Scrub before gc_twice's frame exists: its unused slots would otherwise hold
 * whatever the last helper left there. */
static NOINLINE void gc_twice(JSContext *ctx) {
    js_gc(ctx);
    scrub_stack();
    js_gc(ctx);
}
#define gc2(ctx) (scrub_stack(), gc_twice(ctx))

static int finalized;
static void count_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    (void)c;
    finalized++;
}
static const JSCellClass counted_class = { "Counted", NULL, count_finalize, NULL };

/* A counted host cell that also holds one JSValue. */
typedef struct { JSHostCell host; JSValue v; } Holder;
static void holder_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((Holder *)c)->v); }
static const JSCellClass holder_class = { "Holder", holder_visit, count_finalize, NULL };

static NOINLINE void make_garbage(JSContext *ctx, int n, size_t size) {
    for (int i = 0; i < n; i++) js_alloc_host_cell(ctx, &counted_class, size);
}

static NOINLINE JSValue make_counted(JSContext *ctx, size_t size) {
    return js_cell(&js_alloc_host_cell(ctx, &counted_class, size)->cell);
}

static NOINLINE void put_counted(JSContext *ctx, JSValue *slot, size_t size) {
    *slot = make_counted(ctx, size);
}

/* An array of n Holders holding 0 … n-1. */
static NOINLINE JSValue make_tree(JSContext *ctx, int n) {
    JSValueArray *a = js_alloc_value_array(ctx, (uint32_t)n);
    for (int i = 0; i < n; i++) {
        Holder *h = (Holder *)js_alloc_host_cell(ctx, &holder_class, sizeof(Holder));
        h->v = js_int32(i);
        js_store(ctx, &a->cell, &a->values[i], js_cell(&h->host.cell));
    }
    return js_cell(&a->cell);
}

static NOINLINE void put_tree(JSContext *ctx, JSValue *slot, int n) {
    *slot = make_tree(ctx, n);
}

static NOINLINE int tree_intact(const JSValue *slot, int n) {
    JSValueArray *a = (JSValueArray *)js_as_cell(*slot);
    int ok = a->cell.aux == (uint32_t)n;
    for (int i = 0; ok && i < n; i++) ok = js_as_int32(((Holder *)js_as_cell(a->values[i]))->v) == i;
    return ok;
}

TEST(gc_collects_unreachable) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    finalized = 0;
    make_garbage(ctx, 1000, 32);
    make_garbage(ctx, 10, 20000);  /* large */
#ifndef JS_GC_STRESS  /* stress builds have collected them already */
    CHECK_EQ_INT(rt->heap.large_count, 10);
#endif
    gc2(ctx);
    CHECK_EQ_INT(finalized, 1010);
    CHECK_EQ_INT(rt->heap.large_count, 0);
    js_context_free(ctx);
    js_runtime_free(rt);
    CHECK_EQ_INT(finalized, 1010);  /* never twice */
}

TEST(gc_keeps_rooted) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    finalized = 0;
    JSValue *slot = malloc(sizeof *slot);  /* a JSValue in malloc'd memory */
    put_tree(ctx, slot, 500);
    js_add_root(rt, slot);
    make_garbage(ctx, 300, 32);
    gc2(ctx);
    CHECK_EQ_INT(finalized, 300);
    CHECK(tree_intact(slot, 500));

    js_remove_root(rt, slot);
    *slot = JS_UNDEFINED;
    gc2(ctx);
    CHECK_EQ_INT(finalized, 800);
    free(slot);
    js_context_free(ctx);
    js_runtime_free(rt);
}

TEST(gc_root_tables) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    static JSValue globals[3];  /* module globals, as the compiler emits them */
    js_register_roots(rt, globals, 3);
    finalized = 0;
    put_counted(ctx, &globals[0], 16);
    globals[1] = js_int32(7);
    put_counted(ctx, &globals[2], 16);
    gc2(ctx);
    CHECK_EQ_INT(finalized, 0);
    globals[0] = JS_NULL;
    gc2(ctx);
    CHECK_EQ_INT(finalized, 1);
    js_context_free(ctx);
    js_runtime_free(rt);
    CHECK_EQ_INT(finalized, 2);  /* live cells are finalized when the runtime goes away */
}

static NOINLINE void put_list(JSContext *ctx, JSValue *slot, int n) {
    JSValue head = JS_NULL;
    for (int i = 0; i < n; i++) {
        JSValueArray *node = js_alloc_value_array(ctx, 2);
        js_init_slot(&node->values[0], js_int32(i));
        js_init_slot(&node->values[1], head);
        head = js_cell(&node->cell);
    }
    *slot = head;
}

static NOINLINE int list_length_if_intact(const JSValue *slot) {
    JSValue v = *slot;
    int count = 0;
    int32_t expect = -1;
    for (; !js_is_null(v); v = ((JSValueArray *)js_as_cell(v))->values[1], count++) {
        int32_t x = js_as_int32(((JSValueArray *)js_as_cell(v))->values[0]);
        if (expect >= 0 && x != expect) return -1;
        expect = x - 1;
    }
    return count;
}

/* A 1,000,000-long linked list: marking must not recurse. */
TEST(gc_deep_list) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    const int N = SCALED(1000000);
    size_t base = rt->heap.block_count;
    JSValue *head = malloc(sizeof *head);
    *head = JS_NULL;
    js_add_root(rt, head);
    put_list(ctx, head, N);
    gc2(ctx);
    CHECK_EQ_INT(list_length_if_intact(head), N);

    *head = JS_NULL;
    gc2(ctx);
    /* Every list block came back empty; all but a nursery's worth went back to the OS, decommitted
     * and then, unused for a full collection, unmapped. */
    CHECK_EQ_INT(rt->heap.block_count - rt->heap.empty_count - rt->heap.decommitted_count, base);
    CHECK(js_heap_size(rt) <= JS_GC_NURSERY + base * JS_BLOCK_SIZE);
    gc2(ctx);
    CHECK_EQ_INT(rt->heap.decommitted_count, 0);
    CHECK(rt->heap.block_count <= JS_GC_NURSERY / JS_BLOCK_SIZE + base);
    js_remove_root(rt, head);
    free(head);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* An object class whose finalizer checks it can still reach its class through its shape. */
static int probes_ok, probes_bad;
static void probe_finalize(JSRuntime *rt, JSCell *c);
static const JSClass probe_class = { "Probe", sizeof(JSObject), NULL, NULL, NULL, NULL, NULL, probe_finalize, NULL };
static void probe_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    if (((JSObject *)c)->shape->cls == &probe_class) probes_ok++;
    else probes_bad++;
}

/* Objects whose shapes die with them (each has its own prototype, so its own root shape). */
static NOINLINE void make_probes(JSContext *ctx, int n) {
    for (int i = 0; i < n; i++) js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &probe_class, js_new_object(ctx), 0));
}

/* Finalizers run before any dead cell's memory is reused: lazy sweeping could otherwise reuse
 * a dead object's shape before the object's own block is swept and finalized. */
TEST(gc_finalizers_before_reuse) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    probes_ok = probes_bad = 0;
    make_probes(ctx, 2000);
    scrub_stack();
    js_gc(ctx);
    for (int i = 0; i < 20000; i++) js_shape_root(ctx, &js_class_object, js_new_object(ctx), 0);  /* reuse */
    gc2(ctx);
    CHECK_EQ_INT(probes_bad, 0);
    CHECK(probes_ok >= 1990);  /* the conservative scan may keep a few */
    js_context_free(ctx);
    js_runtime_free(rt);
    CHECK_EQ_INT(probes_bad, 0);
}

/* Garbage-heavy loop: memory stays bounded when collections run. */
TEST(gc_reuses_memory) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    finalized = 0;
    size_t first = 0;
    for (int round = 0; round < 50; round++) {
        make_garbage(ctx, SCALED(20000), 48);
        scrub_stack();
        js_gc(ctx);
        if (round == 1) first = rt->heap.block_count;
    }
    CHECK(rt->heap.block_count <= first + 1);
    CHECK(finalized >= 48 * SCALED(20000));
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* After a collection the dead cells between survivors are reused, in address order within a
 * block, zeroed, without touching the survivors or mapping a block. */
TEST(gc_alloc_fills_holes) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    rt->heap.stress_interval = (size_t)1 << 40;  /* stress builds: only the collection below */
    JSContext *ctx = js_context_new(rt);
    enum { SIZE = 600, PER_BLOCK = (JS_BLOCK_SIZE - JS_BLOCK_FIRST_CELL) / 640 };  /* the 640-byte class */
    JSValue *root = malloc(sizeof *root);
    JSValueArray *all = js_alloc_value_array(ctx, 4 * PER_BLOCK);
    *root = js_cell(&all->cell);
    js_add_root(rt, root);
    /* the cells from `first` on fill three blocks: the ones before it fill the class's block, if it
     * has one, and stay alive */
    int first = -1, n = 0;
    while (first < 0 || n < first + 3 * PER_BLOCK) {
        JSCell *c = js_alloc_cell(ctx, JS_CELL_VALUE_ARRAY, SIZE);  /* aux 0: holds no values */
        memset((char *)c + sizeof *c, 0xAB, SIZE - sizeof *c);
        js_store(ctx, &all->cell, &all->values[n], js_cell(c));
        if (first < 0 && (char *)c == (char *)js_block_of(c) + JS_BLOCK_FIRST_CELL) first = n;
        n++;
    }
    static uintptr_t dead[3 * PER_BLOCK];
    int n_dead = 0;
    for (int i = first; i < n; i++)
        if ((i - first) % 3) {
            dead[n_dead++] = (uintptr_t)js_as_cell(all->values[i]);
            all->values[i] = JS_UNDEFINED;
        }
    scrub_stack();
    js_gc(ctx);
    size_t blocks = rt->heap.block_count;
    int reused = 0, zeroed = 1, ordered = 1;
    uintptr_t last = 0;
    for (int k = 0; k < n_dead - 8; k++) {  /* the conservative scan may keep a few */
        char *c = (char *)js_alloc_cell(ctx, JS_CELL_VALUE_ARRAY, SIZE);
        for (int d = 0; d < n_dead; d++) reused += dead[d] == (uintptr_t)c;
        zeroed &= all_zero(c + sizeof(JSCell), SIZE - sizeof(JSCell));
        if (js_block_of(c) == js_block_of((void *)last)) ordered &= (uintptr_t)c > last;
        last = (uintptr_t)c;
    }
    CHECK_EQ_INT(reused, n_dead - 8);
    CHECK(zeroed);
    CHECK(ordered);
    CHECK_EQ_INT(rt->heap.block_count, blocks);
    int intact = 1;
    for (int i = 0; i < n; i++) {
        if (i >= first && (i - first) % 3) continue;
        const unsigned char *c = (const unsigned char *)js_as_cell(all->values[i]);
        for (int k = sizeof(JSCell); k < SIZE; k++) intact &= c[k] == 0xAB;
    }
    CHECK(intact);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* A young collection frees the young garbage and leaves the old cells alone. */
TEST(gc_young_collection) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    rt->heap.stress_interval = (size_t)1 << 40;  /* stress builds: only the collections below */
    JSContext *ctx = js_context_new(rt);
    JSValue *root = malloc(sizeof *root);
    *root = JS_UNDEFINED;
    js_add_root(rt, root);
    put_tree(ctx, root, 100);
    js_gc(ctx);  /* the tree is old */
    CHECK_EQ_INT(js_as_cell(*root)->gc, JS_GC_OLD);
    finalized = 0;
    make_garbage(ctx, 1000, 48);
    scrub_stack();
    js_gc_young(ctx);
    CHECK(finalized >= 990);  /* the conservative scan may keep a few */
    CHECK(tree_intact(root, 100));
    CHECK_EQ_INT((int)rt->heap.stats.young_collections, 1);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* A young cell that only an old one points to survives a young collection: the store remembered
 * the old cell. */
TEST(gc_barrier_keeps_young) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    rt->heap.stress_interval = (size_t)1 << 40;
    JSContext *ctx = js_context_new(rt);
    JSValue *root = malloc(sizeof *root);
    JSValueArray *a = js_alloc_value_array(ctx, 4);
    *root = js_cell(&a->cell);
    js_add_root(rt, root);
    js_gc(ctx);
    finalized = 0;
    put_counted(ctx, &a->values[1], 32);  /* raw: a->values[1] = ... would skip the barrier */
    js_store(ctx, &a->cell, &a->values[0], a->values[1]);
    a->values[1] = JS_UNDEFINED;  /* barrier: not a cell */
    CHECK_EQ_INT(a->cell.gc, JS_GC_REMEMBERED);
    scrub_stack();
    js_gc_young(ctx);
    CHECK_EQ_INT(finalized, 0);
    CHECK_EQ_INT(a->cell.gc, JS_GC_OLD);
    CHECK_EQ_INT(js_as_cell(a->values[0])->gc, JS_GC_OLD);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* A large old array remembers the card a store went to, and a young collection visits that
 * card only. */
TEST(gc_barrier_cards) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    rt->heap.stress_interval = (size_t)1 << 40;
    JSContext *ctx = js_context_new(rt);
    enum { N = 5000 };  /* 40 KB: a large object */
    JSValue *root = malloc(sizeof *root);
    JSValueArray *a = js_alloc_value_array(ctx, N);
    *root = js_cell(&a->cell);
    js_add_root(rt, root);
    js_gc(ctx);
    CHECK_EQ_INT(a->cell.gc, JS_GC_OLD_LARGE);
    JSBlock *b = js_block_of(a);
    finalized = 0;
    put_counted(ctx, &a->values[N - 1], 32);
    js_store(ctx, &a->cell, &a->values[4000], a->values[N - 1]);
    a->values[N - 1] = JS_UNDEFINED;  /* barrier: not a cell */
    size_t card = ((size_t)((char *)&a->values[4000] - (char *)a)) >> b->card_shift;
    CHECK(b->remembered);
    CHECK((b->cards[card / 64] >> (card % 64)) & 1);
    CHECK_EQ_INT(a->cell.gc, JS_GC_OLD_LARGE);  /* the next stores mark their own cards */
    scrub_stack();
    js_gc_young(ctx);
    CHECK_EQ_INT(finalized, 0);
    CHECK(!b->remembered);
    CHECK(!((b->cards[card / 64] >> (card % 64)) & 1));
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* Empty blocks go to a shared pool and serve any size class. */
TEST(gc_empty_blocks_change_class) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    size_t base = rt->heap.block_count;
    make_garbage(ctx, 2000, 600);  /* the 640-byte class: the realm's own objects don't use it */
    size_t blocks = rt->heap.block_count;
    gc2(ctx);
    CHECK_EQ_INT(rt->heap.empty_count, blocks - base);
    make_garbage(ctx, 1000, 512);  /* a different class */
    CHECK_EQ_INT(rt->heap.block_count, blocks);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* Static cells (compiler-emitted) are never marked, even when referenced. */
static const JSCell static_cell = JS_CELL_HEADER(JS_CELL_VALUE_ARRAY, JS_CELL_STATIC);

TEST(gc_static_cells) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    JSValue *root = malloc(sizeof *root);
    JSValueArray *a = js_alloc_value_array(ctx, 2);
    js_init_slot(&a->values[0], js_cell((JSCell *)&static_cell));
    js_init_slot(&a->values[1], js_double(1.5));
    *root = js_cell(&a->cell);
    js_add_root(rt, root);
    gc2(ctx);  /* would write to .rodata (and crash) if it tried to mark it */
    CHECK(js_as_cell(a->values[0]) == &static_cell);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* A large object keeps small cells alive, and dies with them. */
TEST(gc_large_objects) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    finalized = 0;
    JSValue *root = malloc(sizeof *root);
    put_tree(ctx, root, 5000);  /* 5000 * 8 bytes: a large value array */
    js_add_root(rt, root);
    CHECK_EQ_INT(rt->heap.large_count, 1);
    gc2(ctx);
    CHECK_EQ_INT(finalized, 0);
    CHECK(tree_intact(root, 5000));
    *root = JS_UNDEFINED;
    gc2(ctx);
    CHECK_EQ_INT(finalized, 5000);
    CHECK_EQ_INT(rt->heap.large_count, 0);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* ---- Conservative stack scan ------------------------------------------- */

/* Only these volatile stack slots refer to the cells: no precise root anywhere. */
static NOINLINE void hold_on_stack(JSContext *ctx, int *failures) {
    JSHostCell *volatile small = js_alloc_host_cell(ctx, &counted_class, 32);
    char *volatile interior = (char *)js_alloc_host_cell(ctx, &counted_class, 64) + 40;
    volatile JSValue boxed = make_counted(ctx, 48);
    JSHostCell *volatile large = js_alloc_host_cell(ctx, &counted_class, 50000);
    char *volatile large_interior = (char *)js_alloc_host_cell(ctx, &counted_class, 200000) + 150000;
    make_garbage(ctx, 100, 32);

    gc2(ctx);
    int before = jstest_failures;
    CHECK_EQ_INT(finalized, 100);
    CHECK(small->cls == &counted_class);
    CHECK(((JSHostCell *)(interior - 40))->cls == &counted_class);
    CHECK(((JSHostCell *)js_as_cell(boxed))->cls == &counted_class);
    CHECK(large->cls == &counted_class);
    CHECK(((JSHostCell *)(large_interior - 150000))->cls == &counted_class);
    CHECK_EQ_INT(ctx->rt->heap.large_count, 2);
    *failures = jstest_failures - before;
}

TEST(gc_conservative_stack) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    finalized = 0;
    int failures = 0;
    hold_on_stack(ctx, &failures);
    CHECK_EQ_INT(failures, 0);
    gc2(ctx);  /* the holding frame is gone */
    CHECK_EQ_INT(finalized, 105);
    CHECK_EQ_INT(rt->heap.large_count, 0);
    js_context_free(ctx);
    js_runtime_free(rt);
}

static NOINLINE uintptr_t block_of_new_cell(JSContext *ctx) {
    return (uintptr_t)js_block_of(js_as_cell(make_counted(ctx, 32)));
}

/* Words that aren't allocated cells never retain anything: a block header,
 * the end of a block, a number. */
TEST(gc_conservative_rejects) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    finalized = 0;
    uintptr_t b = block_of_new_cell(ctx);
    volatile uintptr_t header = b + 8;
    volatile uintptr_t past_end = b + JS_BLOCK_SIZE;
    volatile JSValue num = js_double(123.25);
    gc2(ctx);
    CHECK_EQ_INT(finalized, 1);
    CHECK(header && past_end && js_is_double(num));
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* ---- Policy ------------------------------------------------------------ */

/* Keeps the last `window` cells alive in a rooted ring and drops the rest:
 * automatic collections must keep the heap small. */
static NOINLINE size_t churn(JSContext *ctx, JSValue *ring_slot, int n, int window) {
    JSValueArray *ring = (JSValueArray *)js_as_cell(*ring_slot);
    size_t peak = 0;
    for (int i = 0; i < n; i++) {
        JSValueArray *a = js_alloc_value_array(ctx, 3);  /* 32 bytes */
        js_init_slot(&a->values[0], js_int32(i));
        js_store(ctx, &ring->cell, &ring->values[i % window], js_cell(&a->cell));
        size_t size = js_heap_size(ctx->rt);
        if (size > peak) peak = size;
    }
    return peak;
}

/* Millions of allocations in a loop with bounded memory. */
TEST(gc_bounded_memory) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    JSValue *ring = malloc(sizeof *ring);
    *ring = js_cell(&js_alloc_value_array(ctx, 1000)->cell);
    js_add_root(rt, ring);
    size_t peak = churn(ctx, ring, SCALED(5000000), 1000);  /* 160 MB allocated in total */
    CHECK(rt->heap.gc_count > 0);
    CHECK(peak <= 3 * JS_GC_MIN_HEAP);
    js_remove_root(rt, ring);
    free(ring);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* A heap limit makes collections happen sooner; garbage never hits it. */
TEST(gc_heap_limit_collects) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    js_set_heap_limit(rt, (size_t)6 << 20);
    for (int i = 0; i < SCALED(200); i++) make_garbage(ctx, 1000, 1024);  /* ~200 MB */
    for (int i = 0; i < SCALED(200); i++) make_garbage(ctx, 1, 1 << 20);  /* large objects */
    CHECK(js_heap_size(rt) <= ((size_t)6 << 20));
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* A host cell that owns EXTERNAL bytes outside the heap. */
#define EXTERNAL ((size_t)1 << 20)
static void external_finalize(JSRuntime *rt, JSCell *c) {
    (void)c;
    js_gc_external_sub(rt, EXTERNAL);
    finalized++;
}
static const JSCellClass external_class = { "External", NULL, external_finalize, NULL };

static NOINLINE JSValue make_external(JSContext *ctx) {
    JSValue v = js_cell(&js_alloc_host_cell(ctx, &external_class, 32)->cell);
    js_gc_external_add(ctx->rt, EXTERNAL);
    return v;
}

static JSContext *policy_runtime(void) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    rt->heap.stress_interval = (size_t)1 << 40;  /* stress builds: only the policy's collections */
    return js_context_new(rt);
}

/* Small cells that own much outside the heap: what they own counts toward collections, so it
 * stays within a few nurseries, though the cells alone would never fill one. */
TEST(gc_external_memory_collects) {
    JSContext *ctx = policy_runtime();
    JSRuntime *rt = ctx->rt;
    finalized = 0;
    for (int i = 0; i < 1000; i++) (void)make_external(ctx);  /* 1 GB outside, 32 KB of cells */
    CHECK(rt->heap.gc_count >= 100);
    CHECK(finalized >= 900);
    CHECK(rt->heap.stats.peak_external_bytes <= 3 * JS_GC_NURSERY);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* External memory that a cell kept until it was old is old: the old generation's limit counts
 * it, and a full collection frees it when it dies. A ring of 8 cells, each replaced in turn,
 * leaves a dead old cell behind every few young collections. */
TEST(gc_external_memory_old) {
    JSContext *ctx = policy_runtime();
    JSRuntime *rt = ctx->rt;
    JSValue *root = malloc(sizeof *root);
    JSValueArray *ring = js_alloc_value_array(ctx, 64);
    *root = js_cell(&ring->cell);
    js_add_root(rt, root);
    for (uint32_t i = 0; i < 64; i++) js_store(ctx, &ring->cell, &ring->values[i], make_external(ctx));
    js_gc(ctx);
    CHECK(rt->heap.old_after_full >= 64 * EXTERNAL);
    CHECK(rt->heap.old_limit >= rt->heap.old_after_full + 16 * EXTERNAL);  /* GROWTH_MIN, 1.25 */
    for (uint32_t i = 8; i < 64; i++) js_store(ctx, &ring->cell, &ring->values[i], JS_UNDEFINED);
    finalized = 0;
    for (int i = 0; i < 2000; i++) js_store(ctx, &ring->cell, &ring->values[i % 8], make_external(ctx));
    CHECK(rt->heap.stats.collections - rt->heap.stats.young_collections >= 2);  /* full ones */
    CHECK(finalized >= 1900);
    CHECK(rt->heap.stats.peak_external_bytes <= 2 * 64 * EXTERNAL + 3 * JS_GC_NURSERY);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* After a full collection, the old generation may grow by a factor between GROWTH_MIN (1.25)
 * and GROWTH_MAX (2) of what's left; JS_GC_GROWTH (heap.growth) fixes it. */
TEST(gc_growth_policy) {
    JSContext *ctx = policy_runtime();
    JSRuntime *rt = ctx->rt;
    JSValue *root = malloc(sizeof *root);
    JSValueArray *keep = js_alloc_value_array(ctx, 16);
    *root = js_cell(&keep->cell);
    js_add_root(rt, root);
    for (uint32_t i = 0; i < 16; i++) js_store(ctx, &keep->cell, &keep->values[i], make_external(ctx));
    js_gc(ctx);
    size_t old = rt->heap.old_after_full;
    CHECK(old >= 16 * EXTERNAL);
    CHECK(rt->heap.old_limit >= old + old / 4 && rt->heap.old_limit <= 2 * old);
    rt->heap.growth = 1.5;
    js_gc(ctx);
    CHECK_EQ_INT((long long)rt->heap.old_limit, (long long)(rt->heap.old_after_full + rt->heap.old_after_full / 2));
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* Memory back to the OS: an idle collection gives back every empty block,
 * the pool's too, keeping their addresses; the allocator takes them again before it maps more. */
TEST(gc_idle_gives_back) {
    JSContext *ctx = policy_runtime();
    JSRuntime *rt = ctx->rt;
    size_t base = js_heap_size(rt);
    CHECK(!js_gc_idle_wanted(rt));
    for (int i = 0; i < 40; i++) make_garbage(ctx, 1000, 1024);  /* 40 MB (no stress collections: not scaled) */
    CHECK(js_gc_idle_wanted(rt));
    scrub_stack();
    js_gc_idle(ctx);
    CHECK(!js_gc_idle_wanted(rt));
    CHECK_EQ_INT((int)rt->heap.stats.idle_collections, 1);
    CHECK_EQ_INT(rt->heap.empty_count, 0);
    CHECK(rt->heap.decommitted_count > 0);
    CHECK(js_heap_size(rt) <= base + 4 * JS_BLOCK_SIZE);  /* the conservative scan may keep a few */
    size_t mapped = rt->heap.block_count, decommitted = rt->heap.decommitted_count;
    make_garbage(ctx, 100, 1024);  /* reuses decommitted blocks, zero-filled */
    CHECK(rt->heap.decommitted_count < decommitted);
    CHECK_EQ_INT(rt->heap.block_count, mapped);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* A value array holding `n`: whether it's still alive shows in it after its memory is reused. */
static NOINLINE JSValue numbered(JSContext *ctx, int32_t n) {
    JSValueArray *a = js_alloc_value_array(ctx, 1);
    js_init_slot(&a->values[0], js_int32(n));
    return js_cell(&a->cell);
}

static NOINLINE void churn_numbered(JSContext *ctx, int n) {
    for (int i = 0; i < n; i++) (void)numbered(ctx, -1);
}

/* Incremental marking: slices while the program runs. A large
 * array is visited a chunk at a time; the cells stored into it meanwhile, into the part already
 * visited too, survive (the barrier marks them), and what they replaced dies. */
TEST(gc_incremental_marking) {
    JSContext *ctx = policy_runtime();
    JSRuntime *rt = ctx->rt;
    enum { N = 20000 };  /* 160 KB: the marker visits it in three chunks */
    JSValue *root = malloc(sizeof *root);
    JSValueArray *big = js_alloc_value_array(ctx, N);
    *root = js_cell(&big->cell);
    js_add_root(rt, root);
    for (int32_t i = 0; i < N; i++) js_store(ctx, &big->cell, &big->values[i], numbered(ctx, i));
    js_gc(ctx);
    uint64_t young = rt->heap.stats.young_collections, slices = rt->heap.stats.mark_slices;
    js_gc_start_marking(ctx);
    js_gc_mark_slice(ctx, 64 << 10);  /* the array's first chunk */
    CHECK(js_gc_marking(rt));
    for (int32_t i = 0; i < N; i++) js_store(ctx, &big->cell, &big->values[i], numbered(ctx, N + i));
    churn_numbered(ctx, 5000);  /* new, and garbage */
    while (js_gc_marking(rt)) js_gc_mark_slice(ctx, 64 << 10);  /* the last one runs the final pause */
    CHECK(rt->heap.stats.mark_slices >= slices + 3);
    CHECK_EQ_INT((int)(rt->heap.stats.young_collections - young), 0);  /* none while marking */
    churn_numbered(ctx, 3 * N);  /* reuses the dead cells' memory */
    int intact = 1;
    for (int32_t i = 0; i < N; i++)
        intact &= js_as_int32(((JSValueArray *)js_as_cell(big->values[i]))->values[0]) == N + i;
    CHECK(intact);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* Parallel marking: two helper threads join a full collection of a
 * large graph (a huge array is split among them) and a young collection of a large array's many
 * marked cards. Everything reachable survives: its memory isn't reused. */
TEST(gc_parallel_marking) {
    JSContext *ctx = policy_runtime();
    JSRuntime *rt = ctx->rt;
    rt->heap.gc_helpers = 2;
    enum { N = 200000 };  /* 1.6 MB: split into chunks */
    JSValue *root = malloc(sizeof *root);
    JSValueArray *big = js_alloc_value_array(ctx, N);
    *root = js_cell(&big->cell);
    js_add_root(rt, root);
    for (int32_t i = 0; i < N; i++) js_store(ctx, &big->cell, &big->values[i], numbered(ctx, i));
    js_gc(ctx);
    uint64_t parallel = rt->heap.stats.parallel_markings;
    CHECK(parallel > 0 || !rt->heap.gc_helpers);  /* no threads: it marked alone */
    for (int32_t i = 0; i < N; i += 2) js_store(ctx, &big->cell, &big->values[i], numbered(ctx, N + i));  /* cards everywhere */
    js_gc_young(ctx);
    CHECK(rt->heap.stats.parallel_markings > parallel || !rt->heap.gc_helpers);
    churn_numbered(ctx, N);  /* reuses the dead cells' memory */
    int intact = 1;
    for (int32_t i = 0; i < N; i++)
        intact &= js_as_int32(((JSValueArray *)js_as_cell(big->values[i]))->values[0]) == (i % 2 ? i : N + i);
    CHECK(intact);
    js_remove_root(rt, root);
    free(root);
    js_context_free(ctx);
    js_runtime_free(rt);
}

#ifndef _WIN32
static NOINLINE void grow_forever(JSContext *ctx) {
    JSValue *head = malloc(sizeof *head);
    *head = JS_NULL;
    js_add_root(ctx->rt, head);
    for (;;) {
        JSValueArray *node = js_alloc_value_array(ctx, 7);
        js_init_slot(&node->values[0], *head);
        *head = js_cell(&node->cell);
    }
}

/* Runs `body` in a child process; its stderr (the start of it) goes to `msg`. Returns the
 * child's wait status. */
static int in_child(void (*body)(void), char *msg, size_t cap) {
    int fds[2];
    if (pipe(fds) != 0) return -1;
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
        dup2(fds[1], 2);
        body();
        _exit(0);
    }
    close(fds[1]);
    size_t n = 0;
    memset(msg, 0, cap);
    /* read to EOF, keeping the start: a sanitizer's exit report can fill the pipe and block the child */
    char rest[4096];
    for (ssize_t r; (r = n < cap - 1 ? read(fds[0], msg + n, cap - 1 - n) : read(fds[0], rest, sizeof rest)) > 0;)
        if (n < cap - 1) n += (size_t)r;
    close(fds[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    return status;
}

static void exceed_heap_limit(void) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    JSContext *ctx = js_context_new(rt);
    js_set_heap_limit(rt, (size_t)8 << 20);
    rt->heap.stress_interval = 1000;  /* GC-stress: every allocation would be quadratic here */
    grow_forever(ctx);
}

/* Live data beyond the limit: a clear message and a non-zero exit. */
TEST(gc_heap_limit_exits) {
    char msg[1024];
    int status = in_child(exceed_heap_limit, msg, sizeof msg);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) != 0);
    CHECK(strstr(msg, "heap limit reached (8 MiB)") != NULL);
}

#ifdef JS_GC_VERIFY
/* Checking builds. A cell the collector may free is kept
 * only as a disguised address, which the conservative stack scan can't recognize. */
#define DISGUISE ((uintptr_t)0x5A5A5A5A5A5A5A5Au)

static NOINLINE uintptr_t hidden_value_array(JSContext *ctx, uint32_t length) {
    return (uintptr_t)js_alloc_value_array(ctx, length) ^ DISGUISE;
}

static JSContext *quiet_runtime(void) {
    JSRuntime *rt = js_runtime_new();
    js_use_all_core(rt);
    rt->heap.stress_interval = (size_t)1 << 40;  /* no stress collections: these tests choose when */
    return js_context_new(rt);
}

/* A live cell pointing to a dead one: the next collection stops, naming the holder. */
static void store_dangling_pointer(void) {
    JSContext *ctx = quiet_runtime();
    static JSValue holder;
    holder = js_cell(&js_alloc_value_array(ctx, 1)->cell);
    js_add_root(ctx->rt, &holder);
    uintptr_t victim = hidden_value_array(ctx, 1);
    scrub_stack();
    js_gc(ctx);  /* the victim dies */
    JSValueArray *h = (JSValueArray *)js_as_cell(holder);
    h->values[0] = js_cell((JSCell *)(victim ^ DISGUISE));  /* a use after free */
    js_gc(ctx);
}

TEST(gc_verify_dangling_pointer) {
    char msg[1024];
    int status = in_child(store_dangling_pointer, msg, sizeof msg);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) != 0);
    CHECK(strstr(msg, "GC verify: ValueArray") != NULL);
    CHECK(strstr(msg, "which is not an allocated cell") != NULL);
}

/* A write into a cell after it died: caught when the cell is next allocated. */
static void write_after_death(void) {
    JSContext *ctx = quiet_runtime();
    const uint32_t length = 300;  /* a size class of its own here: 2560 bytes */
    uintptr_t first = hidden_value_array(ctx, length), victim = hidden_value_array(ctx, length);
    scrub_stack();
    js_gc(ctx);  /* both die; their block is swept when the class next allocates */
    /* cells are handed out in address order: allocate until it hands out `first`; `victim` is after it */
    for (int i = 0; i < 64 && (uintptr_t)js_alloc_value_array(ctx, length) != (first ^ DISGUISE); i++) {}
    ((char *)(victim ^ DISGUISE))[24] = 1;  /* a use after free */
    for (int i = 0; i < 64; i++) js_alloc_value_array(ctx, length);
}

/* A store into an old cell that skips the barrier: the next young collection stops, naming it. */
static void store_without_barrier(void) {
    JSContext *ctx = quiet_runtime();
    static JSValue holder;
    holder = js_cell(&js_alloc_value_array(ctx, 1)->cell);
    js_add_root(ctx->rt, &holder);
    js_gc(ctx);  /* the holder is old */
    ((JSValueArray *)js_as_cell(holder))->values[0] = js_cell(&js_alloc_value_array(ctx, 1)->cell);  /* barrier: none, on purpose */
    js_gc_young(ctx);
}

TEST(gc_verify_missing_barrier) {
    char msg[1024];
    int status = in_child(store_without_barrier, msg, sizeof msg);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) != 0);
    CHECK(strstr(msg, "GC verify: old ValueArray") != NULL);
    CHECK(strstr(msg, "but isn't remembered") != NULL);
}

/* The same in a large array with another card marked: the unmarked ones are still checked. */
static void store_without_card(void) {
    JSContext *ctx = quiet_runtime();
    static JSValue holder;
    holder = js_cell(&js_alloc_value_array(ctx, 5000)->cell);
    js_add_root(ctx->rt, &holder);
    js_gc(ctx);
    JSValueArray *a = (JSValueArray *)js_as_cell(holder);
    js_store(ctx, &a->cell, &a->values[10], js_cell(&js_alloc_value_array(ctx, 1)->cell));
    a->values[4000] = js_cell(&js_alloc_value_array(ctx, 1)->cell);  /* barrier: none, on purpose */
    js_gc_young(ctx);
}

TEST(gc_verify_missing_card) {
    char msg[1024];
    int status = in_child(store_without_card, msg, sizeof msg);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) != 0);
    CHECK(strstr(msg, "but isn't remembered") != NULL);
}

/* A store into a cell the marker has visited that skips the barrier: the final pause stops,
 * naming it. The marker visits `holder` first (pushed last), then has `work` left. */
static void store_without_marking_barrier(void) {
    JSContext *ctx = quiet_runtime();
    static JSValue work, holder;
    JSValueArray *w = js_alloc_value_array(ctx, 100);
    work = js_cell(&w->cell);
    js_add_root(ctx->rt, &work);
    for (uint32_t i = 0; i < 100; i++) js_store(ctx, &w->cell, &w->values[i], js_cell(&js_alloc_value_array(ctx, 1)->cell));
    holder = js_cell(&js_alloc_value_array(ctx, 1)->cell);
    js_add_root(ctx->rt, &holder);
    js_gc(ctx);
    js_gc_start_marking(ctx);
    js_gc_mark_slice(ctx, 1);
    ((JSValueArray *)js_as_cell(holder))->values[0] = js_cell(&js_alloc_value_array(ctx, 1)->cell);  /* barrier: none, on purpose */
    while (js_gc_marking(ctx->rt)) js_gc_mark_slice(ctx, 1 << 20);  /* to the final pause (js_gc would start over) */
}

TEST(gc_verify_missing_marking_barrier) {
    char msg[1024];
    int status = in_child(store_without_marking_barrier, msg, sizeof msg);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) != 0);
    CHECK(strstr(msg, "GC verify: marked ValueArray") != NULL);
    CHECK(strstr(msg, "points to unmarked ValueArray") != NULL);
}

TEST(gc_verify_write_after_death) {
    char msg[1024];
    int status = in_child(write_after_death, msg, sizeof msg);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) != 0);
    CHECK(strstr(msg, "GC verify: a dead cell (2560 bytes") != NULL);
    CHECK(strstr(msg, "was written at offset 24 after it died") != NULL);
}
#else
TEST(gc_verify_dangling_pointer) {}
TEST(gc_verify_missing_barrier) {}
TEST(gc_verify_missing_card) {}
TEST(gc_verify_write_after_death) {}
TEST(gc_verify_missing_marking_barrier) {}
#endif
#else
TEST(gc_heap_limit_exits) {}
TEST(gc_verify_dangling_pointer) {}
TEST(gc_verify_missing_barrier) {}
TEST(gc_verify_missing_card) {}
TEST(gc_verify_write_after_death) {}
TEST(gc_verify_missing_marking_barrier) {}
#endif
