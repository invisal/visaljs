/* js_module.h — module-level host behavior: import.meta and import(). */
#ifndef JS_MODULE_H
#define JS_MODULE_H

#include "js_function.h"

/* import.meta of the original module at `file` (an absolute path): created on first use and
 * kept in *cache (a module slot, so the GC sees it), with null prototype and Node's
 * properties dirname, filename, main, resolve and url. */
JSValue js_import_meta(JSContext *ctx, JSValue *cache, const char *file, bool main);

/* import(specifier, options) in the module at `importer`, for a specifier the bundler left in
 * the program: a promise, rejected (ERR_MODULE_NOT_FOUND unless an argument check fails). */
JSValue js_dynamic_import(JSContext *ctx, JSValue specifier, JSValue options, const char *importer);

#endif /* JS_MODULE_H */
