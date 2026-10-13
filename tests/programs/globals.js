// visaljs-flags: --script
// Script globals: top-level var and functions on the global object.
var a = 1;
function f() { return "f"; }
let l = "lexical";
print(globalThis.a + " " + globalThis.f() + " " + ("l" in globalThis) + " " + typeof globalThis.l);
var d = Object.getOwnPropertyDescriptor(globalThis, "a");
print(d.writable + " " + d.enumerable + " " + d.configurable);
globalThis.a = 5;
print(a);
function setIt() { a = 7; undeclared = "created"; }
setIt();
print(a + " " + globalThis.undeclared + " " + undeclared);
print(delete globalThis.undeclared);
print(typeof undeclared);
print(delete a);
implicit = 1;
implicit += 2;
print(implicit + " " + Object.getOwnPropertyDescriptor(globalThis, "implicit").configurable);
function strictSet() { "use strict"; try { nope = 1; } catch (e) { return e.name + ": " + e.message; } }
print(strictSet());
function strictExisting() { "use strict"; implicit = 10; return implicit; }
print(strictExisting());
var Array;
print(typeof Array);
try { undefined = 1; print("sloppy ok " + undefined); } catch (e) { print(e.name); }
function strictUndef() { "use strict"; try { undefined = 1; } catch (e) { return e.name; } }
print(strictUndef());
var counter = 0;
for (var i = 0; i < 5; i++) counter += i;
print(counter + " " + i + " " + globalThis.i);
print(this.f === f);
