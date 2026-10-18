// Comparisons without js_strict_equals (specialize): a C bool test of boxed values.
function kind(x, t) {
  if (x === undefined) return "undefined";
  if (x == null) return "null";
  if (typeof x === "function") return "function";
  if (typeof x != "object") return "primitive";
  if (t !== "error") return "other";
  return x === t;  // both may be strings: js_strict_equals stays
}
kind(undefined, "a");
kind(null, "b");
kind(kind, "error");
kind({}, 1);
kind("s", "s");
