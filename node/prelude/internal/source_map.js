// module.SourceMap: a source map (version 3) read as Node's lib/internal/source_map/source_map.js
// reads it: its mappings decoded (base64 VLQ), findEntry by generated position (0-based) and
// findOrigin (1-based). Linked into programs that name SourceMap; module.js finds it by its symbol.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
const kSourceMap = Symbol.for("visaljs.SourceMap");

const base64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));

class SourceMap {
  #payload;
  #lineLengths;
  #mappings = [];  /* [generatedLine, generatedColumn, source, originalLine, originalColumn, name?], sorted */

  constructor(payload, { lineLengths } = {}) {
    if (payload === null || typeof payload !== "object") {
      const received = payload === null || payload === undefined ? `${payload}` : `type ${typeof payload} (${typeof payload === "string" ? `'${payload}'` : payload})`;
      const e = new TypeError(`The "payload" argument must be of type object. Received ${received}`);
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    this.#payload = JSON.parse(JSON.stringify(payload));
    this.#lineLengths = lineLengths;
    if (payload.sections) {
      for (const section of payload.sections) {
        const inner = new SourceMap(section.map);
        for (const m of inner.#mappings) {
          this.#mappings.push([m[0] + section.offset.line, m[0] === 0 ? m[1] + section.offset.column : m[1], ...m.slice(2)]);
        }
      }
    } else {
      this.#parse(payload);
    }
    this.#mappings.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  get payload() {
    return this.#payload;
  }

  get lineLengths() {
    return this.#lineLengths;
  }

  #parse(map) {
    const sources = (map.sources ?? []).map((s) => (map.sourceRoot ? `${map.sourceRoot.replace(/\/?$/, "/")}${s}` : s));
    const names = map.names ?? [];
    const text = map.mappings ?? "";
    let line = 0, column = 0, source = 0, originalLine = 0, originalColumn = 0, name = 0;
    let nameValue;  /* a segment without a name keeps the last one's, as Node's parser does */
    let i = 0;
    const vlq = () => {
      let result = 0, shift = 0, digit;
      do {
        digit = base64.get(text[i++]);
        if (digit === undefined) throw new Error("Invalid source map: bad VLQ");
        result += (digit & 31) * 2 ** shift;
        shift += 5;
      } while (digit & 32);
      return result & 1 ? -(result - 1) / 2 : result / 2;
    };
    while (i < text.length) {
      const c = text[i];
      if (c === ";") {
        line++;
        column = 0;
        i++;
        continue;
      }
      if (c === ",") {
        i++;
        continue;
      }
      column += vlq();
      if (i >= text.length || text[i] === "," || text[i] === ";") {
        this.#mappings.push([line, column]);
        continue;
      }
      source += vlq();
      originalLine += vlq();
      originalColumn += vlq();
      if (i < text.length && text[i] !== "," && text[i] !== ";") {
        name += vlq();
        nameValue = names[name];
      }
      this.#mappings.push([line, column, sources[source], originalLine, originalColumn, nameValue]);
    }
  }

  /* the last mapping at or before the position, on that line or an earlier one, as Node's */
  #find(line, column) {
    let lo = 0, hi = this.#mappings.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = this.#mappings[mid];
      if (m[0] < line || (m[0] === line && m[1] <= column)) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found === -1) return undefined;
    const m = this.#mappings[found];
    return m.length > 2 ? m : undefined;
  }

  /** findEntry(lineOffset, columnOffset): the mapping there (0-based), or {}. */
  findEntry(lineOffset, columnOffset) {
    const m = this.#find(lineOffset, columnOffset);
    if (!m) return {};
    const entry = { generatedLine: m[0], generatedColumn: m[1], originalSource: m[2], originalLine: m[3], originalColumn: m[4] };
    if (m[5] !== undefined) entry.name = m[5];
    return entry;
  }

  /** findOrigin(lineNumber, columnNumber): where a generated position (1-based) came from, or {}. */
  findOrigin(lineNumber, columnNumber) {
    const m = this.#find(lineNumber - 1, columnNumber - 1);
    if (!m) return {};
    return { name: m[5], fileName: m[2], lineNumber: m[3] + 1 + (lineNumber - 1 - m[0]), columnNumber: m[4] + 1 + (columnNumber - 1 - m[1]) };
  }
}

globalThis[kSourceMap] = SourceMap;
