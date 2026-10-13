// visaljs-flags: --all-builtins
// Array and Array.prototype: every method, holes, array-likes, Symbol.species, and
// V8's property order, compared with Node.
const a = [5, 1, 4, 2, 3];
console.log(a.at(-1), a.at(9), [1, [2, [3, [4]]]].flat(), [1, [2, [3, [4]]]].flat(Infinity), [1, 2].flatMap((x) => [x, x * 10]));
console.log([1, 2].concat([3, [4]], 5, { length: 1, 0: "x", [Symbol.isConcatSpreadable]: true }), [, 1].concat([, 2]));
console.log([1, 2, 3, 4, 5].copyWithin(0, 3), [1, 2, 3, 4, 5].copyWithin(1, 0, 3), new Array(3).fill(7), [1, 2, 3].fill(0, -2));
console.log(a.find((x) => x > 3), a.findIndex((x) => x > 3), a.findLast((x) => x > 3), a.findLastIndex((x) => x > 30));
console.log([1, 2, 1].lastIndexOf(1), [1, 2, 1].lastIndexOf(1, -2), [NaN].includes(NaN), [NaN].indexOf(NaN), [-0].includes(0), [, 1].includes(undefined));
const s = [3, 1, 2];
console.log(s.reverse(), s.shift(), s, s.unshift(9, 8), s);
const sp = [1, 2, 3, 4, 5];
console.log(sp.splice(1, 2, "a", "b", "c"), sp, sp.splice(-2), sp, sp.splice(1, 0, "z"), sp);
console.log([10, 9, 1, 100].sort(), [10, 9, 1, 100].sort((x, y) => x - y), ["b", undefined, "a", , "c"].sort(), [3, 1, 2].toSorted(), [1, 2, 3].toReversed());
const people = [{ n: "a", age: 30 }, { n: "b", age: 20 }, { n: "c", age: 30 }, { n: "d", age: 20 }];
console.log(people.sort((x, y) => x.age - y.age).map((p) => p.n).join(""));  /* stable */
console.log([1, 2, 3, 4].filter((x) => x % 2), [1, 2].every((x) => x > 0), [1, 2].some((x) => x > 1), [1, 2, 3].reduce((x, y) => x + y), [1, 2, 3].reduceRight((x, y) => x + y, ""));
console.log([1, 2, 3].toSpliced(1, 1, "x", "y"), [1, 2, 3].with(-1, 9), [1, , 3].toReversed(), [1, , 3].map((x) => x * 2));
try { [].reduce((x, y) => x); } catch (e) { console.log(e.name, e.message); }
try { [1].with(5, 0); } catch (e) { console.log(e.name, e.message); }
console.log(Array.from("héllo"), Array.from({ length: 3 }, (_, i) => i * i), Array.from([1, 2].values()), Array.of(7, 8), Array.from([1, 2].entries()));
class MyArray extends Array {}
const m = MyArray.from([1, 2, 3]);
console.log(m instanceof MyArray, m.map((x) => x).constructor.name, m.filter(Boolean) instanceof MyArray, MyArray.of(1).length, Array[Symbol.species] === Array);
const like = { length: 3, 0: "a", 2: "c" };
console.log(Array.prototype.map.call(like, (x) => x), Array.prototype.join.call(like, "-"), Array.prototype.slice.call("abc", 1));
console.log([1, [2, 3]].toString(), [1, null, undefined, 2].join(), [1.5, "x"].toLocaleString(), String([]));
console.log(Object.getOwnPropertyNames(Array.prototype).join(), Object.keys(Array.prototype[Symbol.unscopables]).join());
console.log(Object.getOwnPropertyNames(Array).join(), [].values === [][Symbol.iterator], [..."ab"].entries().next());
async function* gen() { yield 1; yield Promise.resolve(2); yield 3; }
const fromAsync = [
  Array.fromAsync(gen()),
  Array.fromAsync([Promise.resolve("a"), "b"], (x) => x + "!"),
  Array.fromAsync({ length: 2, 0: Promise.resolve(10), 1: 20 }, async (x, i) => x * 2 + i),
  Array.fromAsync([1], 5).catch((e) => e.name),
  Array.fromAsync([Promise.reject(new RangeError("no"))]).catch((e) => e.name + ": " + e.message),
  MyArray.fromAsync([1, 2]).then((r) => r instanceof MyArray),
];
console.log("fromAsync is", typeof Array.fromAsync([]).then);
Promise.all(fromAsync).then((results) => console.log(results));
