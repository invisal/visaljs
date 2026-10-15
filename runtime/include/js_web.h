/* js_web.h — the web-standard host layer: what its components share.
 * DOMException is a component of its own (domexception.c); the components that throw one
 * need it. The Node-style errors are web.c's, linked into the programs that throw them. */
#ifndef JS_WEB_H
#define JS_WEB_H

#include "js_builtins.h"
#include "js_error.h"
#include "jscontext.h"

/* A Node error: a native error of `kind` with an enumerable own `code` ("ERR_INVALID_THIS"),
 * thrown. Always JS_EXCEPTION. */
JS_WARN_UNUSED JSValue js_throw_node_error(JSContext *ctx, JSErrorKind kind, const char *code, const char *fmt, ...);
/* ERR_INVALID_THIS: `Value of "this" must be of type TextDecoder`. */
JS_WARN_UNUSED JSValue js_throw_invalid_this(JSContext *ctx, const char *type);
/* ERR_INVALID_ARG_TYPE: `The "dest" argument must be <expected>. Received …` (Node's wording
 * of the value). */
JS_WARN_UNUSED JSValue js_throw_invalid_arg_type(JSContext *ctx, const char *name, const char *expected, JSValue value);
/* Node's "Received …" tail for a value: " Received type number (1)", " Received an instance of
 * Array", " Received undefined". */
void js_node_received(JSContext *ctx, JSValue v, char *buf, size_t cap);
/* `Class constructor X cannot be invoked without 'new'`, as a call of Node's JS classes throws. */
JS_WARN_UNUSED JSValue js_throw_class_without_new(JSContext *ctx, const char *name);

/* domexception.c: new DOMException(message, name), thrown or not. Needs the domexception component. */
JS_WARN_UNUSED JSValue js_throw_dom_exception(JSContext *ctx, const char *name, const char *message);
JS_WARN_UNUSED JSValue js_new_dom_exception(JSContext *ctx, const char *name, const char *message);

/* A native closure: `data` (any value) kept in the function, read back with js_closure_data. */
JSValue js_new_closure_native(JSContext *ctx, JSNativeFn fn, uint32_t length, JSValue data);
JSValue js_closure_data(JSValue callee);

/* Node's inspection of a web class through a plain object: `Name { a: 1 }`, where Name is the
 * receiver's constructor name (`fallback` without one) and the object is inspected with the
 * depth option less one, as Node's do; just `Name` past the depth. A [nodejs.util.inspect.custom](depth, options) body. */
JS_WARN_UNUSED JSValue js_inspect_as(JSContext *ctx, JSValue self, const char *fallback, JSValue object, JSValue depth, JSValue options);
/* The same with a fixed name (undici's classes show theirs whatever the subclass). */
JS_WARN_UNUSED JSValue js_inspect_named(JSContext *ctx, const char *name, JSValue object, JSValue depth, JSValue options);
/* Defines proto[Symbol.for("nodejs.util.inspect.custom")] = fn and proto[Symbol.toStringTag] = tag. */
void js_define_inspect(JSContext *ctx, JSValue proto, JSNativeFn fn, const char *tag);
/* A web class for a component: the constructor, its prototype (inheriting from `parent`, an
 * object) in ctx->intrinsics[slot], and the global binding (writable, configurable). */
JSValue js_define_web_class(JSContext *ctx, JSObject *global, const char *name, JSNativeFn ctor, uint32_t length,
                            JSValue parent, JSIntrinsic slot);

/* UTF-8 bytes as a string, decoded as WHATWG decodes them: U+FFFD for each maximal invalid
 * subpart (V8's and TextDecoder's decoding; js_new_string_utf8 replaces byte by byte). */
JS_WARN_UNUSED JSValue js_decode_utf8_bytes(JSContext *ctx, const uint8_t *p, size_t n);

/* buffer.c (the buffer component): a new Buffer holding a copy of the bytes. */
JS_WARN_UNUSED JSValue js_new_buffer_from_bytes(JSContext *ctx, const uint8_t *p, size_t n);

/* events.c (the events component): AbortSignals for the components that make them. */
JS_WARN_UNUSED JSValue js_new_abort_signal(JSContext *ctx);
bool js_is_abort_signal(JSValue v);
/* Aborts a signal (with the default AbortError when reason is undefined); once only. */
void js_abort_signal_abort(JSContext *ctx, JSValue signal, JSValue reason);
/* A new signal that aborts when `source` does (AbortSignal.any([source])). */
JS_WARN_UNUSED JSValue js_abort_signal_follow(JSContext *ctx, JSValue source);
/* node:events' primitive: an EventTarget's listeners for a type, in the order added (getEventListeners,
 * listenerCount); undefined for a value that isn't an EventTarget. */
JSValue js_event_target_listeners(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);

/* headers.c (the headers component): Headers for Request and Response. */
typedef enum JSHeadersGuard { JS_HEADERS_NONE, JS_HEADERS_IMMUTABLE } JSHeadersGuard;
bool js_is_headers(JSValue v);
/* new Headers(init); init undefined for none. */
JS_WARN_UNUSED JSValue js_new_headers_from(JSContext *ctx, JSValue init);
void js_headers_set_guard(JSValue headers, JSHeadersGuard guard);
/* Appends name/value (validated, whatever the guard): 0, or -1. */
JS_WARN_UNUSED int js_headers_append(JSContext *ctx, JSValue headers, JSValue name, JSValue value);
/* A header's values combined, by its lowercase name: a string, or null. */
JS_WARN_UNUSED JSValue js_headers_get(JSContext *ctx, JSValue headers, const char *lower);
uint32_t js_headers_count(JSValue headers);
void js_headers_at(JSValue headers, uint32_t i, JSValue *lower, JSValue *name, JSValue *value);

/* streams.c (the streams component): ReadableStreams for bodies. A C source pulls with the
 * controller and its data (a promise, a value or JS_EXCEPTION) and cancels with a reason. */
typedef struct JSStreamSource {
    JSValue (*pull)(JSContext *ctx, JSValue controller, JSValue data);
    JSValue (*cancel)(JSContext *ctx, JSValue data, JSValue reason);  /* or NULL */
} JSStreamSource;
JS_WARN_UNUSED JSValue js_new_readable_stream(JSContext *ctx, const JSStreamSource *source, JSValue data, double high_water_mark);
/* A byte stream of one chunk (a Uint8Array), or of none (undefined), closed after it. */
JS_WARN_UNUSED JSValue js_readable_stream_of_bytes(JSContext *ctx, JSValue chunk);
JS_WARN_UNUSED JSValue js_readable_stream_of_chunk(JSContext *ctx, JSValue chunk);  /* not a byte stream */
bool js_is_readable_stream(JSValue v);
bool js_readable_stream_locked(JSValue v);
bool js_readable_stream_disturbed(JSValue v);
JS_WARN_UNUSED int js_readable_stream_enqueue(JSContext *ctx, JSValue controller, JSValue chunk);
JS_WARN_UNUSED int js_readable_stream_close(JSContext *ctx, JSValue controller);
void js_readable_stream_error(JSContext *ctx, JSValue controller, JSValue e);
/* Reads a stream of Uint8Array chunks to the end: a promise of one Uint8Array. */
JS_WARN_UNUSED JSValue js_readable_stream_read_all(JSContext *ctx, JSValue stream);
/* ReadableStreamTee: an array of the two branches. */
JS_WARN_UNUSED JSValue js_readable_stream_tee(JSContext *ctx, JSValue stream);

/* blob.c (the blob component) */
bool js_is_blob(JSValue v);
void js_blob_bytes(JSValue v, const uint8_t **data, size_t *size, JSValue *type);
JS_WARN_UNUSED JSValue js_new_blob(JSContext *ctx, const uint8_t *p, size_t n, JSValue type);

/* url.c (the url component): the href of a string parsed as an absolute URL, or undefined
 * when it doesn't parse. */
JS_WARN_UNUSED JSValue js_parse_url_href(JSContext *ctx, JSValue input);
/* json.c (the json component): JSON.parse(text). */
JS_WARN_UNUSED JSValue js_json_parse(JSContext *ctx, JSValue text);

#define WEBIDL_OPERATION(name, fn, length) \
    { (name), NULL, JS_BUILTIN_KIND_FN, JS_PROP_WRITABLE | JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE, (length), (fn), NULL, 0, NULL }
#define WEBIDL_ATTRIBUTE(name, get, set) \
    { (name), NULL, JS_BUILTIN_KIND_ACCESSOR, JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE, 0, (get), (set), 0, NULL }

#endif /* JS_WEB_H */
