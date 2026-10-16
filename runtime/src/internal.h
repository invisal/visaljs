/* internal.h — declarations shared between runtime source files. Not installed. */
#ifndef JS_INTERNAL_H
#define JS_INTERNAL_H

#include <stdbool.h>

#include "js_gc.h"
#include "js_object.h"

/* Whether a cell survived the current collection's marking (static cells always do).
 * Only meaningful during weak processing. */
bool js_gc_is_marked(const JSCell *c);

/* Shapes (shape.c): weak processing after marking, and teardown. */
void js_shapes_sweep(JSRuntime *rt);
void js_shapes_free(JSRuntime *rt);
/* Inline caches (object.c): weak processing after marking, and teardown. */
void js_prop_caches_sweep(JSRuntime *rt);
void js_prop_caches_free(JSRuntime *rt);
/* Realm setup (object.c): %Object.prototype% and friends. */
void js_realm_init(JSContext *ctx);
void js_function_realm_init(JSContext *ctx);  /* function.c: %Function.prototype% */
void js_global_realm_init(JSContext *ctx);    /* global.c: the global object, primitives' prototypes */
void js_error_realm_init(JSContext *ctx, JSObject *global);  /* error.c: Error and the native errors */
void js_builtins_realm_init(JSContext *ctx, JSObject *global);  /* builtins.c: Object, Array, String, … */
/* builtins.c: %GeneratorFunction% (0), %AsyncFunction% (1) or %AsyncGeneratorFunction% (2), for proto */
void js_define_function_kind_ctor(JSContext *ctx, JSValue proto, int kind);

/* The ordinary internal methods (object.c), for class hooks that add to them. */
int js_ordinary_get_own_property(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out);
int js_ordinary_define_own_property(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail);
int js_ordinary_delete(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail);
/* The ordinary versions of the internal methods JSClass.methods may override (typed arrays
 * override only what integer-indexed keys change, and fall back to these). */
int js_ordinary_has_property(JSContext *ctx, JSObject *o, JSValue key);
JSValue js_ordinary_get(JSContext *ctx, JSObject *o, JSValue key, JSValue receiver);
int js_ordinary_set(JSContext *ctx, JSObject *o, JSValue key, JSValue v, JSValue receiver, bool throw_on_fail);
JSValue js_ordinary_own_keys(JSContext *ctx, JSObject *o);
int js_ordinary_prevent_extensions(JSContext *ctx, JSObject *o);

/* The job queue (jobs.c): its roots, teardown, and the host's queueMicrotask. */
void js_jobs_trace(JSRuntime *rt, JSTracer *trc);
void js_jobs_free(JSRuntime *rt);
void js_jobs_realm_init(JSContext *ctx, JSObject *global);

/* Generators (generator.c), shared with async generators (async_iter.c). */
void js_generator_visit(JSCell *c, JSTracer *trc);
struct JSGenerator *js_generator_alloc(JSContext *ctx, const JSClass *cls, JSValue proto, JSValue (*resume)(JSContext *, struct JSGenerator *, JSValue, int), uint32_t slots);
JSValue js_generator_proto(JSContext *ctx, JSValue callee, JSIntrinsic fallback);
/* PerformPromiseThen with native handlers; `derived`: a native promise to settle with the
 * handler's result, or undefined (promise.c). */
void js_promise_then_internal(JSContext *ctx, JSValue promise, JSValue on_fulfilled, JSValue on_rejected, JSValue derived);

/* Weak collections and references (weak.c): the ephemeron pass (true if it
 * marked anything), weak processing after marking, the kept-alive roots, teardown;
 * ClearKeptObjects; the FinalizationRegistry cleanup tasks (0, or -1 after an uncaught
 * error); the realm's WeakMap, WeakSet, WeakRef, FinalizationRegistry. */
bool js_weak_ephemerons(JSRuntime *rt, JSTracer *trc, bool full);
void js_weak_sweep(JSRuntime *rt, bool full);
void js_weak_trace_roots(JSRuntime *rt, JSTracer *trc);
void js_weak_free(JSRuntime *rt);
void js_clear_kept_objects(JSRuntime *rt);
int js_run_finalization_cleanups(JSContext *ctx);

/* Atom table lifecycle (atoms.c). */
void js_atoms_init(JSRuntime *rt);
void js_atoms_sweep(JSRuntime *rt, bool full);  /* weak processing: drop unmarked atoms */
void js_atoms_free(JSRuntime *rt);

/* Cell classes defined outside gc.c: each kind's name and finalizer. The marker visits these kinds
 * itself (gc_visit.h), so their `visit` is NULL; only host cells' classes have one. */
extern const JSCellClass js_flat_string_class;
extern const JSCellClass js_symbol_cell_class;
extern const JSCellClass js_rope_class;
extern const JSCellClass js_slice_class;
extern const JSCellClass js_shape_cell_class;
extern const JSCellClass js_accessor_cell_class;
extern const JSCellClass js_elements_cell_class;
extern const JSCellClass js_object_cell_class;  /* every object kind */
extern const JSCellClass js_env_cell_class;     /* function.c */

#endif /* JS_INTERNAL_H */
