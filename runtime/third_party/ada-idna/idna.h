/* idna.h — UTS #46 domain to ASCII, as the URL standard applies it (CheckHyphens false,
 * CheckBidi and CheckJoiners true, UseSTD3ASCIIRules false, nontransitional, no DNS length
 * check): a C port of Ada's IDNA (ada-url/ada 2.9.2, the version Node bundles), so that hosts
 * match Node's. Normalization to NFC is QuickJS's libunicode (unicode_normalize). */
#ifndef JS_IDNA_H
#define JS_IDNA_H

#include <stddef.h>
#include <stdint.h>

/* The ASCII form of a domain given as code points: malloc'd, NUL-terminated, its length in
 * *out_len; NULL when the domain is invalid (Ada's empty result). */
char *idna_to_ascii(const uint32_t *domain, size_t n, size_t *out_len);

#endif /* JS_IDNA_H */
