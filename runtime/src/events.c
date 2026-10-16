/* Event, EventTarget, AbortController and AbortSignal (DOM §2, §3.1), the events component,
 * as Node has them: a target has no tree, so dispatch runs the target's
 * own listeners for the type, in the order added, walking the list as Node walks its linked
 * list (a listener removed meanwhile doesn't run). A listener's exception doesn't stop
 * the dispatch: it is rethrown from a microtask, as Node rethrows it from process.nextTick,
 * and ends the program as uncaught. AbortSignal.timeout's timer doesn't keep the program alive. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_jobs.h"
#include "js_ops.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"
#include "os.h"

/* ---- The objects ---------------------------------------------------------------------------- */

enum {
    EV_BUBBLES = 0x01, EV_CANCELABLE = 0x02, EV_COMPOSED = 0x04, EV_CANCELED = 0x08,
    EV_STOP = 0x10, EV_STOP_IMMEDIATE = 0x20, EV_DISPATCHING = 0x40, EV_IN_PASSIVE = 0x80,
};

typedef struct EventObject {
    JSObject obj;
    JSValue  type;    /* a string */
    JSValue  target;  /* null until dispatched */
    double   time_stamp;
    uint8_t  flags;   /* EV_* */
    uint8_t  trusted;
} EventObject;

enum { L_CAPTURE = 0x01, L_ONCE = 0x02, L_PASSIVE = 0x04, L_REMOVED = 0x08, L_HANDLER = 0x10 };

typedef struct ListenerObject {  /* internal: never reaches JS */
    JSObject obj;
    JSValue  type;
    JSValue  callback;  /* a function, or an object with handleEvent */
    uint64_t seq;       /* the order added */
    uint8_t  flags;     /* L_* */
} ListenerObject;

typedef struct EventTargetObject {
    JSObject obj;
    JSValue *listeners;  /* ListenerObjects, in the order added (malloc'd) */
    uint32_t n, cap;
    uint64_t seq;
} EventTargetObject;

typedef struct AbortSignalObject {
    EventTargetObject target;
    JSValue reason;      /* undefined until aborted */
    JSValue handler;     /* onabort: null, or what was set */
    JSValue dependents;  /* AbortSignal.any's signals that follow this one: an array, or undefined */
    bool    aborted;
} AbortSignalObject;

typedef struct AbortControllerObject {
    JSObject obj;
    JSValue  signal;
} AbortControllerObject;

static void event_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((EventObject *)c)->type);
    js_trace_value(trc, ((EventObject *)c)->target);
}
static void listener_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((ListenerObject *)c)->type);
    js_trace_value(trc, ((ListenerObject *)c)->callback);
}
static void target_visit(JSCell *c, JSTracer *trc) {
    EventTargetObject *t = (EventTargetObject *)c;
    for (uint32_t i = 0; i < t->n; i++) js_trace_value(trc, t->listeners[i]);
}
static void target_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    free(((EventTargetObject *)c)->listeners);
}
static void signal_visit(JSCell *c, JSTracer *trc) {
    target_visit(c, trc);
    AbortSignalObject *s = (AbortSignalObject *)c;
    js_trace_value(trc, s->reason);
    js_trace_value(trc, s->handler);
    js_trace_value(trc, s->dependents);
}
static void controller_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((AbortControllerObject *)c)->signal); }

static const JSClass event_class = { "Event", sizeof(EventObject), NULL, NULL, NULL, NULL, event_visit, NULL, NULL };
static const JSClass listener_class = { "EventListener", sizeof(ListenerObject), NULL, NULL, NULL, NULL, listener_visit, NULL, NULL };
static const JSClass target_class = { "EventTarget", sizeof(EventTargetObject), NULL, NULL, NULL, NULL, target_visit, target_finalize, NULL };
static const JSClass signal_class = { "AbortSignal", sizeof(AbortSignalObject), NULL, NULL, NULL, NULL, signal_visit, target_finalize, NULL };
static const JSClass controller_class = { "AbortController", sizeof(AbortControllerObject), NULL, NULL, NULL, NULL, controller_visit, NULL, NULL };

static EventObject *as_event(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &event_class ? (EventObject *)js_as_object(v) : NULL;
}
static EventTargetObject *as_target(JSValue v) {
    if (!js_is_object(v)) return NULL;
    const JSClass *c = js_as_object(v)->shape->cls;
    return c == &target_class || c == &signal_class ? (EventTargetObject *)js_as_object(v) : NULL;
}
static AbortSignalObject *as_signal(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &signal_class ? (AbortSignalObject *)js_as_object(v) : NULL;
}
static AbortControllerObject *as_controller(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &controller_class ? (AbortControllerObject *)js_as_object(v) : NULL;
}

#define THIS(type, var, as, name)  \
    type *var = as(this_val);       \
    if (!var) return js_throw_invalid_this(ctx, name)

static double time_origin;  /* performance.timeOrigin's clock reading: when the component was installed */

/* ---- Event ---------------------------------------------------------------------------------- */

static JSValue new_event(JSContext *ctx, JSValue proto, JSValue type, uint8_t flags) {
    EventObject *e = (EventObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &event_class, proto, 4));
    js_init_slot(&e->type, type);
    js_init_slot(&e->target, JS_NULL);
    e->time_stamp = js_os_now_ms_precise() - time_origin;
    e->flags = flags;
    e->trusted = 0;
    return js_object_value(&e->obj);
}

/* An option of an init dictionary, as a boolean. 0, or -1. */
static int bool_option(JSContext *ctx, JSValue options, const char *name, bool *out) {
    *out = false;
    if (!js_is_object(options)) return 0;
    JSValue v = js_get_value(ctx, options, js_atom_from_cstr(ctx, name));
    if (js_is_exception(v)) return -1;
    *out = js_truthy(v);
    return 0;
}

/* new Event(type, { bubbles, cancelable, composed }) */
BUILTIN(event_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "Event");
    if (argc == 0) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS", "The \"type\" argument must be specified");
    JSValue options = ARG(1);
    if (!js_is_nullish(options) && !js_is_object(options))
        return js_throw_invalid_arg_type(ctx, "options", "of type object", options);
    JSValue type = js_to_string(ctx, ARG(0));
    if (js_is_exception(type)) return type;
    bool bubbles, cancelable, composed;
    if (bool_option(ctx, options, "bubbles", &bubbles) < 0 || bool_option(ctx, options, "cancelable", &cancelable) < 0 ||
        bool_option(ctx, options, "composed", &composed) < 0)
        return JS_EXCEPTION;
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_EVENT_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    return new_event(ctx, proto, type, (bubbles ? EV_BUBBLES : 0) | (cancelable ? EV_CANCELABLE : 0) | (composed ? EV_COMPOSED : 0));
}

#define THIS_EVENT() THIS(EventObject, e, as_event, "Event")

BUILTIN(event_type) {
    UNUSED_ARGS;
    THIS_EVENT();
    return e->type;
}

BUILTIN(event_target) {
    UNUSED_ARGS;
    THIS_EVENT();
    return e->target;
}

BUILTIN(event_current_target) {
    UNUSED_ARGS;
    THIS_EVENT();
    return e->flags & EV_DISPATCHING ? e->target : JS_NULL;
}

BUILTIN(event_composed_path) {
    UNUSED_ARGS;
    THIS_EVENT();
    return e->flags & EV_DISPATCHING ? js_new_array_from(ctx, &e->target, 1) : js_new_array(ctx, 0);
}

BUILTIN(event_event_phase) {
    UNUSED_ARGS;
    THIS_EVENT();
    return js_int32(e->flags & EV_DISPATCHING ? 2 : 0);
}

#define FLAG_GETTER(fn, expr)  \
    BUILTIN(fn) {              \
        UNUSED_ARGS;           \
        THIS_EVENT();          \
        return js_bool(expr);  \
    }
FLAG_GETTER(event_bubbles, e->flags & EV_BUBBLES)
FLAG_GETTER(event_cancelable, e->flags & EV_CANCELABLE)
FLAG_GETTER(event_composed, e->flags & EV_COMPOSED)
FLAG_GETTER(event_default_prevented, (e->flags & (EV_CANCELABLE | EV_CANCELED)) == (EV_CANCELABLE | EV_CANCELED))
FLAG_GETTER(event_return_value, (e->flags & (EV_CANCELABLE | EV_CANCELED)) != (EV_CANCELABLE | EV_CANCELED))
FLAG_GETTER(event_cancel_bubble, e->flags & EV_STOP)
FLAG_GETTER(event_is_trusted, e->trusted)

BUILTIN(event_time_stamp) {
    UNUSED_ARGS;
    THIS_EVENT();
    return js_number(e->time_stamp);
}

BUILTIN(event_prevent_default) {
    UNUSED_ARGS;
    THIS_EVENT();
    if (!(e->flags & EV_IN_PASSIVE)) e->flags |= EV_CANCELED;
    return JS_UNDEFINED;
}

BUILTIN(event_stop_propagation) {
    UNUSED_ARGS;
    THIS_EVENT();
    e->flags |= EV_STOP;
    return JS_UNDEFINED;
}

BUILTIN(event_set_cancel_bubble) {
    UNUSED_ARGS;
    THIS_EVENT();
    if (js_truthy(ARG(0))) e->flags |= EV_STOP;
    return JS_UNDEFINED;
}

BUILTIN(event_stop_immediate_propagation) {
    UNUSED_ARGS;
    THIS_EVENT();
    e->flags |= EV_STOP | EV_STOP_IMMEDIATE;
    return JS_UNDEFINED;
}

/* initEvent(type, bubbles = false, cancelable = false): only before dispatch */
BUILTIN(event_init_event) {
    UNUSED_ARGS;
    THIS_EVENT();
    if (argc == 0) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS", "The \"type\" argument must be specified");
    if (e->flags & EV_DISPATCHING) return JS_UNDEFINED;
    JSValue type = js_to_string(ctx, ARG(0));
    if (js_is_exception(type)) return type;
    js_store(ctx, &e->obj.cell, &e->type, type);
    e->flags = (uint8_t)((e->flags & ~(EV_BUBBLES | EV_CANCELABLE)) | (js_truthy(ARG(1)) ? EV_BUBBLES : 0) |
                         (js_truthy(ARG(2)) ? EV_CANCELABLE : 0));
    return JS_UNDEFINED;
}

/* `Event { type: 'x', defaultPrevented: false, cancelable: false, timeStamp: 28.6 }` */
BUILTIN(event_inspect) {
    UNUSED_ARGS;
    THIS_EVENT();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "type"), e->type, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "defaultPrevented"),
                   js_bool((e->flags & (EV_CANCELABLE | EV_CANCELED)) == (EV_CANCELABLE | EV_CANCELED)), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "cancelable"), js_bool(e->flags & EV_CANCELABLE), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "timeStamp"), js_number(e->time_stamp), JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "Event", o, ARG(0), ARG(1));
}

/* ---- EventTarget ---------------------------------------------------------------------------- */

static void init_target(EventTargetObject *t) {
    t->listeners = NULL;
    t->n = t->cap = 0;
    t->seq = 0;
}

BUILTIN(target_ctor) {
    (void)callee, (void)this_val, (void)argc, (void)argv;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "EventTarget");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_EVENT_TARGET_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    EventTargetObject *t = (EventTargetObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &target_class, proto, 4));
    init_target(t);
    return js_object_value(&t->obj);
}

static ListenerObject *listener_at(EventTargetObject *t, uint32_t i) { return (ListenerObject *)js_as_object(t->listeners[i]); }

static void remove_at(EventTargetObject *t, uint32_t i) {
    listener_at(t, i)->flags |= L_REMOVED;
    memmove(t->listeners + i, t->listeners + i + 1, (t->n - i - 1) * sizeof *t->listeners);
    t->n--;
}

/* The listener for (type, callback, capture), or -1. */
static int64_t find_listener(JSContext *ctx, EventTargetObject *t, JSValue type, JSValue callback, bool capture) {
    for (uint32_t i = 0; i < t->n; i++) {
        ListenerObject *l = listener_at(t, i);
        if (!(l->flags & L_HANDLER) && js_strict_equals(ctx, l->callback, callback) && !(l->flags & L_CAPTURE) == !capture &&
            js_string_equals(ctx, l->type, type))
            return i;
    }
    return -1;
}

static JSValue add_listener(JSContext *ctx, EventTargetObject *t, JSValue type, JSValue callback, uint8_t flags) {
    ListenerObject *l = (ListenerObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &listener_class, JS_NULL, 0));
    js_init_slot(&l->type, type);
    js_init_slot(&l->callback, callback);
    l->flags = flags;
    l->seq = ++t->seq;
    if (t->n == t->cap) {
        uint32_t cap = t->cap ? t->cap * 2 : 4;
        JSValue *list = realloc(t->listeners, cap * sizeof *list);
        if (!list) return js_throw_range_error(ctx, "Out of memory");
        t->listeners = list;
        t->cap = cap;
    }
    js_store(ctx, &t->obj.cell, &t->listeners[t->n++], js_object_value(&l->obj));
    return js_object_value(&l->obj);
}

/* options.signal's abort removes the listener: the closure's data is [target, listener]. */
BUILTIN(remove_on_abort) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue data = js_closure_data(callee);
    JSValue tv = js_get_elem(ctx, data, js_int32(0)), lv = js_get_elem(ctx, data, js_int32(1));
    if (js_is_exception(tv) || js_is_exception(lv)) return JS_EXCEPTION;
    EventTargetObject *t = (EventTargetObject *)js_as_object(tv);
    for (uint32_t i = 0; i < t->n; i++) {
        if (t->listeners[i].bits == lv.bits) {
            remove_at(t, i);
            break;
        }
    }
    return JS_UNDEFINED;
}

JSValue js_event_target_listeners(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    EventTargetObject *t = argc > 0 ? as_target(argv[0]) : NULL;
    if (!t) return JS_UNDEFINED;
    JSValue type = js_to_string(ctx, argc > 1 ? argv[1] : JS_UNDEFINED);
    if (js_is_exception(type)) return type;
    /* the callbacks first, then the array: its one allocation can't move what the loop reads */
    JSValue *callbacks = malloc((t->n ? t->n : 1) * sizeof *callbacks);
    if (!callbacks) js_fatal("out of memory in events");
    uint32_t n = 0;
    for (uint32_t i = 0; i < t->n; i++) {
        ListenerObject *l = listener_at(t, i);
        if (js_string_equals(ctx, l->type, type)) callbacks[n++] = l->callback;
    }
    JSValue list = js_new_array_from(ctx, callbacks, n);
    free(callbacks);
    return list;
}

/* addEventListener(type, listener, options | capture) */
BUILTIN(target_add_event_listener) {
    UNUSED_ARGS;
    THIS(EventTargetObject, t, as_target, "EventTarget");
    if (argc < 2)
        return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS", "The \"type\" and \"listener\" arguments must be specified");
    JSValue callback = argv[1], options = ARG(2);
    uint8_t flags = 0;
    JSValue signal = JS_UNDEFINED;
    if (js_is_bool(options)) {
        if (js_truthy(options)) flags |= L_CAPTURE;
    } else if (js_is_object(options)) {
        bool once, capture, passive;
        if (bool_option(ctx, options, "once", &once) < 0 || bool_option(ctx, options, "capture", &capture) < 0 ||
            bool_option(ctx, options, "passive", &passive) < 0)
            return JS_EXCEPTION;
        flags = (uint8_t)((once ? L_ONCE : 0) | (capture ? L_CAPTURE : 0) | (passive ? L_PASSIVE : 0));
        signal = js_get_value(ctx, options, js_atom_from_cstr(ctx, "signal"));
        if (js_is_exception(signal)) return signal;
        if (!js_is_undefined(signal) && !as_signal(signal)) {
            char received[256];
            js_node_received(ctx, signal, received, sizeof received);
            return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
                                       "The \"options.signal\" property must be an instance of AbortSignal.%s", received);
        }
    } else if (!js_is_nullish(options)) {
        return js_throw_invalid_arg_type(ctx, "options", "of type object", options);
    }
    if (js_is_nullish(callback)) return JS_UNDEFINED;  /* Node warns and ignores it */
    if (!js_is_object(callback)) return js_throw_invalid_arg_type(ctx, "listener", "an instance of EventListener", callback);
    JSValue type = js_to_string(ctx, argv[0]);
    if (js_is_exception(type)) return type;
    AbortSignalObject *s = as_signal(signal);
    if (s && s->aborted) return JS_UNDEFINED;
    if (find_listener(ctx, t, type, callback, flags & L_CAPTURE) >= 0) return JS_UNDEFINED;
    JSValue l = add_listener(ctx, t, type, callback, flags);
    if (js_is_exception(l)) return l;
    if (s) {
        JSValue pair[2] = { this_val, l };
        JSValue data = js_new_array_from(ctx, pair, 2);
        JSValue remover = js_new_closure_native(ctx, remove_on_abort, 0, data);
        JSValue abort = js_new_string_cstr(ctx, "abort");
        if (js_is_exception(abort) || js_is_exception(add_listener(ctx, &s->target, abort, remover, L_ONCE))) return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

/* removeEventListener(type, listener, options | capture) */
BUILTIN(target_remove_event_listener) {
    UNUSED_ARGS;
    THIS(EventTargetObject, t, as_target, "EventTarget");
    if (argc < 2)
        return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS", "The \"type\" and \"listener\" arguments must be specified");
    JSValue options = ARG(2);
    bool capture = false;
    if (js_is_bool(options)) capture = js_truthy(options);
    else if (bool_option(ctx, options, "capture", &capture) < 0) return JS_EXCEPTION;
    if (js_is_nullish(argv[1])) return JS_UNDEFINED;
    JSValue type = js_to_string(ctx, argv[0]);
    if (js_is_exception(type)) return type;
    int64_t i = find_listener(ctx, t, type, argv[1], capture);
    if (i >= 0) remove_at(t, (uint32_t)i);
    return JS_UNDEFINED;
}

/* A listener's exception: rethrown from a microtask, as an uncaught error. */
BUILTIN(rethrow) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    return js_throw(ctx, js_closure_data(callee));
}

static void report_later(JSContext *ctx) {
    JSValue error = js_take_exception(ctx);
    JSJob job = { JS_JOB_CALLBACK, NULL, js_new_closure_native(ctx, rethrow, 0, error), JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    js_enqueue_microtask(ctx, &job);
}

/* The first listener for `type` added after `seq`, or undefined. */
static JSValue first_after(JSContext *ctx, EventTargetObject *t, JSValue type, uint64_t seq) {
    for (uint32_t i = 0; i < t->n; i++) {
        ListenerObject *l = listener_at(t, i);
        if (l->seq > seq && js_string_equals(ctx, l->type, type)) return t->listeners[i];
    }
    return JS_UNDEFINED;
}

/* Dispatches `event` at `target` (an EventTarget object). false when it was canceled; -1 with an exception. */
static int dispatch(JSContext *ctx, JSValue target, JSValue event) {
    EventTargetObject *t = (EventTargetObject *)js_as_object(target);
    EventObject *e = as_event(event);
    if (e->flags & EV_DISPATCHING) {
        char type[128];
        type[js_view_to_utf8(js_string_view(ctx, e->type), type, sizeof type - 1)] = '\0';
        JSValue r = js_throw_node_error(ctx, JS_ERROR, "ERR_EVENT_RECURSION", "The event \"%s\" is already being dispatched", type);
        return (void)r, -1;
    }
    js_store(ctx, &e->obj.cell, &e->target, target);
    e->flags |= EV_DISPATCHING;
    /* Node's walk of its listener list: the next listener is taken before each call, so one
     * added during the call runs unless the current one was the last */
    JSValue lv = first_after(ctx, t, e->type, 0);
    while (!js_is_undefined(lv) && !(e->flags & EV_STOP_IMMEDIATE)) {
        ListenerObject *l = (ListenerObject *)js_as_object(lv);
        JSValue next = first_after(ctx, t, e->type, l->seq);
        if (l->flags & L_ONCE) {
            for (uint32_t i = 0; i < t->n; i++) {
                if (t->listeners[i].bits == lv.bits) {
                    remove_at(t, i);
                    break;
                }
            }
        }
        JSValue callback = l->callback, this_arg = target, fn = callback;
        bool call = true;
        if (!js_is_callable(callback)) {  /* an EventListener object: its handleEvent, looked up now */
            fn = js_get_value(ctx, callback, js_atom_from_cstr(ctx, "handleEvent"));
            if (js_is_exception(fn)) report_later(ctx);
            call = js_is_callable(fn);
            this_arg = callback;
        }
        if (call) {
            if (l->flags & L_PASSIVE) e->flags |= EV_IN_PASSIVE;
            JSValue r = js_call(ctx, fn, this_arg, 1, &event);
            e->flags &= (uint8_t)~EV_IN_PASSIVE;
            if (js_is_exception(r)) report_later(ctx);
        }
        if (!js_is_undefined(next) && (((ListenerObject *)js_as_object(next))->flags & L_REMOVED))
            next = first_after(ctx, t, e->type, ((ListenerObject *)js_as_object(next))->seq);
        lv = next;
    }
    e->flags &= (uint8_t)~(EV_DISPATCHING | EV_STOP_IMMEDIATE);
    return (e->flags & (EV_CANCELABLE | EV_CANCELED)) != (EV_CANCELABLE | EV_CANCELED);
}

BUILTIN(target_dispatch_event) {
    UNUSED_ARGS;
    THIS(EventTargetObject, t, as_target, "EventTarget");
    (void)t;
    if (argc == 0) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS", "The \"event\" argument must be specified");
    if (!as_event(argv[0])) return js_throw_invalid_arg_type(ctx, "event", "an instance of Event", argv[0]);
    int r = dispatch(ctx, this_val, argv[0]);
    return r < 0 ? JS_EXCEPTION : js_bool(r);
}

BUILTIN(target_inspect) {
    UNUSED_ARGS;
    return js_inspect_as(ctx, this_val, "EventTarget", js_new_object(ctx), ARG(0), ARG(1));
}

/* ---- AbortSignal ---------------------------------------------------------------------------- */

static JSValue new_signal(JSContext *ctx) {
    AbortSignalObject *s = (AbortSignalObject *)js_alloc_object(ctx, JS_CELL_OBJECT,
        js_shape_root(ctx, &signal_class, ctx->intrinsics[JS_INTRINSIC_ABORT_SIGNAL_PROTOTYPE], 4));
    init_target(&s->target);
    js_init_slot(&s->reason, JS_UNDEFINED);
    js_init_slot(&s->handler, JS_NULL);
    js_init_slot(&s->dependents, JS_UNDEFINED);
    s->aborted = false;
    return js_object_value(&s->target.obj);
}

/* `reason`, or the default: DOMException AbortError. */
static JSValue reason_or_default(JSContext *ctx, JSValue reason) {
    return js_is_undefined(reason) ? js_new_dom_exception(ctx, "AbortError", "This operation was aborted") : reason;
}

/* Signal abort (DOM §3.2): sets the reason, aborts the dependent signals, fires `abort`. 0, or -1. */
static int signal_abort(JSContext *ctx, JSValue sv, JSValue reason) {
    AbortSignalObject *s = as_signal(sv);
    if (s->aborted) return 0;
    s->aborted = true;
    js_store(ctx, &s->target.obj.cell, &s->reason, reason);
    JSValue deps = s->dependents;
    js_store(ctx, &s->target.obj.cell, &s->dependents, JS_UNDEFINED);
    JSValue type = js_new_string_cstr(ctx, "abort");
    if (js_is_exception(type)) return -1;
    JSValue event = new_event(ctx, ctx->intrinsics[JS_INTRINSIC_EVENT_PROTOTYPE], type, 0);
    as_event(event)->trusted = 1;
    if (dispatch(ctx, sv, event) < 0) return -1;
    if (js_is_array(deps)) {
        for (uint32_t i = 0; i < js_array_length(js_as_object(deps)); i++) {
            JSValue d = js_get_elem(ctx, deps, js_int32((int32_t)i));
            if (js_is_exception(d) || signal_abort(ctx, d, reason) < 0) return -1;
        }
    }
    return 0;
}

BUILTIN(signal_ctor) {
    UNUSED_ARGS;
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
}

#define THIS_SIGNAL() THIS(AbortSignalObject, s, as_signal, "AbortSignal")

BUILTIN(signal_aborted) {
    UNUSED_ARGS;
    THIS_SIGNAL();
    return js_bool(s->aborted);
}

BUILTIN(signal_reason) {
    UNUSED_ARGS;
    THIS_SIGNAL();
    return s->reason;
}

BUILTIN(signal_throw_if_aborted) {
    UNUSED_ARGS;
    THIS_SIGNAL();
    return s->aborted ? js_throw(ctx, s->reason) : JS_UNDEFINED;
}

BUILTIN(signal_onabort) {
    UNUSED_ARGS;
    THIS_SIGNAL();
    return s->handler;
}

/* onabort = fn: an event handler (HTML §8.1.8.1). Its listener keeps its place among the others;
 * setting a non-function removes it. */
BUILTIN(signal_set_onabort) {
    UNUSED_ARGS;
    THIS_SIGNAL();
    JSValue v = js_is_object(ARG(0)) ? ARG(0) : JS_NULL;
    js_store(ctx, &s->target.obj.cell, &s->handler, v);
    for (uint32_t i = 0; i < s->target.n; i++) {
        ListenerObject *l = listener_at(&s->target, i);
        if (l->flags & L_HANDLER) {
            if (js_is_callable(v)) js_store(ctx, &l->obj.cell, &l->callback, v);
            else remove_at(&s->target, i);
            return JS_UNDEFINED;
        }
    }
    if (js_is_callable(v)) {
        JSValue type = js_new_string_cstr(ctx, "abort");
        if (js_is_exception(type) || js_is_exception(add_listener(ctx, &s->target, type, v, L_HANDLER))) return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

/* AbortSignal.abort(reason) */
BUILTIN(signal_abort_static) {
    UNUSED_ARGS;
    JSValue reason = reason_or_default(ctx, ARG(0));
    if (js_is_exception(reason)) return reason;
    JSValue s = new_signal(ctx);
    as_signal(s)->aborted = true;
    js_store(ctx, &js_as_object(s)->cell, &as_signal(s)->reason, reason);
    return s;
}

BUILTIN(timeout_fired) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue reason = js_new_dom_exception(ctx, "TimeoutError", "The operation was aborted due to timeout");
    if (js_is_exception(reason)) return reason;
    return signal_abort(ctx, js_closure_data(callee), reason) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

/* AbortSignal.timeout(delay) */
BUILTIN(signal_timeout) {
    UNUSED_ARGS;
    JSValue d = ARG(0);
    if (!js_is_number(d)) return js_throw_invalid_arg_type(ctx, "delay", "of type number", d);
    double delay = js_as_number(d);
    if (!(delay >= 0 && delay <= 4294967295.0) || delay != floor(delay)) {
        char received[64];
        js_describe_value(ctx, d, received, sizeof received);
        return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE",
                                   "The value of \"delay\" is out of range. It must be >= 0 && <= 4294967295. Received %s", received);
    }
    JSValue s = new_signal(ctx);
    (void)js_add_timer(ctx, js_new_closure_native(ctx, timeout_fired, 0, s), delay, true);
    return s;
}

/* AbortSignal.any(signals): aborted when any of them is */
BUILTIN(signal_any) {
    UNUSED_ARGS;
    /* WebIDL's sequence<AbortSignal>, as Node converts it: an iterable object, each value a signal */
    JSValue iterable = ARG(0);
    JSValue method = js_is_object(iterable) ? js_get_value(ctx, iterable, JS_SYMBOL(iterator)) : JS_UNDEFINED;
    if (js_is_exception(method)) return method;
    if (!js_is_callable(method))
        return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "signals cannot be converted to sequence.");
    JSValue list = js_new_array(ctx, 4);
    JSValue rec = js_iter_start(ctx, iterable);
    if (js_is_exception(rec)) return rec;
    for (uint32_t i = 0;; i++) {
        JSValue v = js_iter_next(ctx, rec);
        if (js_is_exception(v)) return v;
        if (js_is_empty(v)) break;
        if (!as_signal(v)) {
            JSValue err = js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "signals[%u] is not of type AbortSignal.", i);
            js_iter_close_throw(ctx, rec);
            return err;
        }
        if (js_array_append(ctx, list, v) < 0) return JS_EXCEPTION;
    }
    JSValueArray *signals = js_list_from_array_like(ctx, list);
    if (!signals) return JS_EXCEPTION;
    JSValue result = new_signal(ctx);
    for (uint32_t i = 0; i < signals->cell.aux; i++) {
        AbortSignalObject *s = as_signal(signals->values[i]);
        if (s->aborted) {
            as_signal(result)->aborted = true;
            js_store(ctx, &js_as_object(result)->cell, &as_signal(result)->reason, s->reason);
            return result;
        }
    }
    for (uint32_t i = 0; i < signals->cell.aux; i++) {
        AbortSignalObject *s = as_signal(signals->values[i]);
        if (js_is_undefined(s->dependents)) js_store(ctx, &s->target.obj.cell, &s->dependents, js_new_array(ctx, 0));
        if (js_array_push(ctx, js_as_object(s->dependents), result) < 0) return JS_EXCEPTION;
    }
    return result;
}

/* `AbortSignal { aborted: false }` */
BUILTIN(signal_inspect) {
    UNUSED_ARGS;
    THIS_SIGNAL();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "aborted"), js_bool(s->aborted), JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "AbortSignal", o, ARG(0), ARG(1));
}

/* ---- AbortController ------------------------------------------------------------------------ */

BUILTIN(controller_ctor) {
    (void)callee, (void)this_val, (void)argc, (void)argv;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "AbortController");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_ABORT_CONTROLLER_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    JSValue signal = new_signal(ctx);
    AbortControllerObject *c = (AbortControllerObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &controller_class, proto, 4));
    js_init_slot(&c->signal, signal);
    return js_object_value(&c->obj);
}

#define THIS_CONTROLLER() THIS(AbortControllerObject, c, as_controller, "AbortController")

BUILTIN(controller_signal) {
    UNUSED_ARGS;
    THIS_CONTROLLER();
    return c->signal;
}

BUILTIN(controller_abort) {
    UNUSED_ARGS;
    THIS_CONTROLLER();
    if (as_signal(c->signal)->aborted) return JS_UNDEFINED;
    JSValue reason = reason_or_default(ctx, ARG(0));
    if (js_is_exception(reason)) return reason;
    return signal_abort(ctx, c->signal, reason) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

/* `AbortController { signal: AbortSignal { aborted: false } }` */
BUILTIN(controller_inspect) {
    UNUSED_ARGS;
    THIS_CONTROLLER();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "signal"), c->signal, JS_PROP_DEFAULT);
    return js_inspect_as(ctx, this_val, "AbortController", o, ARG(0), ARG(1));
}

/* ---- C callers (the fetch component's Request.signal) --------------------------------------- */

JSValue js_new_abort_signal(JSContext *ctx) { return new_signal(ctx); }
bool js_is_abort_signal(JSValue v) { return as_signal(v) != NULL; }
void js_abort_signal_abort(JSContext *ctx, JSValue signal, JSValue reason) {
    if (!as_signal(signal) || as_signal(signal)->aborted) return;
    JSValue r = reason_or_default(ctx, reason);
    if (js_is_exception(r) || signal_abort(ctx, signal, r) < 0) js_discard(js_take_exception(ctx));
}

JSValue js_abort_signal_follow(JSContext *ctx, JSValue source) {
    JSValue list = js_new_array_from(ctx, &source, 1);
    return signal_any(ctx, JS_UNDEFINED, JS_UNDEFINED, 1, &list, JS_UNDEFINED);
}

/* ---- Realm ---------------------------------------------------------------------------------- */

#define PHASES(attrs) \
    JS_BUILTIN_NUMBER("NONE", 0, attrs), JS_BUILTIN_NUMBER("CAPTURING_PHASE", 1, attrs), \
    JS_BUILTIN_NUMBER("AT_TARGET", 2, attrs), JS_BUILTIN_NUMBER("BUBBLING_PHASE", 3, attrs)

static const JSBuiltin event_statics[] = { PHASES(JS_PROP_ENUMERABLE) };

static const JSBuiltin event_proto[] = {
    WEBIDL_OPERATION("initEvent", event_init_event, 1),
    WEBIDL_OPERATION("stopImmediatePropagation", event_stop_immediate_propagation, 0),
    WEBIDL_OPERATION("preventDefault", event_prevent_default, 0),
    WEBIDL_ATTRIBUTE("target", event_target, NULL),
    WEBIDL_ATTRIBUTE("currentTarget", event_current_target, NULL),
    WEBIDL_ATTRIBUTE("srcElement", event_target, NULL),
    WEBIDL_ATTRIBUTE("type", event_type, NULL),
    WEBIDL_ATTRIBUTE("cancelable", event_cancelable, NULL),
    WEBIDL_ATTRIBUTE("defaultPrevented", event_default_prevented, NULL),
    WEBIDL_ATTRIBUTE("timeStamp", event_time_stamp, NULL),
    WEBIDL_OPERATION("composedPath", event_composed_path, 0),
    WEBIDL_ATTRIBUTE("returnValue", event_return_value, NULL),
    WEBIDL_ATTRIBUTE("bubbles", event_bubbles, NULL),
    WEBIDL_ATTRIBUTE("composed", event_composed, NULL),
    WEBIDL_ATTRIBUTE("eventPhase", event_event_phase, NULL),
    WEBIDL_ATTRIBUTE("cancelBubble", event_cancel_bubble, event_set_cancel_bubble),
    WEBIDL_OPERATION("stopPropagation", event_stop_propagation, 0),
    WEBIDL_ATTRIBUTE("isTrusted", event_is_trusted, NULL),
};

static const JSBuiltin target_proto[] = {
    WEBIDL_OPERATION("addEventListener", target_add_event_listener, 2),
    WEBIDL_OPERATION("removeEventListener", target_remove_event_listener, 2),
    WEBIDL_OPERATION("dispatchEvent", target_dispatch_event, 1),
};

static const JSBuiltin signal_statics[] = {
    WEBIDL_OPERATION("abort", signal_abort_static, 0),
    WEBIDL_OPERATION("timeout", signal_timeout, 1),
    WEBIDL_OPERATION("any", signal_any, 1),
};

static const JSBuiltin signal_proto[] = {
    WEBIDL_ATTRIBUTE("aborted", signal_aborted, NULL),
    WEBIDL_ATTRIBUTE("reason", signal_reason, NULL),
    WEBIDL_OPERATION("throwIfAborted", signal_throw_if_aborted, 0),
    WEBIDL_ATTRIBUTE("onabort", signal_onabort, signal_set_onabort),
};

static const JSBuiltin controller_proto[] = {
    WEBIDL_ATTRIBUTE("signal", controller_signal, NULL),
    WEBIDL_OPERATION("abort", controller_abort, 0),
};

static void install_events(JSContext *ctx, JSObject *global) {
    if (time_origin == 0) time_origin = js_os_now_ms_precise();
    JSValue object_proto = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];
    JSValue event = js_define_web_class(ctx, global, "Event", event_ctor, 1, object_proto, JS_INTRINSIC_EVENT_PROTOTYPE);
    js_define_builtins(ctx, js_as_object(event), event_statics, JS_COUNTOF(event_statics));
    JSValue ep = ctx->intrinsics[JS_INTRINSIC_EVENT_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(ep), event_proto, JS_COUNTOF(event_proto));
    js_define_inspect(ctx, ep, event_inspect, "Event");

    JSValue target = js_define_web_class(ctx, global, "EventTarget", target_ctor, 0, object_proto, JS_INTRINSIC_EVENT_TARGET_PROTOTYPE);
    JSValue tp = ctx->intrinsics[JS_INTRINSIC_EVENT_TARGET_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(tp), target_proto, JS_COUNTOF(target_proto));
    js_define_inspect(ctx, tp, target_inspect, "EventTarget");

    JSValue signal = js_define_web_class(ctx, global, "AbortSignal", signal_ctor, 0, tp, JS_INTRINSIC_ABORT_SIGNAL_PROTOTYPE);
    if (js_set_prototype_of(ctx, js_as_object(signal), target) < 0) js_discard(js_take_exception(ctx));  /* AbortSignal extends EventTarget */
    js_define_builtins(ctx, js_as_object(signal), signal_statics, JS_COUNTOF(signal_statics));
    JSValue sp = ctx->intrinsics[JS_INTRINSIC_ABORT_SIGNAL_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(sp), signal_proto, JS_COUNTOF(signal_proto));
    js_define_inspect(ctx, sp, signal_inspect, "AbortSignal");

    js_define_web_class(ctx, global, "AbortController", controller_ctor, 0, object_proto, JS_INTRINSIC_ABORT_CONTROLLER_PROTOTYPE);
    JSValue cp = ctx->intrinsics[JS_INTRINSIC_ABORT_CONTROLLER_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(cp), controller_proto, JS_COUNTOF(controller_proto));
    js_define_inspect(ctx, cp, controller_inspect, "AbortController");
}

const JSComponent js_component_events = { "events", install_events };
