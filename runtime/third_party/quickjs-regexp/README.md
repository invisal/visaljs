# quickjs-regexp

Unicode tables and case conversion (`libunicode`) and the regex engine (`libregexp`), from [QuickJS](https://github.com/bellard/quickjs) by Fabrice Bellard. MIT license (`LICENSE`). The Unicode tables are
from the Unicode Character Database: Unicode license, `../unicode/LICENSE`.

- **Upstream commit:** `a38171d37357edff256c28a73eaeb41d2466d1d5` (2026-09-26), the one
  `quickjs-dtoa` comes from: update both together.
- **Files:** `libregexp.c`, `libregexp.h`, `libregexp-opcode.h`, `libunicode.c`, `libunicode.h`,
  `libunicode-table.h`, `cutils.c`, `cutils.h`, `LICENSE`, copied unchanged.
- **Used by:** the RegExp component (`runtime/src/regexp.c`) and the compiler's `regexp-compile`
  tool (`runtime/tools/regexp_compile.c`), which compiles literals when a program is built;
  `String.prototype.toLowerCase` / `toUpperCase` (`lre_case_conv`) and `normalize`
  (`unicode_normalize`, which URL hosts' IDNA also uses: `third_party/ada-idna`). Programs are linked with `--gc-sections`, so case conversion costs about
  4 KiB and normalization about 21 KiB, only in programs that link them.

## Updating

```sh
cp <quickjs>/{libregexp.c,libregexp.h,libregexp-opcode.h,libunicode.c,libunicode.h,libunicode-table.h,cutils.c,cutils.h,LICENSE} runtime/third_party/quickjs-regexp/
# update the commit hash here (and in quickjs-dtoa), then run the runtime tests,
# tests/programs/string.js and regexp.js against Node, and test262's built-ins/RegExp
```
