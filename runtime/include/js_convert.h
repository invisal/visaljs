/*
 * js_convert.h — type conversions (ECMAScript §7.1).
 *
 * Objects convert through ToPrimitive (valueOf / toString).
 */
#ifndef JS_CONVERT_H
#define JS_CONVERT_H

#include "js_exception.h"

typedef enum { JS_HINT_DEFAULT, JS_HINT_NUMBER, JS_HINT_STRING } JSHint;

/* ToPrimitive: primitives unchanged; objects via valueOf/toString (§7.1.1). */
JS_WARN_UNUSED JSValue js_to_primitive(JSContext *ctx, JSValue v, JSHint hint);
/* OrdinaryToPrimitive (§7.1.1.1), for Date.prototype[@@toPrimitive]: v is an object. */
JS_WARN_UNUSED JSValue js_ordinary_to_primitive(JSContext *ctx, JSValue v, JSHint hint);
/* ToString. */
JS_WARN_UNUSED JSValue js_to_string(JSContext *ctx, JSValue v);
/* ToNumber: 0 on success with *out set, -1 with an exception pending. */
JS_WARN_UNUSED int js_to_number(JSContext *ctx, double *out, JSValue v);

#endif /* JS_CONVERT_H */
