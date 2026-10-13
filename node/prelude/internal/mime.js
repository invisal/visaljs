// util.MIMEType and util.MIMEParams: Node's internal/mime.js (WHATWG MIME Sniffing's parsing):
// type and subtype lowercased, parameters parsed when first used, first of each name kept,
// values quoted when serialized if they need it. Linked into programs that name them
// (internal/features.js): util's MIMEType and MIMEParams build these classes.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { MIMEParams as MIMEParamsWrapper, MIMEType as MIMETypeWrapper } from "../util.js";
import { codeError } from "./errors.js";
import { provideClass } from "./features.js";

const NOT_HTTP_TOKEN_CODE_POINT = /[^!#$%&'*+\-.^_`|~A-Za-z0-9]/g;
const NOT_HTTP_QUOTED_STRING_CODE_POINT = /[^\t -~\u0080-ÿ]/g;
const END_BEGINNING_WHITESPACE = /[^\r\n\t ]|$/;
const START_ENDING_WHITESPACE = /[\r\n\t ]*$/;
const EQUALS_SEMICOLON_OR_END = /[;=]|$/;
const QUOTED_VALUE_PATTERN = /^(?:([\\]$)|[\\][\s\S]|[^"])*(?:(")|$)/u;

function invalidMimeSyntax(production, str, invalidIndex) {
  const at = invalidIndex !== -1 ? ` at ${invalidIndex}` : "";
  return codeError(TypeError, "ERR_INVALID_MIME_SYNTAX", `The MIME syntax for a ${production} in "${str}" is invalid` + at);
}

function toASCIILower(str) {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    result += char >= "A" && char <= "Z" ? char.toLowerCase() : char;
  }
  return result;
}

function parseTypeAndSubtype(str) {
  let position = str.search(END_BEGINNING_WHITESPACE);
  const typeEnd = str.indexOf("/", position);
  const trimmedType = typeEnd === -1 ? str.slice(position) : str.slice(position, typeEnd);
  const invalidTypeIndex = trimmedType.search(NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedType === "" || invalidTypeIndex !== -1 || typeEnd === -1) throw invalidMimeSyntax("type", str, invalidTypeIndex);
  position = typeEnd + 1;
  const type = toASCIILower(trimmedType);
  const subtypeEnd = str.indexOf(";", position);
  const rawSubtype = subtypeEnd === -1 ? str.slice(position) : str.slice(position, subtypeEnd);
  position += rawSubtype.length;
  if (subtypeEnd !== -1) position += 1;
  const trimmedSubtype = rawSubtype.slice(0, rawSubtype.search(START_ENDING_WHITESPACE));
  const invalidSubtypeIndex = trimmedSubtype.search(NOT_HTTP_TOKEN_CODE_POINT);
  if (trimmedSubtype === "" || invalidSubtypeIndex !== -1) throw invalidMimeSyntax("subtype", str, invalidSubtypeIndex);
  return { type, subtype: toASCIILower(trimmedSubtype), parametersStringIndex: position };
}

function removeBackslashes(str) {
  let ret = "";
  let i;
  for (i = 0; i < str.length - 1; i++) {
    const c = str[i];
    if (c === "\\") {
      i++;
      ret += str[i];
    } else ret += c;
  }
  if (i === str.length - 1) ret += str[i];
  return ret;
}

function escapeQuoteOrSolidus(str) {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    result += char === '"' || char === "\\" ? `\\${char}` : char;
  }
  return result;
}

function encode(value) {
  if (value.length === 0) return '""';
  if (value.search(NOT_HTTP_TOKEN_CODE_POINT) === -1) return value;
  return `"${escapeQuoteOrSolidus(value)}"`;
}

let instantiateMimeParams;

class MIMEParams {
  #data = new Map();
  #processed = true;  /* a MIMEType's are parsed when first used */
  #string = null;

  static {
    instantiateMimeParams = (str) => {
      const instance = new MIMEParams();
      instance.#string = str;
      instance.#processed = false;
      return instance;
    };
  }

  delete(name) {
    this.#parse();
    this.#data.delete(name);
  }

  get(name) {
    this.#parse();
    return this.#data.has(name) ? this.#data.get(name) : null;
  }

  has(name) {
    this.#parse();
    return this.#data.has(name);
  }

  set(name, value) {
    this.#parse();
    name = `${name}`;
    value = `${value}`;
    const invalidNameIndex = name.search(NOT_HTTP_TOKEN_CODE_POINT);
    if (name.length === 0 || invalidNameIndex !== -1) throw invalidMimeSyntax("parameter name", name, invalidNameIndex);
    const invalidValueIndex = value.search(NOT_HTTP_QUOTED_STRING_CODE_POINT);
    if (invalidValueIndex !== -1) throw invalidMimeSyntax("parameter value", value, invalidValueIndex);
    this.#data.set(name, value);
  }

  entries() {
    this.#parse();
    return this.#data.entries();
  }

  keys() {
    this.#parse();
    return this.#data.keys();
  }

  values() {
    this.#parse();
    return this.#data.values();
  }

  toString() {
    this.#parse();
    let ret = "";
    for (const [key, value] of this.#data) {
      if (ret.length) ret += ";";
      ret += `${key}=${encode(value)}`;
    }
    return ret;
  }

  #parse() {
    if (this.#processed) return;
    const paramsMap = this.#data;
    let position = 0;
    const str = this.#string;
    const endOfSource = str.slice(position).search(START_ENDING_WHITESPACE) + position;
    while (position < endOfSource) {
      position += str.slice(position).search(END_BEGINNING_WHITESPACE);
      const afterParameterName = str.slice(position).search(EQUALS_SEMICOLON_OR_END) + position;
      const parameterString = toASCIILower(str.slice(position, afterParameterName));
      position = afterParameterName;
      if (position < endOfSource) {
        const char = str.charAt(position);
        position += 1;
        if (char === ";") continue;  /* a parameter without a value */
      }
      if (position >= endOfSource) break;
      const char = str.charAt(position);
      let parameterValue;
      if (char === '"') {
        position += 1;
        /* to the closing quote, or the end ($1: an unmatched backslash, $2: the closing quote) */
        const insideMatch = QUOTED_VALUE_PATTERN.exec(str.slice(position));
        position += insideMatch[0].length;
        const inside = insideMatch[1] || insideMatch[2] ? insideMatch[0].slice(0, -1) : insideMatch[0];
        parameterValue = removeBackslashes(inside);
        if (insideMatch[1]) parameterValue += "\\";
      } else {
        const valueEnd = str.indexOf(";", position);
        const rawValue = valueEnd === -1 ? str.slice(position) : str.slice(position, valueEnd);
        position += rawValue.length;
        const trimmedValue = rawValue.slice(0, rawValue.search(START_ENDING_WHITESPACE));
        if (trimmedValue === "") continue;
        parameterValue = trimmedValue;
      }
      if (parameterString !== "" && parameterString.search(NOT_HTTP_TOKEN_CODE_POINT) === -1 &&
        parameterValue.search(NOT_HTTP_QUOTED_STRING_CODE_POINT) === -1 && !paramsMap.has(parameterString)) {
        paramsMap.set(parameterString, parameterValue);
      }
      position++;
    }
    this.#data = paramsMap;
    this.#processed = true;
  }
}

const stringifyParams = MIMEParams.prototype.toString;
Object.defineProperty(MIMEParams.prototype, Symbol.iterator, { configurable: true, value: MIMEParams.prototype.entries, writable: true });
Object.defineProperty(MIMEParams.prototype, "toJSON", { configurable: true, value: stringifyParams, writable: true });

class MIMEType {
  #type;
  #subtype;
  #parameters;

  constructor(string) {
    string = `${string}`;
    const data = parseTypeAndSubtype(string);
    this.#type = data.type;
    this.#subtype = data.subtype;
    this.#parameters = instantiateMimeParams(string.slice(data.parametersStringIndex));
  }

  get type() {
    return this.#type;
  }

  set type(v) {
    v = `${v}`;
    const invalidTypeIndex = v.search(NOT_HTTP_TOKEN_CODE_POINT);
    if (v.length === 0 || invalidTypeIndex !== -1) throw invalidMimeSyntax("type", v, invalidTypeIndex);
    this.#type = toASCIILower(v);
  }

  get subtype() {
    return this.#subtype;
  }

  set subtype(v) {
    v = `${v}`;
    const invalidSubtypeIndex = v.search(NOT_HTTP_TOKEN_CODE_POINT);
    if (v.length === 0 || invalidSubtypeIndex !== -1) throw invalidMimeSyntax("subtype", v, invalidSubtypeIndex);
    this.#subtype = toASCIILower(v);
  }

  get essence() {
    return `${this.#type}/${this.#subtype}`;
  }

  get params() {
    return this.#parameters;
  }

  toString() {
    let ret = `${this.#type}/${this.#subtype}`;
    const paramStr = stringifyParams.call(this.#parameters);
    if (paramStr.length) ret += `;${paramStr}`;
    return ret;
  }
}

Object.defineProperty(MIMEType.prototype, "toJSON", { configurable: true, value: MIMEType.prototype.toString, writable: true });

provideClass(MIMEParamsWrapper, MIMEParams);
provideClass(MIMETypeWrapper, MIMEType);
