/* The job queue (microtasks, unhandled rejections) and the event loop (timers; without an
 * I/O backend, waiting is sleeping). */
#include "js_jobs.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_console.h"
#include "js_convert.h"
#include "js_function.h"
#include "js_promise.h"
#include "jscontext.h"
#include "os.h"

/* ---- The queue -------------------------------------------------------------------- */

static void enqueue(JSContext *ctx, JSJobQueue *q, const JSJob *job) {
    if (q->count == q->cap) {  /* grow, unwrapping the ring: no allocation of cells, so no GC */
        size_t cap = q->cap ? q->cap * 2 : 64;
        JSJob *items = malloc(cap * sizeof *items);
        if (!items) js_fatal("out of memory queueing a job");
        for (size_t i = 0; i < q->count; i++) items[i] = q->items[(q->head + i) % q->cap];
        free(q->items);
        q->items = items;
        q->head = 0;
        q->cap = cap;
    }
    JSJob *slot = &q->items[(q->head + q->count) % q->cap];
    *slot = *job;
    slot->realm = ctx;
    slot->context = ctx->rt->async_context;
    q->count++;
}

void js_enqueue_microtask(JSContext *ctx, const JSJob *job) {
    enqueue(ctx, &ctx->rt->jobs, job);
}

void js_enqueue_tick(JSContext *ctx, const JSJob *job) {
    enqueue(ctx, &ctx->rt->ticks, job);
}

/* ---- The async context --------------------------------------------------------------- */

JSValue js_async_context(JSContext *ctx) { return ctx->rt->async_context; }

void js_set_async_context(JSContext *ctx, JSValue context) {
    ctx->rt->async_context = context;  /* a root, not a heap cell: no barrier */
}

/* A job runs under the async context it was queued in (a promise reaction's is its then()'s:
 * promise.c), and the one current before is current again after it. */
static int run_job_body(const JSJob *job);

static int run_job(const JSJob *job) {
    JSRuntime *rt = job->realm->rt;
    JSValue saved = rt->async_context;
    rt->async_context = job->context;
    int r = run_job_body(job);
    rt->async_context = saved;
    return r;
}

static int run_job_body(const JSJob *job) {
    JSContext *ctx = job->realm;
    switch (job->kind) {
    case JS_JOB_PROMISE_REACTION: return js_promise_reaction_job(ctx, job->a, job->b, job->c);
    case JS_JOB_RESOLVE_THENABLE: return js_promise_thenable_job(ctx, job->a, job->b, job->c);
    default: {
        uint32_t argc = js_is_array(job->b) ? js_array_length(js_as_object(job->b)) : 0;
        JSValue small[8], *argv = argc <= 8 ? small : malloc(argc * sizeof *argv);
        if (!argv) js_fatal("out of memory running a job");
        for (uint32_t i = 0; i < argc; i++) {
            argv[i] = js_get_elem(ctx, job->b, js_index_key(i));
            if (js_is_exception(argv[i])) {
                if (argv != small) free(argv);
                return -1;
            }
        }
        JSValue r = js_call(ctx, job->a, JS_UNDEFINED, argc, argv);
        if (argv != small) free(argv);
        return js_is_exception(r) ? -1 : 0;
    }
    }
}

/* ---- Unhandled rejections ------------------------------------------------------- */

void js_set_rejection_mode(JSRuntime *rt, JSRejectionMode mode) { rt->rejection_mode = (uint8_t)mode; }

static void push_rejection(struct JSRejections *l, JSValue promise) {
    if (l->count == l->cap) {
        size_t cap = l->cap ? l->cap * 2 : 16;
        JSValue *items = realloc(l->items, cap * sizeof *items);
        if (!items) js_fatal("out of memory tracking a rejection");
        l->items = items;
        l->cap = cap;
    }
    l->items[l->count++] = promise;
}

void js_track_rejection(JSContext *ctx, JSValue promise, bool rejected) {
    JSRuntime *rt = ctx->rt;
    struct JSRejections *l = &rt->rejections;
    if (rt->rejection_mode == JS_REJECTIONS_NONE) return;
    if (rejected) {
        push_rejection(l, promise);
        return;
    }
    if (js_as_promise(promise)->reported) {  /* the host handled it as unhandled: it hears of the handler */
        js_as_promise(promise)->reported = 0;
        if (rt->on_handled_late) push_rejection(&rt->handled_late, promise);
        return;
    }
    for (size_t i = 0; i < l->count; i++) {  /* handled before the checkpoint ended: not reported */
        if (js_same_bits(l->items[i], promise)) {
            memmove(&l->items[i], &l->items[i + 1], (l->count - i - 1) * sizeof *l->items);
            l->count--;
            return;
        }
    }
}

/* Reports what is still unhandled, unless the host handles it. Strict: the first one not
 * handled ends the program (like Node). */
static int process_rejections(JSContext *ctx) {
    JSRuntime *rt = ctx->rt;
    struct JSRejections *l = &rt->rejections, *late = &rt->handled_late;
    while (late->count) {
        JSValue promise = late->items[0];  /* on the C stack: the conservative scan keeps it alive */
        memmove(&late->items[0], &late->items[1], (late->count - 1) * sizeof *late->items);
        late->count--;
        if (rt->on_handled_late(ctx, promise) < 0 && js_report_uncaught(ctx)) return -1;
    }
    while (l->count) {
        JSValue promise = l->items[0];
        memmove(&l->items[0], &l->items[1], (l->count - 1) * sizeof *l->items);
        l->count--;
        int status = js_report_rejection(ctx, promise, js_as_promise(promise)->result);
        if (status == 0) js_as_promise(promise)->reported = 1;
        if (status && rt->rejection_mode == JS_REJECTIONS_STRICT) {
            l->count = 0;
            return -1;
        }
    }
    return 0;
}

/* ---- The checkpoint -------------------------------------------------------------- */

/* Runs every job in `q`, the ones queued meanwhile too: 0, or -1 after an uncaught error (reported) */
static int drain(JSJobQueue *q) {
    while (q->count) {
        JSJob job = q->items[q->head];  /* on the C stack: the conservative scan keeps it alive */
        q->head = (q->head + 1) % q->cap;
        q->count--;
        if (run_job(&job) < 0 && js_report_uncaught(job.realm)) return -1;  /* handled: the next job runs */
    }
    return 0;
}

/* Node's processTicksAndRejections: the ticks, then the microtasks (a tick a microtask queues
 * waits for them all), again while there are ticks; the rejections only then, so a handler a
 * tick adds is in time */
int js_run_microtasks(JSContext *ctx) {
    JSRuntime *rt = ctx->rt;
    if (rt->in_checkpoint) return 0;
    rt->in_checkpoint = 1;
    int status = 0;
    do {
        status = drain(&rt->ticks);
        if (status == 0) status = drain(&rt->jobs);
        js_clear_kept_objects(rt);  /* the end of the job: WeakRef targets may go now */
        if (status == 0 && rt->ticks.count == 0) status = process_rejections(ctx);
    } while (status == 0 && (rt->ticks.count || rt->jobs.count || rt->handled_late.count));
    rt->in_checkpoint = 0;
    return status;
}

/* ---- GC and teardown (gc.c) ----------------------------------------------------- */

void js_jobs_trace(JSRuntime *rt, JSTracer *trc) {
    for (JSJobQueue *q = &rt->jobs; q; q = q == &rt->jobs ? &rt->ticks : NULL) {
        for (size_t i = 0; i < q->count; i++) {
            JSJob *j = &q->items[(q->head + i) % q->cap];
            js_trace_value(trc, j->a);
            js_trace_value(trc, j->b);
            js_trace_value(trc, j->c);
            js_trace_value(trc, j->context);
        }
    }
    for (size_t i = 0; i < rt->rejections.count; i++) js_trace_value(trc, rt->rejections.items[i]);
    for (size_t i = 0; i < rt->handled_late.count; i++) js_trace_value(trc, rt->handled_late.items[i]);
    for (size_t i = 0; i < rt->timers.count; i++) {
        js_trace_value(trc, rt->timers.heap[i].fn);
        js_trace_value(trc, rt->timers.heap[i].args);
        js_trace_value(trc, rt->timers.heap[i].context);
    }
}

void js_jobs_free(JSRuntime *rt) {
    free(rt->jobs.items);
    free(rt->ticks.items);
    free(rt->rejections.items);
    free(rt->handled_late.items);
    free(rt->timers.heap);
}

/* ---- Timers: a min-heap on (deadline, creation order) ------------------------------ */

static bool before(const JSTimer *a, const JSTimer *b) {
    return a->deadline < b->deadline || (a->deadline == b->deadline && a->seq < b->seq);
}

static void swap(JSTimer *a, JSTimer *b) {
    JSTimer x = *a;
    *a = *b;
    *b = x;
}

static void sift_up(JSTimers *t, size_t i) {
    for (; i > 0 && before(&t->heap[i], &t->heap[(i - 1) / 2]); i = (i - 1) / 2) swap(&t->heap[i], &t->heap[(i - 1) / 2]);
}

static void sift_down(JSTimers *t, size_t i) {
    for (;;) {
        size_t l = 2 * i + 1, r = l + 1, m = i;
        if (l < t->count && before(&t->heap[l], &t->heap[m])) m = l;
        if (r < t->count && before(&t->heap[r], &t->heap[m])) m = r;
        if (m == i) return;
        swap(&t->heap[i], &t->heap[m]);
        i = m;
    }
}

static void timer_push(JSTimers *t, const JSTimer *timer) {
    if (t->count == t->cap) {
        size_t cap = t->cap ? t->cap * 2 : 16;
        JSTimer *heap = realloc(t->heap, cap * sizeof *heap);
        if (!heap) js_fatal("out of memory adding a timer");
        t->heap = heap;
        t->cap = cap;
    }
    t->heap[t->count++] = *timer;
    if (!timer->unref) t->refed++;
    sift_up(t, t->count - 1);
}

static void timer_remove(JSTimers *t, size_t i) {
    if (!t->heap[i].unref) t->refed--;
    t->heap[i] = t->heap[--t->count];
    if (i < t->count) {
        sift_down(t, i);
        sift_up(t, i);
    }
}

#define TIMEOUT_MAX 2147483647.0  /* Node's: longer delays, like shorter than 1 ms, become 1 */

/* setTimeout(fn, delay, ...args) / setInterval: the delay as Node takes it. */
static JSValue add_timer(JSContext *ctx, uint32_t argc, const JSValue *argv, bool repeat) {
    JSValue fn = argc ? argv[0] : JS_UNDEFINED;
    if (!js_is_callable(fn)) return js_throw_type_error(ctx, "The \"callback\" argument must be of type function");
    double delay = 1;
    if (argc > 1 && js_to_number(ctx, &delay, argv[1]) < 0) return JS_EXCEPTION;
    if (!(delay >= 1 && delay <= TIMEOUT_MAX)) delay = 1;
    JSValue args = argc > 2 ? js_new_array_from(ctx, argv + 2, argc - 2) : JS_UNDEFINED;
    JSTimers *t = &ctx->rt->timers;
    if (++t->next_id > 2147483647u) t->next_id = 1;
    JSTimer timer = { t->now + (uint64_t)delay, t->seq++, t->next_id, repeat ? (uint32_t)delay : 0, 0, ctx, fn, args, ctx->rt->async_context };
    timer_push(t, &timer);
    return js_int32((int32_t)timer.id);
}

uint32_t js_add_timer(JSContext *ctx, JSValue fn, double delay, bool unref) {
    return js_timer_start(ctx, fn, delay, false, unref, 0);
}

static size_t timer_find(const JSTimers *t, uint32_t id) {
    for (size_t i = 0; i < t->count; i++)
        if (t->heap[i].id == id) return i;
    return SIZE_MAX;
}

uint32_t js_timer_start(JSContext *ctx, JSValue fn, double delay, bool immediate, bool unref, uint32_t id) {
    if (!(delay >= 1 && delay <= TIMEOUT_MAX)) delay = 1;
    JSTimers *t = &ctx->rt->timers;
    if (!t->now) t->now = js_os_now_ms();
    if (id) {  /* restarted: it replaces the pending one with its id */
        size_t i = timer_find(t, id);
        if (i != SIZE_MAX) timer_remove(t, i);
    } else {
        if (++t->next_id > 2147483647u) t->next_id = 1;
        id = t->next_id;
    }
    JSTimer timer = { immediate ? t->now : t->now + (uint64_t)delay, t->seq++, id, 0, unref, ctx, fn, JS_UNDEFINED, ctx->rt->async_context };
    timer_push(t, &timer);
    return id;
}

void js_timer_set_ref(JSContext *ctx, uint32_t id, bool ref) {
    JSTimers *t = &ctx->rt->timers;
    size_t i = timer_find(t, id);
    if (i == SIZE_MAX || t->heap[i].unref == !ref) return;
    t->heap[i].unref = !ref;
    if (ref) t->refed++;
    else t->refed--;
}

void js_timer_clear(JSContext *ctx, uint32_t id) {
    JSTimers *t = &ctx->rt->timers;
    if (t->running && id == t->running) t->running_cleared = 1;
    size_t i = timer_find(t, id);
    if (i != SIZE_MAX) timer_remove(t, i);
}

/* clearTimeout / clearInterval (either clears both kinds, as in Node). */
static void clear_timer(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    if (!argc || !js_is_number(argv[0])) return;
    double d = js_as_number(argv[0]);
    if (d >= 1 && d <= 2147483647.0 && d == (double)(uint32_t)d) js_timer_clear(ctx, (uint32_t)d);
}

#define HOST_FN(fn) static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target)

HOST_FN(set_timeout) {
    (void)callee, (void)this_val, (void)new_target;
    return add_timer(ctx, argc, argv, false);
}
HOST_FN(set_interval) {
    (void)callee, (void)this_val, (void)new_target;
    return add_timer(ctx, argc, argv, true);
}
/* setImmediate(fn, ...args): a timer due at the loop's time, so it runs before any later deadline */
HOST_FN(set_immediate) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue fn = argc ? argv[0] : JS_UNDEFINED;
    if (!js_is_callable(fn)) return js_throw_type_error(ctx, "The \"callback\" argument must be of type function");
    JSValue args = argc > 1 ? js_new_array_from(ctx, argv + 1, argc - 1) : JS_UNDEFINED;
    JSTimers *t = &ctx->rt->timers;
    if (++t->next_id > 2147483647u) t->next_id = 1;
    JSTimer timer = { t->now, t->seq++, t->next_id, 0, 0, ctx, fn, args, ctx->rt->async_context };
    timer_push(t, &timer);
    return js_int32((int32_t)timer.id);
}
HOST_FN(clear_timeout) {
    (void)callee, (void)this_val, (void)new_target;
    clear_timer(ctx, argc, argv);
    return JS_UNDEFINED;
}

/* ---- The event loop ---------------------------------------------------------------- */

static JSValue queue_microtask(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                               const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue fn = argc ? argv[0] : JS_UNDEFINED;
    if (!js_is_callable(fn)) return js_throw_type_error(ctx, "The \"callback\" argument must be of type function");
    JSJob job = { JS_JOB_CALLBACK, NULL, fn, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    js_enqueue_microtask(ctx, &job);
    return JS_UNDEFINED;
}

void js_jobs_realm_init(JSContext *ctx, JSObject *global) {
    (void)js_define_method(ctx, global, "queueMicrotask", queue_microtask, 1);
    (void)js_define_method(ctx, global, "setTimeout", set_timeout, 2);
    (void)js_define_method(ctx, global, "setInterval", set_interval, 2);
    (void)js_define_method(ctx, global, "clearTimeout", clear_timeout, 1);
    (void)js_define_method(ctx, global, "clearInterval", clear_timeout, 1);
    (void)js_define_method(ctx, global, "setImmediate", set_immediate, 1);
    (void)js_define_method(ctx, global, "clearImmediate", clear_timeout, 1);
    JSTimers *t = &ctx->rt->timers;
    if (!t->now) t->now = js_os_now_ms();  /* the base of every timer the main script sets */
}

bool js_event_loop_alive(JSContext *ctx) {
    JSRuntime *rt = ctx->rt;
    return rt->timers.refed || (rt->io && rt->io->alive(rt));
}

/* One task per iteration, then a full checkpoint: promise callbacks always run before the
 * next timer. The program ends when no timer is pending (unref'd ones don't count) and no I/O is. */
int js_run_event_loop(JSContext *ctx, JSValue main_result) {
    JSRuntime *rt = ctx->rt;
    int status = js_is_exception(main_result) ? js_report_uncaught(ctx) : 0;
    if (status) return status;
    if (js_run_microtasks(ctx) < 0) return rt->failure;
    JSTimers *t = &rt->timers;
    while (js_event_loop_alive(ctx)) {
        /* FinalizationRegistry cleanups run between tasks; on their own they don't keep the program alive */
        if (js_run_finalization_cleanups(ctx) < 0) return rt->failure;
        if (!t->count || t->heap[0].deadline > t->now) {  /* nothing due at the cached time: refresh it, or wait */
            t->now = js_os_now_ms();
            if (!t->count || t->heap[0].deadline > t->now) {
                int64_t timeout = t->count ? (int64_t)(t->heap[0].deadline - t->now) : -1;
                /* a long wait with garbage to collect: JS_GC_IDLE_MS of it first, and when nothing
                 * happened in them, the collector gives memory back */
                bool idle_gc = (timeout < 0 || timeout > JS_GC_IDLE_MS) && js_gc_idle_wanted(rt);
                if (idle_gc) timeout = JS_GC_IDLE_MS;
                uint64_t waited = t->now;
                /* the output so far appears before the wait, as Node's does (a server's log, say) */
                fflush(stdout);
                fflush(stderr);
                /* I/O callbacks run while waiting, unref'd handles' too while a timer is pending */
                if (rt->io && (timeout >= 0 || rt->io->alive(rt))) {
                    status = rt->io->run(ctx, timeout);
                    if (status) return status;
                } else {
                    js_os_sleep_ms((uint64_t)timeout);  /* t->refed: a timer is pending */
                }
                t->now = js_os_now_ms();
                if (idle_gc && t->now - waited >= JS_GC_IDLE_MS) js_gc_idle(ctx);
            }
            continue;
        }
        JSTimer timer = t->heap[0];  /* on the C stack: the conservative scan keeps it alive */
        timer_remove(t, 0);
        t->running = timer.repeat ? timer.id : 0;
        t->running_cleared = 0;
        JSValue saved = rt->async_context;
        rt->async_context = timer.context;
        JSValue r = js_is_undefined(timer.args) ? js_call(timer.realm, timer.fn, JS_UNDEFINED, 0, NULL)
                                                : js_call_spread(timer.realm, timer.fn, JS_UNDEFINED, timer.args, NULL);
        rt->async_context = saved;
        t->running = 0;
        if (js_is_exception(r) && (status = js_report_uncaught(timer.realm))) return status;
        if (timer.repeat && !t->running_cleared) {  /* re-armed after its callback, from the loop's time */
            timer.deadline = t->now + timer.repeat;
            timer.seq = t->seq++;
            timer_push(t, &timer);
        }
        if (js_run_microtasks(ctx) < 0) return rt->failure;
    }
    return 0;
}
