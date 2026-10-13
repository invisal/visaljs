/* regexp_message.h — libregexp's error messages in V8's words, shared by the runtime
 * (new RegExp) and the compiler's regexp-compile tool (literals), so both report alike. */
#ifndef JS_REGEXP_MESSAGE_H
#define JS_REGEXP_MESSAGE_H

#include <stdio.h>
#include <string.h>

/* V8's wording for libregexp's most common messages; the others, capitalized. */
static inline const char *js_regexp_message(const char *msg, char *buf, size_t cap) {
    static const struct { const char *lre, *v8; } names[] = {
        { "expecting ')'", "Unterminated group" },
        { "extraneous characters at the end", "Unmatched ')'" },
        { "nothing to repeat", "Nothing to repeat" },
        { "invalid class range", "Range out of order in character class" },
        { "duplicate group name", "Duplicate capture group name" },
        { "invalid repetition count", "numbers out of order in {} quantifier" },
        { "unknown unicode property name", "Invalid property name" },
        { "unknown unicode property value", "Invalid property name" },
        { "unknown unicode script", "Invalid property name" },
        { "unknown unicode general category", "Invalid property name" },
        { "group name not defined", "Invalid named capture referenced" },
        { "expecting ']'", "Unterminated character class" },
    };
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
        if (strcmp(msg, names[i].lre) == 0) return names[i].v8;
    snprintf(buf, cap, "%s", msg);
    if (buf[0] >= 'a' && buf[0] <= 'z') buf[0] = (char)(buf[0] - 'a' + 'A');
    return buf;
}

#endif /* JS_REGEXP_MESSAGE_H */
