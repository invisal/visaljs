// node:path/win32: path.win32, on every platform.
import { win32 } from "./path.js";

export const {
  resolve, normalize, isAbsolute, join, relative, toNamespacedPath, dirname, basename, extname, format, parse,
  matchesGlob, sep, delimiter, posix,
} = win32;
export { win32 };
export default win32;
