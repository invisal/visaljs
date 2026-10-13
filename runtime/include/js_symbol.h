/*
 * js_symbol.h — symbols (ECMAScript §6.1.5, §20.4).
 *
 * A symbol is a heap cell compared by identity; as a property key it is used as is. The
 * well-known symbols are static cells, like the predefined atoms: JS_SYMBOL(iterator).
 */
#ifndef JS_SYMBOL_H
#define JS_SYMBOL_H

#include "js_atoms.h"

typedef struct JSSymbol {
    JSCell        cell;
    const JSCell *description;  /* a string cell, or NULL for undefined */
} JSSymbol;

#define JS_SYM_REGISTERED 0x01u  /* cell flags: made by Symbol.for; the description is its key */

static inline bool js_is_symbol(JSValue v) {
    return js_is_cell(v) && js_as_cell(v)->kind == JS_CELL_SYMBOL;
}
static inline JSSymbol *js_as_symbol(JSValue v) { return (JSSymbol *)js_as_cell(v); }

/* The well-known symbols (§6.1.5.1). */
#define JS_WELL_KNOWN_SYMBOLS(X) \
    X(asyncIterator) \
    X(hasInstance) \
    X(isConcatSpreadable) \
    X(iterator) \
    X(match) \
    X(matchAll) \
    X(replace) \
    X(search) \
    X(species) \
    X(split) \
    X(toPrimitive) \
    X(toStringTag) \
    X(unscopables) \
    X(dispose) \
    X(asyncDispose)

#define JS_SYMBOL_DECL(id) extern const JSSymbol js_symbol_##id;
JS_WELL_KNOWN_SYMBOLS(JS_SYMBOL_DECL)
#undef JS_SYMBOL_DECL
#define JS_SYMBOL(id) js_cell((JSCell *)&js_symbol_##id)

/* A new symbol; `description` is a string or undefined. */
JSValue js_new_symbol(JSContext *ctx, JSValue description);
/* [[Description]]: a string or undefined. */
static inline JSValue js_symbol_description(JSValue sym) {
    const JSCell *d = js_as_symbol(sym)->description;
    return d ? js_cell((JSCell *)d) : JS_UNDEFINED;
}
/* SymbolDescriptiveString (§20.4.3.3.1): "Symbol(description)". */
JSValue js_symbol_descriptive_string(JSContext *ctx, JSValue sym);
/* Symbol.for(key): the registered symbol for a string key, created on first use. */
JS_WARN_UNUSED JSValue js_symbol_for(JSContext *ctx, JSValue key);

struct JSObject;
void js_symbol_realm_init(JSContext *ctx, struct JSObject *global);

#endif /* JS_SYMBOL_H */
