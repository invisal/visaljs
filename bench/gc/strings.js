// Building, joining and splitting strings: ropes, slices, flat strings, large strings.
let n = 0;
for (let r = 0; r < 200; r++) {
  const parts = [];
  for (let i = 0; i < 10000; i++) parts.push("item-" + i + ":" + (i * r));
  const s = parts.join(",");
  n += s.length + s.split(",").length;
}
console.log(n);
