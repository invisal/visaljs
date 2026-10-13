# quickjs-dtoa

Float64 printing and parsing from [QuickJS](https://github.com/bellard/quickjs),
by Fabrice Bellard. MIT license (`LICENSE`).

- **Upstream commit:** `a38171d37357edff256c28a73eaeb41d2466d1d5` (2026-09-26)
- **Files:** `dtoa.c`, `dtoa.h`, `LICENSE` copied unchanged except for the patches below.

## Patches to `dtoa.c`

1. `#include "cutils.h"` → `#include "dtoa_compat.h"` (the few helpers it uses, portable to MSVC).
2. Removed the unused `#include <sys/time.h>` and `#include <setjmp.h>` (they break MSVC).
3. `js_dtoa` free format: at a power of two, also try the mantissa one above the nearest
   when the nearest doesn't round-trip (marked `visaljs patch 3`). Without it, 54 of the
   2,098 powers of two print one digit longer than the shortest, e.g. `2 ** -24`.

## Updating

```sh
cp <quickjs>/dtoa.c <quickjs>/dtoa.h <quickjs>/LICENSE runtime/third_party/quickjs-dtoa/
# re-apply the patches above, update the commit hash here, then run the runtime tests
# (jsnum_node_fixture covers every power of two, so a lost patch 3 fails loudly)
```
