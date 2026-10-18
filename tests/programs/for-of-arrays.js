// for…of over arrays: a dense array's present elements read inline; a hole, a sparse array, an
// array changed while iterated, and an element the prototype chain supplies take the [[Get]].
const out = [];
for (const v of [1, 2, 3]) out.push(v);
for (const v of [1, , 3]) out.push(v);
const grown = [1, 2];
for (const v of grown) {
  out.push(v);
  if (grown.length < 4) grown.push(v * 10);
}
const shrunk = [1, 2, 3, 4];
for (const v of shrunk) {
  out.push(v);
  shrunk.length = 2;
}
const sparse = [];
sparse[5] = "five";
for (const v of sparse) out.push(v);
Object.defineProperty(Array.prototype, 1, { get() { return "from the prototype"; }, configurable: true });
for (const v of [0, , 2]) out.push(v);
delete Array.prototype[1];
console.log(JSON.stringify(out));
