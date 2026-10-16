// require() of a JSON file by a Windows path: a drive letter with either separator, a path rooted
// on the current drive, .\ and ..\ relative ids, a file: URL base; findPackageJSON from Windows
// specifiers. (A compiled Next.js server's require(path.join(distDir, "server", "middleware-manifest.json"))
// threw MODULE_NOT_FOUND on Windows.) Runs in an empty temporary directory.
import fs from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const rel = (text) => text?.replaceAll(cwd, "CWD");
fs.mkdirSync(join("server", "app"), { recursive: true });
fs.writeFileSync("package.json", '{ "name": "app" }');
fs.writeFileSync(join("server", "manifest.json"), '{ "middleware": {} }');
fs.writeFileSync(join("server", "x.js"), "");
fs.writeFileSync(join("server", "app", "page.js"), "");
fs.mkdirSync(join("node_modules", "dep"), { recursive: true });
fs.writeFileSync(join("node_modules", "dep", "package.json"), '{ "name": "dep" }');

const page = join(cwd, "server", "app", "page.js");
const require = createRequire(page);
const manifest = require(join(cwd, "server", "manifest.json"));
console.log(manifest, require(`${cwd.replaceAll("\\", "/")}/server/manifest.json`) === manifest);
console.log(require(`${cwd.slice(2)}\\server\\manifest.json`) === manifest);
console.log(require("..\\manifest.json") === manifest, require(".\\..\\manifest.json") === manifest, require("../manifest.json") === manifest);
const fromURL = createRequire(pathToFileURL(join(cwd, "server", "x.js")).href);
console.log(fromURL(".\\manifest.json") === manifest);
try { require(join(cwd, "missing.json")); } catch (e) { console.log(e.code, rel(e.message.split("\n")[0])); }

/* a specifier is a URL: the closest package.json as a namespaced path (\\?\C:\…), a package's as is */
console.log(rel(findPackageJSON(pathToFileURL(page))));
console.log(rel(findPackageJSON("./page.js", page)), rel(findPackageJSON("../../package.json", page)));
console.log(rel(findPackageJSON("dep", page)));
try { findPackageJSON(page); } catch (e) { console.log(e.name, e.code, e.message); }
