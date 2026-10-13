// Symbols: the primitive, keys, the registry, well-known symbols.
var a = Symbol("a");
var b = Symbol("a");
print(typeof a);
print(a === a);
print(a === b);
print(a == b);
print(String(a));
print(a.toString());
print(a.description);
print(Symbol().description);
print(String(Symbol()));
print(Symbol("").toString());

// as property keys: own keys list strings first, then symbols, in insertion order
var o = {};
o[a] = 1;
o.x = 2;
o[b] = 3;
o.y = 4;
print(o[a] + o[b]);
print(Object.keys(o).join());
print(Object.getOwnPropertyNames(o).join());
var syms = Object.getOwnPropertySymbols(o);
print(syms.length + " " + (syms[0] === a) + " " + (syms[1] === b));
print(a in o);
delete o[a];
print(a in o);
var lit = { [a]: "computed", plain: 1 };
print(lit[a]);

// conversions that throw
try { a + ""; } catch (e) { print(e.constructor.name + ": " + e.message); }
try { +a; } catch (e) { print(e.constructor.name + ": " + e.message); }
try { a.concat; String(a) + a; } catch (e) { print(e.constructor.name); }
try { new Symbol(); } catch (e) { print(e.constructor.name); }
print(!!a);

// the registry
var r = Symbol.for("app");
print(r === Symbol.for("app"));
print(Symbol.keyFor(r));
print(Symbol.keyFor(a));
print(r.description);

// well-known symbols
print(typeof Symbol.iterator);
print(String(Symbol.iterator));
print(Symbol.iterator.description);
print(Symbol.iterator === Symbol.iterator);
var d = Object.getOwnPropertyDescriptor(Symbol, "iterator");
print(d.writable + " " + d.enumerable + " " + d.configurable);

// Symbol.toPrimitive
var money = { [Symbol.toPrimitive](hint) { return hint === "number" ? 42 : "forty-two (" + hint + ")"; } };
print(+money);
print(String(money));
print(money + "");
var bad = { [Symbol.toPrimitive]() { return {}; } };
try { +bad; } catch (e) { print(e.constructor.name); }

// methods on the primitive
print(Symbol.prototype.toString.call(a));
print(a.valueOf() === a);
print(Object.getPrototypeOf(a) === Symbol.prototype);
print(a.constructor === Symbol);
try { Symbol.prototype.toString.call({}); } catch (e) { print(e.constructor.name); }
