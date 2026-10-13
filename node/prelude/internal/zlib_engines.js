// node:zlib's optional libraries: Brotli's and zstd's host primitives are registered
// here by internal/zlib_brotli.js and internal/zlib_zstd.js, implicit modules a program gets when
// its own code names them, so a program that only gzips links neither (~800 and ~600 KB).
export const engines = { brotli: null, zstd: null };
