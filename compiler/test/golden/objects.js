// Property access through inline caches, literals, method calls, new.
function area(r) {
  return r.w * r.h;
}
function grow(r, k) {
  r.w += 1;
  r[k] = 0;
  return delete r.h;
}
var box = { w: 2, h: 3, [1 + 1]: "two", __proto__: null };
print(area(box));
print("w" in box);
var list = [1, , box];
console.log(list[2].w, new Error("e").message);
