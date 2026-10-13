// fs.glob, globSync, fs/promises' glob and path.matchesGlob: patterns as Node's (minimatch's, with
// backslashes as path characters): * ? [...] {a,b} {1..3}, extglobs +(…) *(…) ?(…) @(…) !(…), and
// ** for any depth; wildcards don't match names starting with a dot unless the pattern spells the
// dot. Paths come relative to cwd (absolute for an absolute pattern), "." for cwd itself, without
// repeats; exclude prunes by a function or patterns. Linked into programs that name them
// (internal/features.js).
import { fsReaddir, fsStat } from "visaljs:host";
import { Dirent } from "../fs.js";
import { invalidArgType } from "./errors.js";
import { features } from "./features.js";

/* ---- patterns ---------------------------------------------------------------------------------- */

/* {a,b}, {1..3}, {a..c}, nested: the patterns a brace expression stands for */
function expandBraces(pattern) {
  let depth = 0, start = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      const body = pattern.slice(start + 1, i);
      const before = pattern.slice(0, start), after = pattern.slice(i + 1);
      const options = splitTopLevel(body);
      let alternatives;
      if (options.length > 1) alternatives = options;
      else {
        const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body) || /^([a-zA-Z])\.\.([a-zA-Z])$/.exec(body);
        if (!range) continue;  /* not a brace expression: literal braces */
        alternatives = [];
        const numeric = /\d/.test(range[1]);
        const from = numeric ? Number(range[1]) : range[1].charCodeAt(0), to = numeric ? Number(range[2]) : range[2].charCodeAt(0);
        const step = from <= to ? 1 : -1;
        for (let n = from; step > 0 ? n <= to : n >= to; n += step) alternatives.push(numeric ? String(n) : String.fromCharCode(n));
      }
      return alternatives.flatMap((alt) => expandBraces(before + alt + after));
    }
  }
  return [pattern];
}

/* a brace body's alternatives, split at its own commas */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0, last = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{" || body[i] === "(") depth++;
    else if ((body[i] === "}" || body[i] === ")") && depth > 0) depth--;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(body.slice(last));
  return parts;
}

const isMagic = (segment) => /[*?[]|[+*?@!]\(/.test(segment);

/* a segment's pattern as a regular expression's source */
function segmentSource(segment) {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if ("+*?@!".includes(c) && segment[i + 1] === "(") {  /* an extglob: (a|b) with its quantifier */
      let depth = 0, j = i + 1;
      for (; j < segment.length; j++) {
        if (segment[j] === "(") depth++;
        else if (segment[j] === ")" && --depth === 0) break;
      }
      if (j < segment.length) {
        const inner = splitAlternatives(segment.slice(i + 2, j)).map(segmentSource).join("|");
        const rest = segmentSource(segment.slice(j + 1));
        if (c === "!") return out + `(?:(?!(?:${inner})${rest}$)[^/]*)` + rest;
        out += `(?:${inner})` + (c === "+" ? "+" : c === "*" ? "*" : c === "?" ? "?" : "");
        i = j;
        continue;
      }
    }
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end === -1) out += "\\[";
      else {
        let body = segment.slice(i + 1, end);
        const negate = body[0] === "!" || body[0] === "^";
        if (negate) body = body.slice(1);
        body = body.replace(/\[:(\w+):\]/g, (_, name) => POSIX_CLASSES[name] ?? "").replace(/[\\\]^]/g, "\\$&");
        out += `[${negate ? "^" : ""}${body}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return out;
}

const POSIX_CLASSES = { alnum: "a-zA-Z0-9", alpha: "a-zA-Z", digit: "0-9", lower: "a-z", upper: "A-Z", space: " \\t\\r\\n\\v\\f", xdigit: "0-9a-fA-F", word: "\\w" };

function splitAlternatives(body) {
  const parts = [];
  let depth = 0, last = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    else if (body[i] === "|" && depth === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(body.slice(last));
  return parts;
}

/* a pattern's segments: "**", a literal name, or a RegExp; "." and ".." resolved where they can be */
function compile(pattern) {
  const absolute = pattern.startsWith("/");
  const dirOnly = pattern.endsWith("/") && pattern.length > 1;
  const raw = pattern.split("/").filter((s, i, all) => s !== "" && !(s === "." && (i > 0 || all.length > 1)));
  const segments = [];
  for (const s of raw) {
    if (s === ".." && segments.length > 0 && typeof segments.at(-1) === "string" && segments.at(-1) !== ".." && segments.at(-1) !== "**") segments.pop();
    else if (s === "**") {
      if (segments.at(-1) !== "**") segments.push("**");
    } else if (!isMagic(s)) segments.push(s);
    else {
      const dotOk = s.startsWith(".");
      segments.push({ regex: new RegExp(`^${segmentSource(s)}$`), dotOk });
    }
  }
  return { absolute, dirOnly, segments };
}

const matchSegment = (segment, name) =>
  typeof segment === "string" ? segment === name : name !== "." && name !== ".." && (segment.dotOk || name[0] !== ".") && segment.regex.test(name);

/* a path's names against a compiled pattern (path.matchesGlob) */
function matchNames(segments, names, si = 0, ni = 0) {
  if (si === segments.length) return ni === names.length;
  const segment = segments[si];
  if (segment === "**") {
    for (let k = ni; k <= names.length; k++) {
      if (matchNames(segments, names, si + 1, k)) return true;
      if (k < names.length && names[k][0] === ".") return false;
    }
    return false;
  }
  return ni < names.length && matchSegment(segment, names[ni]) && matchNames(segments, names, si + 1, ni + 1);
}

/* ---- the walk --------------------------------------------------------------------------------- */

const UV_DIRENT_DIR = 2, UV_DIRENT_LINK = 3;
const isDirMode = (mode) => (mode & 0o170000) === 0o040000;

function listing(dir) {
  const r = fsReaddir(dir);
  if (typeof r === "number") return [];
  const entries = [];
  for (let i = 0; i < r.length; i += 2) entries.push({ name: r[i], type: r[i + 1] });
  return entries;
}

function isDirectory(path, type) {
  if (type === UV_DIRENT_DIR) return true;
  if (type !== UV_DIRENT_LINK && type !== 0) return false;
  const st = fsStat(path, true);
  return Array.isArray(st) && isDirMode(st[0]);
}

const join = (a, b) => (a === "" ? b : a.endsWith("/") ? a + b : `${a}/${b}`);

function walkPattern(pattern, cwd, excluded, emit) {
  const { absolute, dirOnly, segments } = compile(pattern);
  const base = absolute ? "/" : cwd;
  const seen = new Set();
  /* dir: the file system path; rel: the reported one ("" for the start) */
  const visit = (dir, rel, si, isDir) => {
    const key = `${si}\0${rel}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (si === segments.length) {
      if (!dirOnly || isDir) emit(rel === "" ? (absolute ? "/" : ".") : rel, dir, isDir);
      return;
    }
    const segment = segments[si];
    if (segment === "**") {
      visit(dir, rel, si + 1, isDir);  /* none */
      if (!isDir) return;
      for (const { name, type } of listing(dir)) {
        if (name[0] === ".") continue;
        const path = join(dir, name), childRel = join(rel, name);
        if (excluded(childRel, name, type)) continue;
        /* links are matched, not walked into: no cycles */
        if (type === UV_DIRENT_DIR) visit(path, childRel, si, true);
        else visit(path, childRel, si + 1, type === UV_DIRENT_LINK && isDirectory(path, type));
      }
      return;
    }
    if (!isDir) return;
    if (typeof segment === "string") {
      const path = join(dir, segment);
      const st = fsStat(path, true);
      if (typeof st === "number" && !(segment === ".." && si < segments.length)) return;
      const childRel = join(rel, segment);
      if (excluded(childRel, segment, 0)) return;
      visit(path, childRel, si + 1, typeof st !== "number" && isDirMode(st[0]));
      return;
    }
    for (const { name, type } of listing(dir)) {
      if (!matchSegment(segment, name)) continue;
      const path = join(dir, name), childRel = join(rel, name);
      if (excluded(childRel, name, type)) continue;
      visit(path, childRel, si + 1, isDirectory(path, type));
    }
  };
  visit(base, absolute ? "/" : "", 0, true);
}

function optionsOf(options) {
  if (options === undefined || options === null) options = {};
  else if (typeof options !== "object") throw invalidArgType("options", "of type object", options);
  const cwd = options.cwd === undefined ? process.cwd() : options.cwd instanceof URL ? decodeURIComponent(options.cwd.pathname) : options.cwd;
  if (typeof cwd !== "string") throw invalidArgType("options.cwd", "of type string or an instance of URL", options.cwd);
  const { exclude, withFileTypes } = options;
  if (exclude !== undefined && typeof exclude !== "function" && !Array.isArray(exclude)) {
    throw invalidArgType("options.exclude", "of type function or an instance of Array", exclude);
  }
  return { cwd, exclude, withFileTypes: Boolean(withFileTypes) };
}

function patternsOf(pattern) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  for (const p of patterns) if (typeof p !== "string") throw invalidArgType("pattern", "of type string or an instance of Array", pattern);
  return patterns.flatMap(expandBraces);
}

/* the matches, each once, as strings or Dirents */
function globAll(pattern, options) {
  const { cwd, exclude, withFileTypes } = optionsOf(options);
  const excludePatterns = Array.isArray(exclude) ? exclude.flatMap(expandBraces).map((p) => compile(p).segments) : null;
  const excluded = (rel, name, type) => {
    if (typeof exclude === "function") {
      const slash = rel.lastIndexOf("/");
      return exclude(withFileTypes ? new Dirent(name, type, slash === -1 ? "." : rel.slice(0, slash)) : rel);
    }
    return excludePatterns !== null && excludePatterns.some((segments) => matchNames(segments, rel.split("/")));
  };
  const results = [];
  const seen = new Set();
  for (const p of patternsOf(pattern)) {
    walkPattern(p, cwd, excluded, (rel, path, isDir) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      if (!withFileTypes) results.push(rel);
      else {
        const slash = rel.lastIndexOf("/");
        const st = fsStat(path, false);
        const type = isDir ? UV_DIRENT_DIR : Array.isArray(st) && (st[0] & 0o170000) === 0o120000 ? UV_DIRENT_LINK : 1;
        results.push(new Dirent(slash === -1 ? rel : rel.slice(slash + 1), type, slash === -1 ? "." : rel.slice(0, slash) || "/"));
      }
    });
  }
  return results;
}

function globSync(pattern, options) {
  return globAll(pattern, options);
}

function glob(pattern, options, callback) {
  if (typeof options === "function") [options, callback] = [undefined, options];
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
  let result, error = null;
  try {
    result = globAll(pattern, options);
  } catch (e) {
    error = e;
  }
  process.nextTick(() => (error ? callback(error) : callback(null, result)));
}

/* fs/promises' glob: the matches as an async iterator */
async function* globPromise(pattern, options) {
  yield* globAll(pattern, options);
}

/** path.matchesGlob(path, pattern): whether the path matches, with no file system access. */
function matchesGlob(path, pattern) {
  if (typeof path !== "string") throw invalidArgType("path", "of type string", path);
  if (typeof pattern !== "string") throw invalidArgType("pattern", "of type string", pattern);
  const names = path.split("/").filter((s, i) => s !== "" && !(s === "." && i === 0));
  return expandBraces(pattern).some((p) => matchNames(compile(p).segments, names));
}

Object.assign(features, { globSync, glob, globPromise, matchesGlob });
