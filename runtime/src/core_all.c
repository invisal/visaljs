/* Every core method (js_core.def), for the test hosts and --all-builtins. Programs
 * name theirs in their own C file, so this table is only linked when something calls
 * js_use_all_core. */
#include <math.h>

#include "js_builtins.h"

static const JSCoreEntry all[] = {
#define JS_CORE_FN(...) JS_CORE_ENTRY_FN(__VA_ARGS__),
#define JS_CORE_HOST_FN(...) JS_CORE_ENTRY_HOST_FN(__VA_ARGS__),
#define JS_CORE_ACCESSOR(...) JS_CORE_ENTRY_ACCESSOR(__VA_ARGS__),
#define JS_CORE_NUMBER(...) JS_CORE_ENTRY_NUMBER(__VA_ARGS__),
#define JS_CORE_ALIAS(...) JS_CORE_ENTRY_ALIAS(__VA_ARGS__),
#define JS_CORE_ALIAS_OF(...) JS_CORE_ENTRY_ALIAS_OF(__VA_ARGS__),
#define JS_CORE_SYMBOL_GETTER(...) JS_CORE_ENTRY_SYMBOL_GETTER(__VA_ARGS__),
#define JS_CORE_SYMBOL_ALIAS(...) JS_CORE_ENTRY_SYMBOL_ALIAS(__VA_ARGS__),
#include "js_core.def"
};

void js_use_all_core(JSRuntime *rt) {
    js_use_core(rt, all, JS_COUNTOF(all));
}
