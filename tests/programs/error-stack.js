// error.stack: an own, non-enumerable string. Only its first line, "Name: message":
// frames aren't recorded, so only that line is compared with Node.
function first(e) { var i = e.stack.indexOf("\n"); return i < 0 ? e.stack : e.stack.slice(0, i); }
print(first(new Error("boom")));
print(first(new TypeError("bad type")));
print(first(new RangeError()));
print(first(Error("no new")));
class MyError extends Error {}
print(first(new MyError("sub")));
class Named extends Error {}
Named.prototype.name = "Named";
print(first(new Named("with name")));
var d = Object.getOwnPropertyDescriptor(new Error("x"), "stack");
print(typeof new Error("x").stack + " " + d.enumerable + " " + d.configurable);
print(Object.keys(new Error("x")).length);
try { null.x; } catch (e) { print(e.stack.slice(0, e.stack.indexOf(":"))); }
try { undefinedName; } catch (e) { print(first(e)); }
var e = new Error("m");
e.stack = "custom";
print(e.stack);
var getterRan = false;
class Sneaky extends Error {}
Object.defineProperty(Sneaky.prototype, "name", { get: function () { getterRan = true; return "S"; } });
new Sneaky("quiet");
print(getterRan);
