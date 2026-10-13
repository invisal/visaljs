// Generates idna_tables.h from Ada's ada_idna.cpp (the single-file IDNA of ada-url/ada, the
// version Node bundles): the UTS #46 mapping table and the label-validity data, packed for C.
// Ada 4 keeps its tables in a raw-DEFLATE blob, read here as Ada reads it: a two-level table
// (64 code points a block) of statuses and UTF-8 mappings, bidi ranges and combining ranges.
//
//   node runtime/third_party/ada-idna/convert.mjs <ada>/src/ada_idna.cpp
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { inflateRawSync } from "node:zlib";

const source = readFileSync(process.argv[2], "utf8");
const version = /\/\/ IDNA\s+([\d.]+)/.exec(source)[1];

/** A `constexpr` number of the source, by name. */
function constant(name) {
  const m = new RegExp(`constexpr\\s+(?:size_t|uint32_t|uint16_t)\\s+${name}\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)u?;`).exec(source);
  if (!m) throw new Error(`no constant ${name}`);
  return Number(m[1]);
}

/** The numbers of the C++ array `name` (comments dropped). */
function array(name) {
  const m = new RegExp(`\\b${name}\\[[^\\]]*\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(source);
  if (!m) throw new Error(`no array ${name}`);
  return m[1].replace(/\/\/.*$/gm, "").match(/0x[0-9a-fA-F]+|\d+/g).map(Number);
}

/* the blob: inflated, little-endian sections at the offsets Ada names */
const blob = inflateRawSync(Buffer.from(array("compressed")));
if (blob.length !== constant("uncompressed_size")) throw new Error("the inflated tables aren't Ada's size");
const section = (name, size) => {
  const at = constant(`off_${name}`), count = constant(`count_${name}`);
  const read = { 1: (i) => blob[at + i], 2: (i) => blob.readUInt16LE(at + 2 * i), 4: (i) => blob.readUInt32LE(at + 4 * i),
    8: (i) => blob.readBigUInt64LE(at + 8 * i) }[size];
  return Array.from({ length: count }, (_, i) => read(i));
};

/* ---- the mapping: each code point's status, and its mapping when mapped ---------------------- */

const VALID = 0xffff, DISALLOWED = 0xfffe, IGNORED = 0, BOOL_FLAG = 0x8000;
const stage1 = section("idna_stage1", 2);
const stage2 = section("idna_stage2", 2);
const boolBlocks = section("idna_bool_blocks", 8);
const utf8 = section("idna_utf8_mappings", 1);
const LOW_END = constant("IDNA_LOW_RANGE_END");
const HIGH_IGNORED_START = constant("IDNA_HIGH_IGNORED_START");
const HIGH_IGNORED_END = constant("IDNA_HIGH_IGNORED_END");

/** Ada's idna_lookup: VALID, DISALLOWED, IGNORED, or an offset into the UTF-8 mappings. */
function lookup(cp) {
  if (cp < LOW_END) {
    const ref = stage1[cp >> 6];
    if (ref & BOOL_FLAG) {
      const bit = (ref & ~BOOL_FLAG) * 64 + (cp & 63);
      return (boolBlocks[bit >> 6] >> BigInt(bit & 63)) & 1n ? VALID : DISALLOWED;
    }
    return stage2[ref + (cp & 63)];
  }
  return cp >= HIGH_IGNORED_START && cp < HIGH_IGNORED_END ? IGNORED : DISALLOWED;
}

/** The code points of the NUL-terminated UTF-8 mapping at `at`. */
function mappingAt(at) {
  let end = at;
  while (utf8[end] !== 0) end++;
  return [...Buffer.from(utf8.slice(at, end)).toString("utf8")].map((c) => c.codePointAt(0));
}

/* ranges of equal status (and, mapped, equal mapping), as idna.c reads them: status 0 ignored,
   1 valid, 2 disallowed, 3 mapped */
const entries = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  const v = lookup(cp);
  const status = v === VALID ? 1 : v === DISALLOWED ? 2 : v === IGNORED ? 0 : 3;
  const mapping = status === 3 ? mappingAt(v) : null;
  const last = entries[entries.length - 1];
  if (last && last.status === status && (status !== 3 || last.mapping.join() === mapping.join())) continue;
  entries.push({ first: cp, status, mapping });
}
const mappings = [];
const keys = [];
const indices = [];
for (const { first, status, mapping } of entries) {
  if (first >= 1 << 21 || (mapping && mapping.length >= 32)) throw new Error("table entry out of range");
  keys.push((first | (status << 21) | ((mapping ? mapping.length : 0) << 23)) >>> 0);
  indices.push(mapping ? mappings.length : 0);
  if (mapping) mappings.push(...mapping);
}
if (mappings.length > 0xffff) throw new Error("mappings past a 16-bit index");

/* ---- label validity ----------------------------------------------------------------------- */

/** Sorted code points as [first, last] ranges. */
function ranges(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 === p) last[1] = p;
    else out.push([p, p]);
  }
  return out;
}

function rows(values, perLine, hex = true) {
  const lines = [];
  for (let i = 0; i < values.length; i += perLine)
    lines.push("    " + values.slice(i, i + perLine).map((v) => (hex ? "0x" + v.toString(16) : String(v))).join(", ") + ",");
  return lines.join("\n");
}

/* the bidi classes: Ada's ranges, in its enum's order (idna.c's enum idna_direction) */
const dirFirst = section("dir_start", 4);
const dirLast = section("dir_final", 4);
const dirClass = section("dir_value", 1);
const combiningFlat = section("combining_flat", 4);
const combining = [];
for (let i = 0; i < combiningFlat.length; i += 2) combining.push([combiningFlat[i], combiningFlat[i + 1]]);
const sets = { combining, ...Object.fromEntries(["virama", "R", "L", "D"].map((n) => [n, ranges(array(`constexpr static uint32_t ${n}`))])) };

const out = [];
out.push(`/* Generated by runtime/third_party/ada-idna/convert.mjs from Ada's ada_idna.cpp (IDNA ${version}). Do not edit.`);
out.push(" * Copyright Yagiz Nizipli and Daniel Lemire; MIT license (LICENSE-MIT). */");
out.push("");
out.push(`#define IDNA_TABLE_COUNT ${keys.length}`);
out.push("/* Each range's first code point (bits 0-20), status (bits 21-22: IDNA_IGNORED, IDNA_VALID,");
out.push(" * IDNA_DISALLOWED, IDNA_MAPPED) and mapping length (bits 23-27), sorted. */");
out.push(`static const uint32_t idna_table[${keys.length}] = {\n${rows(keys, 8)}\n};`);
out.push("/* A mapped range's first code point in idna_mappings. */");
out.push(`static const uint16_t idna_table_index[${indices.length}] = {\n${rows(indices, 12, false)}\n};`);
out.push(`static const uint32_t idna_mappings[${mappings.length}] = {\n${rows(mappings, 10)}\n};`);
out.push("");
out.push("/* Bidi classes (RFC 5893), as Ada's ranges: first, last, class (enum idna_direction). */");
out.push(`#define IDNA_DIR_COUNT ${dirFirst.length}`);
out.push(`static const uint32_t idna_dir_first[${dirFirst.length}] = {\n${rows(dirFirst, 10)}\n};`);
out.push(`static const uint32_t idna_dir_last[${dirLast.length}] = {\n${rows(dirLast, 10)}\n};`);
out.push(`static const uint8_t idna_dir_class[${dirClass.length}] = {\n${rows(dirClass, 24, false)}\n};`);
out.push("");
out.push("/* Code point sets of the label-validity rules, as sorted [first, last] ranges. */");
for (const [name, rs] of Object.entries(sets)) {
  out.push(`#define IDNA_${name.toUpperCase()}_COUNT ${rs.length}`);
  out.push(`static const uint32_t idna_${name.toLowerCase()}[${rs.length}][2] = {\n${rows(rs.flat(), 10)}\n};`.replace(/(0x[0-9a-f]+), (0x[0-9a-f]+),/g, "{ $1, $2 },"));
}
writeFileSync(join(import.meta.dirname, "idna_tables.h"), out.join("\n") + "\n");
