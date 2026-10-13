// node:module's rest: findPackageJSON, SourceMap, the constants, the source maps setting, Module and
// its helpers. (The compile cache is disabled in a compiled program; Node's is enabled.)
import { mkdirSync, writeFileSync } from "node:fs";
import module, { SourceMap, constants, findPackageJSON, findSourceMap, getSourceMapsSupport, setSourceMapsSupport } from "node:module";
import { pathToFileURL } from "node:url";

const show = (label, f) => {
  try {
    print(label + ": " + JSON.stringify(f()));
  } catch (e) {
    print(label + ": " + e.name + " " + e.code + " " + e.message.replaceAll(process.cwd(), "CWD"));
  }
};

mkdirSync("app/src/lib", { recursive: true });
mkdirSync("app/node_modules/dep", { recursive: true });
mkdirSync("app/node_modules/@scope/pkg", { recursive: true });
writeFileSync("app/package.json", '{"name":"app"}');
writeFileSync("app/src/lib/x.js", "");
writeFileSync("app/node_modules/dep/package.json", '{"name":"dep"}');
writeFileSync("app/node_modules/@scope/pkg/package.json", '{"name":"@scope/pkg"}');
const base = pathToFileURL(process.cwd() + "/app/src/lib/x.js").href;
const rel = (p) => (p === undefined ? p : p.replaceAll(process.cwd(), "CWD"));
show("relative", () => rel(findPackageJSON("./x.js", base)));
show("parent", () => rel(findPackageJSON("../../package.json", base)));
show("package", () => rel(findPackageJSON("dep", base)));
show("scoped", () => rel(findPackageJSON("@scope/pkg/sub", base)));
show("file URL", () => rel(findPackageJSON(base)));
show("missing package", () => findPackageJSON("nope", base));

show("constants", () => constants);
show("source maps", () => getSourceMapsSupport());
setSourceMapsSupport(false);
show("findSourceMap", () => findSourceMap("/x.js"));

const map = new SourceMap({ version: 3, file: "out.js", sources: ["a.js", "b.js"], names: ["foo", "bar"], mappings: "AAAA,SAASA;AACA,KCAMC;;AAEA" });
show("payload", () => map.payload.sources);
show("findEntry", () => map.findEntry(0, 9));
show("findEntry 2", () => map.findEntry(1, 7));
show("findEntry none", () => map.findEntry(2, 0));
show("findOrigin", () => map.findOrigin(1, 10));
show("findOrigin 2", () => map.findOrigin(4, 3));
show("lineLengths", () => map.lineLengths);
show("sourcemap no payload", () => new SourceMap(null));

show("Module", () => [typeof module.Module, module.Module === module, typeof module._resolveFilename, module.builtinModules === module.Module.builtinModules]);
show("wrap", () => module.wrap("x"));
show("resolve builtin", () => module._resolveFilename("fs"));
show("resolve missing", () => module._resolveFilename("./nope.js"));
const m = new module.Module("/a/b.js");
show("instance", () => [m.id, m.path, m.loaded, Object.keys(m.exports).length]);
show("syncBuiltinESMExports", () => module.syncBuiltinESMExports());
