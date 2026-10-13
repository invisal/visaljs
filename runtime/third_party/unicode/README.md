# unicode

The Unicode license (`LICENSE`, Unicode License v3), for the Unicode data compiled into the
runtime. Nothing here is compiled; the data is in:

- `quickjs-regexp/libunicode-table.h`: QuickJS's tables from the Unicode Character Database
  (case conversion, normalization, properties and scripts for regular expressions).
- `src/tznames.gen.h`: time zones' English names from CLDR, as Node's ICU data has them
  (`tools/gen_tznames.mjs`).
