// --report size: where a binary's bytes come from. ld64's link map gives every symbol's size and
// object file (a library's archive member, or the program's own); the program's code is split
// among its JS files by the DWARF line table, which the C's #line directives point at them.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { preludeDir } from "@visaljs/node";

import type { CLibrary } from "./hosts.ts";
import { size } from "./report.ts";


interface MapSymbol { address: number; size: number; object: number; name: string }
interface Section { address: number; size: number; name: string }

interface LinkMap {
  objects: string[];
  sections: Section[];
  symbols: MapSymbol[];
}

/* zero fill: memory at run time, not bytes in the file */
const ZEROFILL = new Set(["__DATA,__bss", "__DATA,__common", "__DATA,__thread_bss"]);
const CODE = "__TEXT,__text";

export function parseLinkMap(text: string): LinkMap {
  const objects: string[] = [], sections: Section[] = [], symbols: MapSymbol[] = [];
  let part = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) {
      part = line.startsWith("# Object files") ? "objects" : line.startsWith("# Sections") ? "sections"
        : line.startsWith("# Symbols") ? "symbols" : line.startsWith("# Dead Stripped") ? "" : part;
      continue;
    }
    if (part === "objects") {
      const m = /^\[\s*(\d+)\] (.*)$/.exec(line);
      if (m) objects[Number(m[1])] = m[2]!;
    } else if (part === "sections") {
      const [address, bytes, segment, section] = line.split("\t");
      if (section) sections.push({ address: parseInt(address!, 16), size: parseInt(bytes!, 16), name: `${segment},${section.trim()}` });
    } else if (part === "symbols") {
      const m = /^0x([0-9A-F]+)\t0x([0-9A-F]+)\t\[\s*(\d+)\] (.*)$/.exec(line);
      if (m) symbols.push({ address: parseInt(m[1]!, 16), size: parseInt(m[2]!, 16), object: Number(m[3]), name: m[4]! });
    }
  }
  return { objects, sections, symbols };
}

interface LineRange { start: number; end: number; file: string; line: number }

/** The line table's address ranges, each with its source file, sorted by address. `text` is
 *  `dwarfdump --debug-line`'s output. */
export function parseLineTable(text: string): LineRange[] {
  const ranges: LineRange[] = [];
  let dirs: string[] = [], files: string[] = [];
  let pendingFile: number | undefined;
  let prev: { address: number; file: string; line: number } | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("debug_line[")) {
      dirs = [];
      files = [];
      prev = undefined;
      continue;
    }
    let m = /^include_directories\[\s*(\d+)\] = "(.*)"$/.exec(line);
    if (m) {
      dirs[Number(m[1])] = m[2]!;
      continue;
    }
    m = /^file_names\[\s*(\d+)\]:$/.exec(line);
    if (m) {
      pendingFile = Number(m[1]);
      continue;
    }
    m = /^\s+name: "(.*)"$/.exec(line);
    if (m && pendingFile !== undefined) {
      files[pendingFile] = m[1]!;
      continue;
    }
    m = /^\s+dir_index: (\d+)$/.exec(line);
    if (m && pendingFile !== undefined) {
      const name = files[pendingFile]!;
      files[pendingFile] = isAbsolute(name) ? name : join(dirs[Number(m[1])] ?? "", name);
      pendingFile = undefined;
      continue;
    }
    m = /^0x([0-9a-f]+)\s+(\d+)\s+\d+\s+(\d+)\s.*$/.exec(line);
    if (!m) continue;
    const address = parseInt(m[1]!, 16);
    if (prev && address > prev.address) ranges.push({ start: prev.address, end: address, file: prev.file, line: prev.line });
    prev = line.includes("end_sequence") ? undefined : { address, file: files[Number(m[3])] ?? "?", line: Number(m[2]) };
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** The bundle's modules by line: its //#region comments, whose paths are relative to the entry's
 *  directory (the bundler's cwd) or a virtual module's id. The source map leaves out what the
 *  bundler generates or converts: JSON modules, CommonJS wrappers, namespace objects. */
export function bundleRegions(code: string, entryDir: string): (line: number) => string | undefined {
  const { starts, files } = parseRegions(code, entryDir);
  return (line) => {
    let lo = 0, hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! <= line) lo = mid + 1;
      else hi = mid;
    }
    return lo ? files[lo - 1] : undefined;
  };
}

/** Each region's first line (1-based) and module; undefined: outside any, or the bundler's own. */
function parseRegions(code: string, entryDir: string): { starts: number[]; files: (string | undefined)[]; lines: string[] } {
  const starts: number[] = [], files: (string | undefined)[] = [];
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\/\/#(region|endregion)(?: (.*))?$/.exec(lines[i]!);
    if (!m) continue;
    /* a virtual module's id starts with NUL, which the comment writes as "\0" */
    const id = m[2]?.replace(/^(?:\0|\\0)visaljs-[\w-]+:/, "");
    starts.push(i + 1);
    files.push(m[1] === "endregion" || id === undefined || /^(?:\0|\\0)/.test(id) ? undefined : resolve(entryDir, id));
  }
  return { starts, files, lines };
}

/** The bundle's bytes by module (--emit bundle): what the compiler is given, before any C. The
 *  "use static" files aren't in it (each is a stub of host imports): they come as `staticFiles`. */
export function bundleSizes(code: string, entryDir: string, staticFiles: readonly string[], cwd: string): SizeEntry[] {
  const { starts, files, lines } = parseRegions(code, entryDir);
  const totals = new Map<string, SizeEntry>();
  const add = (group: string, name: string, bytes: number) => {
    const key = `${group}\0${name}`;
    (totals.get(key) ?? totals.set(key, { group, name, bytes: 0 }).get(key)!).bytes += bytes;
  };
  let region = -1;
  for (let i = 0; i < lines.length; i++) {
    if (starts[region + 1] === i + 1) region++;
    const file = region >= 0 ? files[region] : undefined;
    const bytes = Buffer.byteLength(lines[i]!) + 1;
    const { group, name } = jsEntry(file, cwd);
    add(group, name, bytes);
  }
  for (const f of staticFiles) add("\"use static\" files (compiled apart, not in the bundle)", jsModule(f, cwd), statSync(f).size);
  return [...totals.values()];
}

export interface SizeEntry {
  group: string;
  name: string;
  bytes: number;
}

const isCSource = (file: string) => /\.(?:c|cc|h|inc)$/.test(file);

/** A JS file's group and module, the same in both reports. `file`: undefined, or the bundle
 *  itself, for code the bundler generated outside any module. */
function jsEntry(file: string | undefined, cwd: string): { group: string; name: string } {
  if (file === undefined || basename(file) === "bundle.js") return { group: "Bundler glue", name: "rolldown's runtime, imports and exports" };
  const name = jsModule(file, cwd);
  const group = name.startsWith("node:") ? "Node built-ins" : /(?:^|[\\/])node_modules[\\/]/.test(file) ? "npm packages" : "Your code";
  return { group, name };
}

/** A JS file's module: a Node built-in, a package, or the program's own file. */
function jsModule(file: string, cwd: string): string {
  const prelude = relative(preludeDir, file);
  if (!prelude.startsWith("..") && !isAbsolute(prelude)) return `node:${prelude.replace(/\.js$/, "").replaceAll(sep, "/")}`;
  /* the innermost package: a nested copy is another version, named by the package it's under */
  const packages = [...file.matchAll(/(?:^|[\\/])node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/g)].map((m) => m[1]!.replaceAll("\\", "/"));
  if (packages.length) return packages.length > 1 ? `${packages.at(-1)} (in ${packages.at(-2)})` : packages[0]!;
  const rel = relative(cwd, resolve(cwd, file));
  return rel.startsWith("..") ? file : rel;
}

/** An archive member's library and source: lib<name>.a(<i>.o), or a prebuilt <name>-<key>.a(<i>.o),
 *  is the library's i-th source (buildArchive). */
function librarySource(object: string, libraries: readonly CLibrary[]): { library: string; source: string } | undefined {
  const m = /([^\\/]+)\.a\((\d+)\.o\)$/.exec(object);
  if (!m) return undefined;
  const name = m[1]!.replace(/^lib/, "").replace(/-[0-9a-f]{16,}$/, "");
  const lib = libraries.find((l) => l.name === name);
  const src = lib?.sources[Number(m[2])];
  return { library: `lib${name}`, source: src && lib ? relative(commonDir(lib.sources), src) : `${m[2]}.o` };
}

function commonDir(files: readonly string[]): string {
  let dir = files[0] ? resolve(files[0], "..") : "";
  while (dir && !files.every((f) => f.startsWith(dir + sep))) dir = resolve(dir, "..");
  return dir;
}

/* the C emitter's data names (compiler/src/emit/c.ts), after the typed unit's prefix if any */
const EMITTED_DATA: [RegExp, string][] = [
  [/^_\w*?jss_\d+$/, "string constants"],
  [/^_\w*?jsfi_/, "function descriptors"],
  [/^_\w*?jsrl?_\d+$/, "compiled regular expressions"],
  [/^_\w*?mod_/, "module tables (atoms, shapes)"],
];

/** A data symbol's kind: ld64 names literals by their kind ("literal string: …", "16-byte-literal"). */
function dataKind(name: string): string {
  if (name.startsWith("literal string")) return "C string literals";
  if (/^\d+-byte-literal/.test(name)) return "number literals";
  return EMITTED_DATA.find(([re]) => re.test(name))?.[1] ?? "other data";
}

/** Each symbol's bytes, attributed: the program's code to its JS modules, its data by kind, a
 *  library's to its source files. `programObjects` are the program's own objects' base names. */
export function attribute(map: LinkMap, lines: readonly LineRange[], libraries: readonly CLibrary[],
  programObjects: ReadonlySet<string>, cwd: string, regionOf: (bundleLine: number) => string | undefined = () => undefined): SizeEntry[] {
  const totals = new Map<string, SizeEntry>();
  const add = (group: string, name: string, bytes: number) => {
    const key = `${group}\0${name}`;
    const e = totals.get(key) ?? totals.set(key, { group, name, bytes: 0 }).get(key)!;
    e.bytes += bytes;
  };
  const sections = [...map.sections].sort((a, b) => a.address - b.address);
  const sectionOf = (address: number) => sections.find((s) => address >= s.address && address < s.address + s.size)?.name ?? "";
  let next = 0;  /* symbols come by address, as the line ranges do */
  const bySymbol = [...map.symbols].sort((a, b) => a.address - b.address);
  for (const sym of bySymbol) {
    if (sym.size === 0) continue;
    const section = sectionOf(sym.address);
    if (ZEROFILL.has(section)) continue;
    const object = map.objects[sym.object] ?? "";
    const program = programObjects.has(basename(object));
    if (program && section === CODE) {
      while (next < lines.length && lines[next]!.end <= sym.address) next++;
      const files = new Map<string, number>();
      for (let i = next; i < lines.length && lines[i]!.start < sym.address + sym.size; i++) {
        const r = lines[i]!;
        const bytes = Math.min(r.end, sym.address + sym.size) - Math.max(r.start, sym.address);
        const file = basename(r.file) === "bundle.js" ? regionOf(r.line) ?? r.file : r.file;
        if (bytes > 0 && !isCSource(file)) files.set(file, (files.get(file) ?? 0) + bytes);
      }
      /* the runtime's inline functions and padding count for the JS around them, in proportion */
      const js = [...files.values()].reduce((a, b) => a + b, 0);
      const typed = basename(object) === "typed.o";
      if (js === 0) add("Runtime helpers (C, compiled with the program)", typed ? "in the \"use static\" unit" : "in the program", sym.size);
      for (const [file, bytes] of files) {
        const entry = typed ? { group: "\"use static\" files", name: jsModule(file, cwd) } : jsEntry(file, cwd);
        add(entry.group, entry.name, sym.size * bytes / js);
      }
    } else if (program) {
      add("Program data", dataKind(sym.name), sym.size);
    } else if (sym.object === 0) {
      add("Linker", sym.name.replace(/^_+/, ""), sym.size);
    } else {
      const lib = librarySource(object, libraries);
      if (lib) add(lib.library, lib.source, sym.size);
      else add("Linker", object.endsWith(".tbd") ? "stubs for system libraries" : basename(object), sym.size);
    }
  }
  /* sections the map lists no symbols in (stubs, unwind info, the GOT) */
  const listed = new Map<string, number>();
  for (const sym of bySymbol) {
    const s = sectionOf(sym.address);
    listed.set(s, (listed.get(s) ?? 0) + sym.size);
  }
  for (const s of sections) {
    const rest = s.size - (listed.get(s.name) ?? 0);
    if (!ZEROFILL.has(s.name) && rest > 0) add("Linker", s.name, rest);
  }
  return [...totals.values()];
}

/** `binary`'s bytes, attributed: linked with linkMapFlags(`mapFile`) and not stripped, while its
 *  `objects` (the program's own) still exist, for dsymutil reads their debug info. */
export function measureSizes(binary: string, mapFile: string, dsym: string, objects: readonly string[], libraries: readonly CLibrary[],
  bundle?: { code: string; entryDir: string }): SizeEntry[] {
  execFileSync("dsymutil", [binary, "-o", dsym], { stdio: ["ignore", "ignore", "inherit"] });
  const lines = parseLineTable(execFileSync("dwarfdump", ["--debug-line", dsym], { encoding: "utf8", maxBuffer: 1 << 30 }));
  const map = parseLinkMap(readFileSync(mapFile, "latin1"));  /* literal strings' names are raw bytes */
  const regions = bundle ? bundleRegions(bundle.code, bundle.entryDir) : undefined;
  return attribute(map, lines, libraries, new Set(objects.map((o) => basename(o))), process.cwd(), regions);
}

const TOP = 12;

export function formatSizeReport(entries: readonly SizeEntry[], fileBytes: number, all: boolean): string {
  const counted = entries.reduce((a, e) => a + e.bytes, 0);
  return `\nWhere the binary's ${size(counted)} of code and data come from (the file is ${size(fileBytes)}: the rest is page padding and the linker's tables):\n\n${formatEntries(entries, all)}`;
}

export function formatBundleSizes(entries: readonly SizeEntry[], all: boolean): string {
  const counted = entries.reduce((a, e) => a + e.bytes, 0);
  return `\nWhere the program's ${size(counted)} of JavaScript come from:\n\n${formatEntries(entries, all)}`;
}

function formatEntries(entries: readonly SizeEntry[], all: boolean): string {
  const groups = new Map<string, SizeEntry[]>();
  for (const e of entries) (groups.get(e.group) ?? groups.set(e.group, []).get(e.group)!).push(e);
  const sum = (es: readonly SizeEntry[]) => es.reduce((a, e) => a + e.bytes, 0);
  const counted = sum(entries);
  const pct = (bytes: number) => `${(100 * bytes / counted).toFixed(1).padStart(5)}%`;
  const width = Math.min(72, Math.max(...entries.map((e) => e.name.length + 6)));
  const row = (indent: string, name: string, bytes: number) => `${indent}${name.padEnd(width - indent.length)} ${size(Math.round(bytes)).padStart(9)} ${pct(bytes)}\n`;
  let out = "";
  for (const [group, es] of [...groups].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    out += row("  ", group, sum(es));
    const sorted = [...es].sort((a, b) => b.bytes - a.bytes);
    const shown = all ? sorted : sorted.slice(0, TOP);
    for (const e of shown) out += row("      ", e.name, e.bytes);
    if (shown.length < sorted.length) out += row("      ", `${sorted.length - shown.length} more (--verbose lists them)`, sum(sorted.slice(shown.length)));
  }
  return out;
}
