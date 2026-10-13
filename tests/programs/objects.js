// visaljs-flags: --script
// Objects, arrays and property access: literals, get/set/delete, computed
// keys, prototypes, `in`, `instanceof`, `new` of builtins, method calls.
var point = { x: 1, "y": 2, 3: "three", ["z" + 1]: 4 };
print(point.x + point.y);
print(point[3] + " " + point["3"] + " " + point.z1 + " " + point.missing);

point.x += 10;
point.x++;
++point["y"];
point.w = point.x * 2;
point["v" + 1] = "computed";
print(point.x + " " + point.y + " " + point.w + " " + point.v1);
print(("w" in point) + " " + ("nope" in point) + " " + (3 in point));
print(delete point.w);
print("w" in point);
print(delete point.w);

var key = "dyn";
var o = {};
for (var i = 0; i < 5; i++) o[key + i] = i * i;
print(o.dyn0 + o.dyn1 + o.dyn2 + o.dyn3 + o.dyn4);

// the same shape, many objects: inline caches hit
var total = 0;
for (var j = 0; j < 1000; j++) {
  var p = { a: j, b: 2 };
  p.c = p.a + p.b;
  total += p.c;
}
print(total);

// arrays: holes, length, out-of-range writes
var arr = [10, , 30];
print(arr.length + " " + arr[0] + " " + arr[1] + " " + arr[2] + " " + (1 in arr));
arr[6] = 70;
print(arr.length + " " + arr[6] + " " + arr[5]);
arr.length = 2;
print(arr.length + " " + arr[2]);
var nested = [[1, 2], [3, [4, 5]]];
print(nested[1][1][0] + nested[0][1]);

// prototypes
var base = { greet: "hi", shared: 1 };
var derived = { __proto__: base, own: 2 };
print(derived.greet + " " + derived.own + " " + ("greet" in derived));
base.shared = 5;
print(derived.shared);
derived.shared = 7;
print(base.shared + " " + derived.shared);

// strings as objects
var s = "héllo";
print(s.length + " " + s[1] + " " + s[9]);

// errors are objects
var e = new RangeError("too far", { cause: point });
print(e instanceof RangeError);
print(e instanceof Error);
print(e instanceof TypeError);
print(e.message + " " + e.name + " " + (e.cause === point));
var plain = Error("no new");
print(plain.message + " " + plain);
try {
  var u;
  u.prop;
} catch (err) {
  print(err instanceof TypeError);
  print(err.message);
}
try {
  point.missing();
} catch (err) {
  print(err.message);
}
try {
  null[key] = 1;
} catch (err) {
  print(err.message);
}
try {
  "x" in 5;
} catch (err) {
  print(err.message);
}

// typeof on undeclared globals, the global object
print(typeof notDefinedAnywhere);
print(typeof globalThis + " " + (this === globalThis) + " " + (globalThis.globalThis === globalThis));
globalThis.fromGlobal = 42;
print(fromGlobal);
console.log("console", 1, "works");
