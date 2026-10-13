// A missing `prototype` (arrows, methods, bound functions) must not be cached for the shape
// it shares with functions whose `prototype` is still to be created.
function read(f) {
  return f.prototype;
}
const arrow = () => 0;
const method = { m() {} }.m;
for (let i = 0; i < 3; i++) {
  console.log(read(arrow), read(method), read(function () {}.bind(null)));
}
function F() {}
console.log(typeof read(F), read(F).constructor === F);
function G() {}
G.prototype.x = 1;
console.log(new G().x);

// through the prototype chain
function H() {}
const child = () => 0;
Object.setPrototypeOf(child, H);
console.log(read(child) === H.prototype);
function K() {}
Object.setPrototypeOf(K, H);
console.log(read(K) !== H.prototype, read(K).constructor === K);
