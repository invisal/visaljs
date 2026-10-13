/* Every component: the test host installs them all. Programs name only the ones
 * they reach, so nothing in a program's binary references this list. */
#include "js_builtins.h"

const JSComponent *const js_all_components[] = {
    &js_component_promise,
    &js_component_generator,
    &js_component_asynciterator,
    &js_component_weak,
    &js_component_math,
    &js_component_json,
    &js_component_collections,
    &js_component_reflect,
    &js_component_proxy,
    &js_component_bigint,
    &js_component_arraybuffer,
    &js_component_typedarray,
    &js_component_date,
    &js_component_regexp,
    &js_component_domexception,
    &js_component_encoding,
    &js_component_base64,
    &js_component_url,
    &js_component_events,
    &js_component_buffer,
    &js_component_crypto,
    &js_component_headers,
    &js_component_streams,
    &js_component_blob,
    &js_component_fetch,
};
const size_t js_all_components_count = JS_COUNTOF(js_all_components);

/* Records every component for the realms created after (the runtime's unit tests). */
void js_use_all_components(JSRuntime *rt) {
    rt->components = js_all_components;
    rt->ncomponents = js_all_components_count;
}
