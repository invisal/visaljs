// node:path/posix: path.posix, on every platform.
import { posix } from "./path.js";

export const {
  resolve, normalize, isAbsolute, join, relative, toNamespacedPath, dirname, basename, extname, format, parse,
  matchesGlob, sep, delimiter, win32,
} = posix;
export { posix };
export default posix;
