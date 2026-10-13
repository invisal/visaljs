// A .env file's variables, as Node's Dotenv::ParseContent reads them (util.parseEnv, and
// process.loadEnvFile): KEY=value lines, `export ` before a key, # comments, values in double
// quotes (\n becomes a newline, and they may span lines), single quotes or backticks. Linked into
// programs that name parseEnv (internal/features.js).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { validateString } from "./errors.js";
import { features } from "./features.js";

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

function trimSpaces(s) {
  let start = 0;
  let end = s.length;
  while (start < end && isSpace(s[start])) start++;
  while (end > start && isSpace(s[end - 1])) end--;
  return s.slice(start, end);
}

/** The variables, in an object (a later definition replaces an earlier one). */
export function parseDotenv(input) {
  const store = Object.create(null);
  let content = trimSpaces(String(input).replaceAll("\r", ""));
  /* what's left after the next newline, or nothing */
  const afterLine = (from = 0) => {
    const newline = content.indexOf("\n", from);
    return newline === -1 ? null : content.slice(newline + 1);
  };
  while (content.length > 0) {
    if (content[0] === "\n" || content[0] === "#") {  /* an empty line, or a comment */
      content = afterLine() ?? "";
      continue;
    }
    const equalOrNewline = content.search(/[=\n]/);
    if (equalOrNewline === -1 || content[equalOrNewline] === "\n") {  /* no `=` on the line */
      const rest = afterLine();
      if (rest === null) break;
      content = trimSpaces(rest);
      continue;
    }
    let key = trimSpaces(content.slice(0, equalOrNewline));
    content = content.slice(equalOrNewline + 1);
    if (content.length === 0 || content[0] === "\n") {
      store[key] = "";
      continue;
    }
    content = trimSpaces(content);
    if (key.length === 0) {
      const rest = afterLine();
      if (rest === null) break;
      content = trimSpaces(rest);
      continue;
    }
    if (key.startsWith("export ")) key = trimSpaces(key.slice(7));
    if (content.length === 0 || content[0] === "\n") {
      store[key] = "";
      continue;
    }
    content = trimSpaces(content);
    const quote = content[0];
    if (quote === '"') {
      const closing = content.indexOf('"', 1);
      if (closing !== -1) {
        store[key] = content.slice(1, closing).replaceAll("\\n", "\n");
        content = afterLine(closing + 1) ?? "";
        continue;
      }
    }
    if (quote === "'" || quote === '"' || quote === "`") {
      const closing = content.indexOf(quote, 1);
      if (closing === -1) {  /* unclosed: the rest of the line, quote and all */
        const newline = content.indexOf("\n");
        if (newline === -1) {
          store[key] = content;
          break;
        }
        store[key] = content.slice(0, newline);
        content = content.slice(newline);
      } else {
        store[key] = content.slice(1, closing);
        content = afterLine(closing + 1) ?? "";
      }
    } else {
      const newline = content.indexOf("\n");
      let value = newline === -1 ? content : content.slice(0, newline);
      const hash = value.indexOf("#");
      if (hash !== -1) value = value.slice(0, hash);
      store[key] = trimSpaces(value);
      content = newline === -1 ? "" : content.slice(newline + 1);
    }
    content = trimSpaces(content);
  }
  return store;
}

features.parseEnv = (content) => {
  validateString(content, "content");
  return { ...parseDotenv(content) };
};
