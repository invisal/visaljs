/* regexp_anchor.h — a start-anchored regular expression tries one position, shared
 * by the runtime (new RegExp) and the compiler's regexp-compile tool (literals).
 *
 * libregexp starts a non-sticky program with a loop that tries every position:
 *
 *     split_goto_first +6; any; goto -11; save_start 0; <the pattern>
 *
 * When the pattern's first op is line_start (`^` without the m flag, in front of every
 * alternative), a match can only start at index 0, so trying the later positions only costs
 * time: O(length) for every failed exec, which makes a tokenizer that tries its `^` rules on the
 * rest of its input quadratic. Turning the split into `goto +6` (same size, so no offset moves)
 * leaves one attempt, at lastIndex, where line_start fails unless it is 0. */
#ifndef JS_REGEXP_ANCHOR_H
#define JS_REGEXP_ANCHOR_H

#include <stdint.h>

enum {
#define DEF(id, size) JS_REOP_##id,
#include "libregexp-opcode.h"
#undef DEF
};

#define JS_RE_HEADER_LEN 8  /* libregexp's RE_HEADER_LEN: flags, counts, bytecode length */

static inline void js_regexp_anchor(uint8_t *bc, int len) {
    const uint8_t *p = bc + JS_RE_HEADER_LEN;
    if (len < JS_RE_HEADER_LEN + 14 || p[0] != JS_REOP_split_goto_first || p[5] != JS_REOP_any || p[6] != JS_REOP_goto ||
        p[11] != JS_REOP_save_start || p[13] != JS_REOP_line_start)
        return;
    bc[JS_RE_HEADER_LEN] = JS_REOP_goto;
}

#endif /* JS_REGEXP_ANCHOR_H */
