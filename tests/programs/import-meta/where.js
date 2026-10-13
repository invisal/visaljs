export const meta = import.meta;
export function where() {
  return import.meta.filename.slice(import.meta.dirname.length) + " " + import.meta.resolve("./x.js").slice(-25);
}
