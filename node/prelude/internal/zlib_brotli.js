// node:zlib's Brotli streams' host primitives, for programs whose code names Brotli
// (internal/zlib_engines.js).
import { brotliClose, brotliInit, brotliNew, brotliReset, brotliWrite } from "visaljs:host";
import { engines } from "./zlib_engines.js";

engines.brotli = { new: brotliNew, init: brotliInit, write: brotliWrite, reset: brotliReset, close: brotliClose };
