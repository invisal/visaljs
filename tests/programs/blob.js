// Blob and File, as Node has them: parts, types, slices, the readers, errors and inspection.
const err = async (f) => {
  try {
    await f();
    return "no error";
  } catch (e) {
    return `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
  }
};

const b = new Blob(["héllo", new Uint8Array([33]), new Blob(["?"]), new ArrayBuffer(1), new DataView(new ArrayBuffer(2))], { type: "Text/Plain" });
console.log(b, b.size, b.type, b.slice(1, 3), b.slice(-2).size, b.slice(2, 1).size, b.slice(0, 2, "A/B").type);
console.log(await b.text(), await b.arrayBuffer(), await b.bytes(), b.stream());
console.log(await new Blob(["ab", "cd"]).slice(1, -1).text(), new Blob([], { type: "é" }).type, new Blob(), new Blob([1, null, {}]).size);
const chunks = [];
for await (const chunk of new Blob(["streamed"]).stream()) chunks.push(chunk);
console.log(chunks);
console.log(await err(() => new Blob("x")), "|", await err(() => Blob()), "|", await err(() => new Blob([], 1)));
console.log(Object.keys(Blob.prototype), Object.prototype.toString.call(b));

const f = new File(["ab"], "a.txt", { type: "text/plain", lastModified: 5 });
console.log(f, f.name, f.lastModified, f instanceof Blob, await f.text(), Object.prototype.toString.call(f));
console.log(typeof new File([], "n").lastModified, Object.getPrototypeOf(File) === Blob);
console.log(await err(() => new File(["a"])), "|", await err(() => File.prototype.name));
