// Source maps (v3) from the bundler: bundle positions back to the original
// files and names, for diagnostics, #line directives and function names.
import type { Loc } from "./ast.ts";

interface RawSourceMap {
  sources: (string | null)[];
  names?: string[];
  mappings: string;
}

/** A segment: generated column, then (when mapped) source, original line, column and name
 *  (-1: none). All 0-based. */
type Segment = [genColumn: number, source: number, line: number, column: number, name: number];

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

export class SourceMap {
  private readonly lines: Segment[][] = [];
  private readonly sources: string[];
  private readonly rawSources: string[];
  private readonly names: string[];

  /** `resolveSource` turns a `sources` entry into the file name locations should carry. */
  constructor(json: string, resolveSource: (source: string) => string) {
    const raw = JSON.parse(json) as RawSourceMap;
    this.rawSources = raw.sources.map((s) => s ?? "");
    this.sources = this.rawSources.map(resolveSource);
    this.names = raw.names ?? [];
    let source = 0, line = 0, column = 0, name = 0;
    for (const text of raw.mappings.split(";")) {
      const segments: Segment[] = [];
      let genColumn = 0;
      for (const seg of text.split(",")) {
        if (seg === "") continue;
        const f = decodeVlq(seg);
        genColumn += f[0]!;
        if (f.length < 4) {
          segments.push([genColumn, -1, 0, 0, -1]);
          continue;
        }
        source += f[1]!;
        line += f[2]!;
        column += f[3]!;
        if (f.length >= 5) name += f[4]!;
        segments.push([genColumn, source, line, column, f.length >= 5 ? name : -1]);
      }
      segments.sort((a, b) => a[0] - b[0]);
      this.lines.push(segments);
    }
  }

  /** The original location of a 1-based bundle position: the segment at or before it on
   *  its line (else the line's first), or null where the bundler generated the code. */
  original(line: number, column: number): Loc | null {
    const seg = this.segmentAt(line, column, false);
    if (!seg || seg[1] < 0) return null;
    return { file: this.sources[seg[1]]!, line: seg[2] + 1, column: seg[3] + 1 };
  }

  /** The original file of a 1-based bundle position, as the map's `sources` names it (absolute
   *  paths from the driver), or null. */
  originalSource(line: number, column: number): string | null {
    const seg = this.segmentAt(line, column, false);
    return seg && seg[1] >= 0 ? this.rawSources[seg[1]]! : null;
  }

  /** The original name of the identifier starting exactly at a 1-based bundle position. */
  originalName(line: number, column: number): string | undefined {
    const seg = this.segmentAt(line, column, true);
    return seg && seg[4] >= 0 ? this.names[seg[4]] : undefined;
  }

  private segmentAt(line: number, column: number, exact: boolean): Segment | undefined {
    const segments = this.lines[line - 1];
    if (!segments || segments.length === 0) return undefined;
    const col = column - 1;
    let lo = 0, hi = segments.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid]![0] <= col) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (exact) return found >= 0 && segments[found]![0] === col ? segments[found] : undefined;
    return segments[found >= 0 ? found : 0];
  }
}

function decodeVlq(s: string): number[] {
  const out: number[] = [];
  let value = 0, shift = 0;
  for (const c of s) {
    const digit = DIGIT.get(c);
    if (digit === undefined) throw new Error(`invalid source map mapping '${s}'`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}
