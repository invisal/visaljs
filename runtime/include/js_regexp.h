/*
 * js_regexp.h — regular expression literals, for generated code.
 *
 * The compiler compiles each literal when the program is built (QuickJS's libregexp, run as the
 * regexp-compile tool) and emits its bytecode as static data; evaluating the literal creates a
 * new RegExp object that points at it (§13.2.7.3).
 */
#ifndef JS_REGEXP_H
#define JS_REGEXP_H

#include <stdint.h>

#include "jsstring.h"
#include "jsvalue.h"

typedef struct JSRegExpLiteral {
    const uint8_t  *bytecode;  /* libregexp bytecode; NULL: compiled at run time, at each evaluation */
    const JSString *source;    /* the pattern as written between the slashes */
    uint16_t        flags;     /* LRE_FLAG_* (for compiling at run time) */
} JSRegExpLiteral;

/* A new RegExp for a literal (the regexp component). */
JS_WARN_UNUSED JSValue js_regexp_literal(JSContext *ctx, const JSRegExpLiteral *lit);

#endif /* JS_REGEXP_H */
