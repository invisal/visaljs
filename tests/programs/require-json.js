// require() of a JSON file at run time (an id the bundler can't resolve, as Next.js's manifests):
// relative to the requiring file, by an absolute path, from a file: URL base; parsed once into the
// one require.cache, as Node's loader does; a missing file, a broken one and a bare id throw.
// Runs in an empty temporary directory.
import fs from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const rel = (text) => text.replaceAll(cwd + sep, "");
fs.mkdirSync("sub");
fs.writeFileSync("data.json", '﻿{ "name": "data", "list": [1, 2] }');
fs.writeFileSync(join("sub", "other.json"), '{ "other": true }');
fs.writeFileSync("broken.json", "{ name: 1 }");

const require = createRequire(join(cwd, "main.js"));
const data = require("./data.json");
console.log(data, require("./data.json") === data, require(join(cwd, "data.json")) === data);
console.log(require("./sub/other.json"), require("./sub/../data.json") === data);
const fromURL = createRequire(pathToFileURL(join(cwd, "sub", "main.js")).href);
console.log(fromURL("./other.json"), fromURL("../data.json") === data, fromURL.cache === require.cache);
for (const id of ["./missing.json", "./broken.json", "data.json"]) {
  try { require(id); } catch (e) { console.log(e.name, e.code, rel(e.message.split("\n")[0])); }
}
