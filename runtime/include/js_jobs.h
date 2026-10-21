/*
 * js_jobs.h — the job queue and the event loop.
 *
 * Layer 1 (spec): microtasks, run at checkpoints when no JS is on the stack, then the
 * unhandled rejections are processed. Layer 2 (host): the event loop that runs the
 * main script, then runs timers, one per iteration with a checkpoint after each, until
 * nothing is pending.
 */
#ifndef JS_JOBS_H
#define JS_JOBS_H

#include "jsvalue.h"

typedef struct JSContext JSContext;
typedef struct JSRuntime JSRuntime;

enum {
    JS_JOB_PROMISE_REACTION,  /* a: reaction record, b: argument, c: int32 settled state */
    JS_JOB_RESOLVE_THENABLE,  /* a: promise to resolve, b: thenable, c: its then */
    JS_JOB_CALLBACK,          /* a: function (queueMicrotask), b: an array of its arguments, or undefined */
};

/* Every queued job's values are precise GC roots. */
typedef struct JSJob {
    uint8_t    kind;
    JSContext *realm;    /* set by js_enqueue_microtask: the realm that queued it */
    JSValue    a, b, c;
    JSValue    context;  /* set by js_enqueue_microtask: the async context it runs under */
} JSJob;

typedef struct JSJobQueue {
    JSJob *items;      /* a ring buffer (malloc'd) */
    size_t head, count, cap;
} JSJobQueue;

/* A setTimeout / setInterval. Its values are GC roots. */
typedef struct JSTimer {
    uint64_t   deadline;   /* in the loop's milliseconds */
    uint64_t   seq;        /* creation order: breaks ties */
    uint32_t   id;         /* what setTimeout returned: a positive integer */
    uint32_t   repeat;     /* setInterval: its delay in ms; 0 for setTimeout */
    uint8_t    unref;      /* doesn't keep the program alive (AbortSignal.timeout's) */
    JSContext *realm;
    JSValue    fn;
    JSValue    args;       /* an array of the extra arguments, or undefined */
    JSValue    context;    /* the async context it was set in, which it runs under */
} JSTimer;

typedef struct JSTimers {
    JSTimer *heap;         /* a min-heap on (deadline, seq) (malloc'd) */
    size_t   count, cap;
    uint64_t now;          /* the loop's clock, cached like libuv's: refreshed only when nothing is due */
    uint64_t seq;
    uint32_t next_id;
    size_t   refed;        /* timers that keep the program alive: those not unref'd */
    uint32_t running;      /* the interval whose callback is running, or 0 */
    uint8_t  running_cleared;
} JSTimers;

/* What a checkpoint does with promises still rejected and unhandled at its end. */
typedef enum JSRejectionMode {
    JS_REJECTIONS_STRICT,  /* the default: print "Uncaught (in promise) …", stop, exit status 1 */
    JS_REJECTIONS_WARN,    /* print the same, keep running */
    JS_REJECTIONS_NONE,    /* ignore them */
} JSRejectionMode;

void js_enqueue_microtask(JSContext *ctx, const JSJob *job);
/* process.nextTick's queue, which a checkpoint runs before the microtasks (Node's order) */
void js_enqueue_tick(JSContext *ctx, const JSJob *job);
/* The checkpoint: runs every queued job (and the ones they queue), then processes
 * unhandled rejections. A nested call does nothing. 0, or -1 after an uncaught error
 * or a strict unhandled rejection (already reported). */
int js_run_microtasks(JSContext *ctx);
void js_set_rejection_mode(JSRuntime *rt, JSRejectionMode mode);

/* HostPromiseRejectionTracker (§27.2.1.9): `rejected` true for "reject" (a promise was
 * rejected with no handler), false for "handle" (a handler was added later). */
void js_track_rejection(JSContext *ctx, JSValue promise, bool rejected);

/* A one-shot timer from C: fn() after `delay` ms (clamped as setTimeout clamps it). An unref'd
 * one doesn't keep the program alive, as Node's timer.unref(). Its id (clearTimeout's). */
uint32_t js_add_timer(JSContext *ctx, JSValue fn, double delay, bool unref);
/* The timers node:timers builds its Timeout and Immediate objects on: fn() once, after `delay` ms
 * or, `immediate`, at the loop's time (setImmediate's). A nonzero `id` restarts that timer, pending
 * or not, under the same id (Timeout's refresh()); 0 gives a new one. Its id. */
uint32_t js_timer_start(JSContext *ctx, JSValue fn, double delay, bool immediate, bool unref, uint32_t id);
/* ref() / unref() on a pending timer: whether it keeps the program alive */
void js_timer_set_ref(JSContext *ctx, uint32_t id, bool ref);
void js_timer_clear(JSContext *ctx, uint32_t id);

/* The async context: the host's value for the current chain of async work, which
 * jobs, timers and promise reactions carry to where they run (undefined: none). Setting it
 * isn't undone by the runtime: the caller restores the one it replaced. */
JSValue js_async_context(JSContext *ctx);
void js_set_async_context(JSContext *ctx, JSValue context);

/* Runs the program after its main script returned `main_result`: reports an uncaught
 * error, else checkpoints until nothing is pending. The process exit status. */
int js_run_event_loop(JSContext *ctx, JSValue main_result);
/* Whether the loop has more to do: a timer not unref'd, or I/O. */
bool js_event_loop_alive(JSContext *ctx);

#endif /* JS_JOBS_H */
