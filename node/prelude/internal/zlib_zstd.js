// node:zlib's zstd streams' host primitives, for programs whose code names zstd
// (internal/zlib_engines.js).
import { zstdClose, zstdInit, zstdNew, zstdReset, zstdWrite } from "visaljs:host";
import { engines } from "./zlib_engines.js";

engines.zstd = { new: zstdNew, init: zstdInit, write: zstdWrite, reset: zstdReset, close: zstdClose };
