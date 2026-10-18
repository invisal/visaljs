// Element access with keys that don't change (the constant-keys pass).
const kState = Symbol("kState");
let changing = Symbol("a");
changing = Symbol("b");

function read(o) {
  return o[kState] + o[changing];
}
function write(o, v) {
  o[kState] = v;
}
function literal(o) {
  o["name"] = o["first"];
  return o["0"];
}
const o = {};
write(o, 1);
literal(o);
read(o);
