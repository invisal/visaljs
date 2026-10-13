// visaljs-flags: --script
// The arguments object: mapped and unmapped, callee, arrows, defaults.
function count() { return arguments.length; }
print(count() + " " + count(1, 2, 3) + " " + count(undefined));
function sum() { var s = 0; for (var i = 0; i < arguments.length; i++) s += arguments[i]; return s; }
print(sum(1, 2, 3, 4));
function mapped(a, b) { arguments[0] = 10; b = 20; return a + "/" + arguments[1] + "/" + arguments.length; }
print(mapped(1, 2) + " " + mapped(1));
function unmapped(a) { "use strict"; arguments[0] = 10; return a; }
print(unmapped(1));
function nonSimple(a = 0) { arguments[0] = 10; return a; }
print(nonSimple(1));
function callee() { return arguments.callee === callee; }
print(callee());
function strictCallee() { "use strict"; try { return arguments.callee; } catch (e) { return e.name; } }
print(strictCallee());
print(Object.prototype.toString.call((function () { return arguments; })()));
function arrowArgs() { var f = () => arguments[0]; return f(99); }
print(arrowArgs(7));
function deleted(a) { delete arguments[0]; arguments[0] = 5; return a; }
print(deleted(1));
function defaultArgs(a, b = arguments.length) { return b; }
print(defaultArgs(1) + " " + defaultArgs(1, undefined, 3));
function varArgs() { var arguments; return typeof arguments; }
print(varArgs(1));
function shadow(arguments) { return arguments; }
print(shadow("param"));
function viaApply() { return sum.apply(null, arguments); }
print(viaApply(5, 6));
function keys(a, b) { return Object.keys(arguments).join(",") + " " + arguments.propertyIsEnumerable("length"); }
print(keys("x", "y", "z"));
function dup(a, a) { arguments[1] = "second"; return a; }
print(dup(1, 2));
function setLength() { arguments.length = 1; return Array.prototype.slice.call(arguments).join(); }
print(setLength(1, 2, 3));
// Strict functions whose only uses are .length and [Number] read the call's arguments directly
// (the optimizer's elide-arguments); the others keep the object.
function strictSum() { "use strict"; let s = 0; for (let i = 0; i < arguments.length; i++) s += arguments[i]; return s; }
print(strictSum() + " " + strictSum(1, 2, 3));
function strictRest(a) { "use strict"; const out = []; for (let i = 1; i < arguments.length; i++) out.push(arguments[i]); return out.join("|"); }
print(strictRest("a", "b", "c") + " [" + strictRest("a") + "]");
function strictOut() { "use strict"; return [arguments[5], arguments[-1], arguments[0.5], arguments[NaN]].join(); }
print(strictOut(1, 2));
function strictKey(k) { "use strict"; return arguments[k]; }
print(strictKey("length") + " " + strictKey(0) + " " + typeof strictKey("toString"));
function strictPass() { "use strict"; return strictSum.apply(null, arguments) + arguments.length; }
print(strictPass(4, 5));
function strictArrow() { "use strict"; const f = () => arguments.length + ":" + arguments[0]; return f(); }
print(strictArrow("x", "y"));
function* strictGen() { "use strict"; yield arguments.length; yield arguments[1]; }
print([...strictGen("p", "q")].join());
async function strictAsync() { "use strict"; await null; return arguments[0] + arguments.length; }
strictAsync("z", 1).then(print);
