// Source maps (v3) from the bundler: bundle positions back to the original
// files and names, for diagnostics, #line directives and function names.
import type { Loc } from "./ast.ts";

interface RawSourceMap {
  sources: (string | null)[];
  names?: string[];
  mappings: string;
}

/* A segment is FIELDS numbers in `segments`: generated column, then (when mapped) source,
 * original line, column and name (-1: none). All 0-based. A bundle's map has tens of millions of
 * them: one typed array, not an array each. */
const FIELDS = 5;
const GEN_COLUMN = 0, SOURCE = 1, LINE = 2, COLUMN = 3, NAME = 4;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) DIGIT[BASE64.charCodeAt(i)] = i;
const COMMA = 44, SEMICOLON = 59;

export class SourceMap {
  private segments = new Int32Array(1024 * FIELDS);
  /** Line n's segments: from lineStarts[n] to lineStarts[n + 1] (segment indexes). */
  private readonly lineStarts: number[] = [0];
  private readonly sources: string[];
  private readonly rawSources: string[];
  private readonly names: string[];

  /** `resolveSource` turns a `sources` entry into the file name locations should carry. */
  constructor(json: string, resolveSource: (source: string) => string) {
    const raw = JSON.parse(json) as RawSourceMap;
    this.rawSources = raw.sources.map((s) => s ?? "");
    this.sources = this.rawSources.map(resolveSource);
    this.names = raw.names ?? [];
    const mappings = raw.mappings;
    const fields = [0, 0, 0, 0, 0];
    let count = 0, lineStart = 0, genColumn = 0, source = 0, line = 0, column = 0, name = 0;
    for (let i = 0; i <= mappings.length; i++) {
      const c = i < mappings.length ? mappings.charCodeAt(i) : SEMICOLON;
      if (c !== COMMA && c !== SEMICOLON) continue;
      const n = decodeVlq(mappings, lineStart, i, fields);
      if (n > 0) {
        genColumn += fields[0]!;
        if (n >= 4) {
          source += fields[1]!;
          line += fields[2]!;
          column += fields[3]!;
          if (n >= 5) name += fields[4]!;
        }
        if ((count + 1) * FIELDS > this.segments.length) {
          const grown = new Int32Array(this.segments.length * 2);
          grown.set(this.segments);
          this.segments = grown;
        }
        const at = count++ * FIELDS;
        this.segments[at + GEN_COLUMN] = genColumn;
        this.segments[at + SOURCE] = n >= 4 ? source : -1;
        this.segments[at + LINE] = n >= 4 ? line : 0;
        this.segments[at + COLUMN] = n >= 4 ? column : 0;
        this.segments[at + NAME] = n >= 5 ? name : -1;
      }
      lineStart = i + 1;
      if (c === SEMICOLON) {
        this.sortLine(this.lineStarts[this.lineStarts.length - 1]!, count);
        this.lineStarts.push(count);
        genColumn = 0;
      }
    }
    this.segments = this.segments.slice(0, count * FIELDS);
  }

  /** The original location of a 1-based bundle position: the segment at or before it on
   *  its line (else the line's first), or null where the bundler generated the code. */
  original(line: number, column: number): Loc | null {
    const at = this.segmentAt(line, column, false);
    if (at < 0 || this.segments[at + SOURCE]! < 0) return null;
    return { file: this.sources[this.segments[at + SOURCE]!]!, line: this.segments[at + LINE]! + 1, column: this.segments[at + COLUMN]! + 1 };
  }

  /** The original file of a 1-based bundle position, as the map's `sources` names it (absolute
   *  paths from the driver), or null. */
  originalSource(line: number, column: number): string | null {
    const at = this.segmentAt(line, column, false);
    return at >= 0 && this.segments[at + SOURCE]! >= 0 ? this.rawSources[this.segments[at + SOURCE]!]! : null;
  }

  /** The original name of the identifier starting exactly at a 1-based bundle position. */
  originalName(line: number, column: number): string | undefined {
    const at = this.segmentAt(line, column, true);
    return at >= 0 && this.segments[at + NAME]! >= 0 ? this.names[this.segments[at + NAME]!] : undefined;
  }

  /** The offset in `segments` of the segment for a 1-based position, or -1. */
  private segmentAt(line: number, column: number, exact: boolean): number {
    if (line < 1 || line >= this.lineStarts.length) return -1;
    const first = this.lineStarts[line - 1]!, last = this.lineStarts[line]! - 1;
    if (last < first) return -1;
    const col = column - 1;
    let lo = first, hi = last, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segments[mid * FIELDS + GEN_COLUMN]! <= col) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (exact) return found >= 0 && this.segments[found * FIELDS + GEN_COLUMN] === col ? found * FIELDS : -1;
    return (found >= 0 ? found : first) * FIELDS;
  }

  /** Segments `from` to `to` in generated column order (maps almost always have them so). */
  private sortLine(from: number, to: number) {
    let sorted = true;
    for (let s = from + 1; s < to && sorted; s++) sorted = this.segments[(s - 1) * FIELDS]! <= this.segments[s * FIELDS]!;
    if (sorted) return;
    const line = [...Array(to - from).keys()].map((k) => this.segments.slice((from + k) * FIELDS, (from + k + 1) * FIELDS));
    line.sort((a, b) => a[GEN_COLUMN]! - b[GEN_COLUMN]!);
    line.forEach((seg, k) => this.segments.set(seg, (from + k) * FIELDS));
  }
}

/** Decodes the VLQ fields of mappings[from, to) into `out`; returns how many there are. */
function decodeVlq(mappings: string, from: number, to: number, out: number[]): number {
  let n = 0, value = 0, shift = 0;
  for (let i = from; i < to; i++) {
    const c = mappings.charCodeAt(i);
    const digit = c < 128 ? DIGIT[c]! : -1;
    if (digit < 0) throw new Error(`invalid source map mapping '${mappings.slice(from, to)}'`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      if (n < out.length) out[n] = value & 1 ? -(value >>> 1) : value >>> 1;
      n++;
      value = 0;
      shift = 0;
    }
  }
  return n;
}
