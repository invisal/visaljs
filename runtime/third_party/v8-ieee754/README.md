# v8-ieee754

V8's port of fdlibm (`src/base/ieee754.cc`), converted to C: `Math`'s functions and `**`
return exactly what Node returns. BSD license (`LICENSE`, V8's) and the fdlibm
notice at the top of `ieee754.c` (`LICENSE.fdlibm`). V8's license also covers `Date.parse` in `runtime/src/date.c`,
ported from V8's date parser (`src/date/dateparser*`).

- **Upstream:** V8 branch `12.4-lkgr`, the version Node 22 ships (`process.versions.v8` is
  12.4.254.21-node.39). `sin` and `cos` are the fdlibm ones, which is what Node 22 uses.
- **Converted by `convert.py`** from the upstream file, mechanically: C casts instead of
  `static_cast`, `memcpy` bit casts, the overflow helpers and `numeric_limits` spelled out,
  `js_ieee754_` names, namespaces dropped, V8's optional libm `sin`/`cos` dropped, and
  `pow`'s one signed shift past bit 31 done unsigned (UB that UBSan catches).
- **Checked:** 146,346 inputs (special values, and random ones over 40 orders of magnitude) give
  the same bits as Node for all 21 functions; glibc's libm differs on 6,783 of them.

## Updating

```sh
curl -fL https://raw.githubusercontent.com/v8/v8/<branch>/src/base/ieee754.cc -o v8-ieee754.cc
python3 convert.py <dir with v8-ieee754.cc>   # writes ieee754.c and ieee754.h there
```

Then rerun the runtime tests and `tests/programs/math.js` against the Node it should match.
