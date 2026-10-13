import { Stack } from "./stack.js";
export const VERSION = "1.0";
export default function describe(x) {
  return x instanceof Stack ? "Stack(" + x.size + ")" : typeof x;
}
