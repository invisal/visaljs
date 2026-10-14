// FormData, as Node's (undici's lib/web/fetch/formdata.js), and what Request and Response do with
// one: a FormData body is sent as multipart/form-data (body.js's extractBody), and formData()
// parses a multipart/form-data or application/x-www-form-urlencoded body (formdata-parser.js).
// The fetch component (runtime/src/fetch.c) calls the two through fetchFormDataHooks. A program
// that names FormData or formData gets this module first (implicitModules in node/index.ts).
// Ported from Node.js's undici (Copyright Node.js contributors and undici contributors, MIT):
// node/third_party/nodejs/LICENSE.
import { fetchFormDataHooks } from "visaljs:host";
import { Buffer } from "../buffer.js";
import { MIMEType } from "./mime.js";

const kInspect = Symbol.for("nodejs.util.inspect.custom");
const fileName = Object.getOwnPropertyDescriptor(File.prototype, "name").get;
const isBlob = (value) => value instanceof Blob;

function isFile(value) {
  try {
    fileName.call(value);
    return true;
  } catch {
    return false;
  }
}

/** webidl's USVString: a string, its lone surrogates replaced */
const usv = (value) => String(value).toWellFormed();

function argumentLengthCheck(args, min, prefix) {
  if (args.length < min) {
    throw new TypeError(`${prefix}: ${min} argument${min === 1 ? "" : "s"} required, but${args.length ? " only" : ""} ${args.length} found.`);
  }
}

/** create an entry: a Blob value becomes a File ("blob", or the filename given) */
function makeEntry(name, value, filename) {
  if (typeof value !== "string") {
    if (!isFile(value)) value = new File([value], "blob", { type: value.type });
    if (filename !== undefined) value = new File([value], filename, { type: value.type, lastModified: value.lastModified });
  }
  return { name, value };
}

function entryArguments(args, prefix) {
  argumentLengthCheck(args, 2, prefix);
  const name = usv(args[0]);
  let value = args[1];
  let filename = args[2];
  if (args.length === 3 || isBlob(value)) {
    if (!isBlob(value)) throw new TypeError(`${prefix}: Expected value ("${JSON.stringify(value)}") to be an instance of Blob.`);
    if (filename !== undefined) filename = usv(filename);
  } else {
    value = usv(value);
  }
  return makeEntry(name, value, filename);
}

const states = new WeakMap();
function stateOf(formData, prefix) {
  const state = states.get(formData);
  if (state === undefined) throw new TypeError(`${prefix}: Illegal invocation`);
  return state;
}

class FormData {
  constructor(form = undefined) {
    if (form !== undefined) throw new TypeError("FormData constructor: Argument 1 could not be converted to: undefined.");
    states.set(this, { entries: [] });
  }

  append(name, value, filename = undefined) {
    const state = stateOf(this, "FormData.append");
    state.entries.push(entryArguments([name, value, filename].slice(0, arguments.length), "FormData.append"));
  }

  delete(name) {
    const state = stateOf(this, "FormData.delete");
    argumentLengthCheck(arguments, 1, "FormData.delete");
    name = usv(name);
    state.entries = state.entries.filter((entry) => entry.name !== name);
  }

  get(name) {
    const state = stateOf(this, "FormData.get");
    argumentLengthCheck(arguments, 1, "FormData.get");
    name = usv(name);
    const entry = state.entries.find((e) => e.name === name);
    return entry === undefined ? null : entry.value;
  }

  getAll(name) {
    const state = stateOf(this, "FormData.getAll");
    argumentLengthCheck(arguments, 1, "FormData.getAll");
    name = usv(name);
    return state.entries.filter((entry) => entry.name === name).map((entry) => entry.value);
  }

  has(name) {
    const state = stateOf(this, "FormData.has");
    argumentLengthCheck(arguments, 1, "FormData.has");
    name = usv(name);
    return state.entries.some((entry) => entry.name === name);
  }

  set(name, value, filename = undefined) {
    const state = stateOf(this, "FormData.set");
    const entry = entryArguments([name, value, filename].slice(0, arguments.length), "FormData.set");
    const idx = state.entries.findIndex((e) => e.name === entry.name);
    if (idx === -1) state.entries.push(entry);
    else state.entries = [...state.entries.slice(0, idx), entry, ...state.entries.slice(idx + 1).filter((e) => e.name !== entry.name)];
  }

  *entries() {
    const state = stateOf(this, "FormData.entries");
    for (let i = 0; i < state.entries.length; i++) yield [state.entries[i].name, state.entries[i].value];
  }

  *keys() {
    for (const [name] of this.entries()) yield name;
  }

  *values() {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(callbackFn, thisArg = undefined) {
    stateOf(this, "FormData.forEach");
    argumentLengthCheck(arguments, 1, "FormData.forEach");
    if (typeof callbackFn !== "function") {
      throw new TypeError("Failed to execute 'forEach' on 'FormData': parameter 1 is not of type 'Function'.");
    }
    for (const [key, value] of this) Reflect.apply(callbackFn, thisArg, [value, key, this]);
  }

  [kInspect](depth, options, inspect) {
    const state = { __proto__: null };
    for (const { name, value } of stateOf(this, "FormData").entries) {
      if (!(name in state)) state[name] = value;
      else if (Array.isArray(state[name])) state[name].push(value);
      else state[name] = [state[name], value];
    }
    const output = inspect(state, { ...options, depth: options.depth ?? depth });
    /* without "[Object: null prototype]" */
    return `FormData ${output.slice(output.indexOf("]") + 2)}`;
  }
}
FormData.prototype[Symbol.iterator] = FormData.prototype.entries;
for (const key of ["append", "delete", "get", "getAll", "has", "set", "entries", "keys", "values", "forEach"]) {
  Object.defineProperty(FormData.prototype, key, { enumerable: true });
}
Object.defineProperty(FormData.prototype, Symbol.toStringTag, { value: "FormData", configurable: true });

/* ---- multipart/form-data: a FormData body (body.js's extractBody) ------------------------------ */

const encoder = new TextEncoder();
const escape = (str) => str.replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22");
const normalizeLinefeeds = (value) => value.replace(/\r?\n|\r/g, "\r\n");

/** A FormData's body as a Blob and its Content-Type; undefined for anything else. */
function serialize(object) {
  const state = states.get(object);
  if (state === undefined) return undefined;
  const boundary = `----formdata-undici-0${`${Math.floor(Math.random() * 1e11)}`.padStart(11, "0")}`;
  const prefix = `--${boundary}\r\nContent-Disposition: form-data`;
  const parts = [];
  for (const { name, value } of state.entries) {
    if (typeof value === "string") {
      parts.push(encoder.encode(`${prefix}; name="${escape(normalizeLinefeeds(name))}"\r\n\r\n${normalizeLinefeeds(value)}\r\n`));
    } else {
      parts.push(encoder.encode(`${prefix}; name="${escape(normalizeLinefeeds(name))}"` +
        (value.name ? `; filename="${escape(value.name)}"` : "") + "\r\n" +
        `Content-Type: ${value.type || "application/octet-stream"}\r\n\r\n`), value, encoder.encode("\r\n"));
    }
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  return [new Blob(parts), `multipart/form-data; boundary=${boundary}`];
}

/* ---- formData(): parsing (formdata-parser.js) --------------------------------------------------- */

const decoder = new TextDecoder();
const decoderIgnoreBOM = new TextDecoder("utf-8", { ignoreBOM: true });
const HTTP_TOKEN_CODEPOINTS = /^[-!#$%&'*+.^_|~A-Za-z0-9]+$/u;
const dd = Buffer.from("--");

const parsingError = (cause) => new TypeError("Failed to parse body as FormData.", { cause: new TypeError(cause) });
const isCTL = (char) => char <= 0x1f || char === 0x7f;
const isTSpecial = (char) => char === 0x28 || char === 0x29 || char === 0x3c || char === 0x3e || char === 0x40 || char === 0x2c ||
  char === 0x3b || char === 0x3a || char === 0x5c || char === 0x22 || char === 0x2f || char === 0x5b || char === 0x5d || char === 0x3f ||
  char === 0x3d;
const isToken = (char) => char <= 0x7f && char !== 0x20 && char !== 0x09 && !isCTL(char) && !isTSpecial(char);

function isAsciiString(chars) {
  for (let i = 0; i < chars.length; ++i) if ((chars.charCodeAt(i) & ~0x7f) !== 0) return false;
  return true;
}

function collectASequenceOfBytes(condition, input, position) {
  let start = position.position;
  while (start < input.length && condition(input[start])) ++start;
  return input.subarray(position.position, (position.position = start));
}

function removeChars(buf, leading, trailing, predicate) {
  let lead = 0;
  let trail = buf.length - 1;
  if (leading) while (lead < buf.length && predicate(buf[lead])) lead++;
  if (trailing) while (trail > 0 && predicate(buf[trail])) trail--;
  return lead === 0 && trail === buf.length - 1 ? buf : buf.subarray(lead, trail + 1);
}

function bufferStartsWith(buffer, start, position) {
  if (buffer.length < start.length) return false;
  for (let i = 0; i < start.length; i++) if (start[i] !== buffer[position.position + i]) return false;
  return true;
}

const isomorphicDecode = (bytes) => Buffer.from(bytes).toString("latin1");

function parseContentDispositionAttribute(input, position) {
  if (input[position.position] === 0x3b) position.position++;
  collectASequenceOfBytes((char) => char === 0x20 || char === 0x09, input, position);
  const attributeName = collectASequenceOfBytes((char) => isToken(char) && char !== 0x3d && char !== 0x2a, input, position);
  if (attributeName.length === 0) return null;
  const attrNameStr = attributeName.toString("ascii").toLowerCase();
  const isExtended = input[position.position] === 0x2a;
  if (isExtended) position.position++;
  if (input[position.position] !== 0x3d) return null;
  position.position++;
  collectASequenceOfBytes((char) => char === 0x20 || char === 0x09, input, position);
  let value;
  if (isExtended) {
    const headerValue = collectASequenceOfBytes((char) => char !== 0x20 && char !== 0x0d && char !== 0x0a && char !== 0x3b, input, position);
    if ((headerValue[0] !== 0x75 && headerValue[0] !== 0x55) || (headerValue[1] !== 0x74 && headerValue[1] !== 0x54) ||
      (headerValue[2] !== 0x66 && headerValue[2] !== 0x46) || headerValue[3] !== 0x2d || headerValue[4] !== 0x38) {
      throw parsingError("unknown encoding, expected utf-8''");
    }
    value = decodeURIComponent(decoder.decode(headerValue.subarray(7)));
  } else if (input[position.position] === 0x22) {
    position.position++;
    const quotedValue = collectASequenceOfBytes((char) => char !== 0x0a && char !== 0x0d && char !== 0x22, input, position);
    if (input[position.position] !== 0x22) throw parsingError("Closing quote not found");
    position.position++;
    value = decoder.decode(quotedValue).replace(/%0A/ig, "\n").replace(/%0D/ig, "\r").replace(/%22/g, '"');
  } else {
    value = decoder.decode(collectASequenceOfBytes((char) => isToken(char) && char !== 0x3b, input, position));
  }
  return { name: attrNameStr, value, extended: isExtended };
}

function parseMultipartFormDataHeaders(input, position) {
  let name = null;
  let filename = null;
  let contentType = null;
  let encoding = null;
  while (true) {
    if (input[position.position] === 0x0d && input[position.position + 1] === 0x0a) {
      if (name === null) throw parsingError("header name is null");
      return { name, filename, contentType, encoding };
    }
    let headerName = collectASequenceOfBytes((char) => char !== 0x0a && char !== 0x0d && char !== 0x3a, input, position);
    headerName = removeChars(headerName, true, true, (char) => char === 0x9 || char === 0x20);
    if (!HTTP_TOKEN_CODEPOINTS.test(headerName.toString())) throw parsingError("header name does not match the field-name token production");
    if (input[position.position] !== 0x3a) throw parsingError("expected :");
    position.position++;
    collectASequenceOfBytes((char) => char === 0x20 || char === 0x09, input, position);
    switch (headerName.toString("latin1").toLowerCase()) {
      case "content-disposition": {
        name = filename = null;
        let filenameIsExtended = false;
        const dispositionType = collectASequenceOfBytes((char) => isToken(char), input, position);
        if (dispositionType.toString("ascii").toLowerCase() !== "form-data") throw parsingError("expected form-data for content-disposition header");
        while (position.position < input.length && (input[position.position] !== 0x0d || input[position.position + 1] !== 0x0a)) {
          const attribute = parseContentDispositionAttribute(input, position);
          if (!attribute) break;
          if (attribute.name === "name") {
            name = attribute.value;
          } else if (attribute.name === "filename") {
            if (attribute.extended) {
              filename = attribute.value;
              filenameIsExtended = true;
            } else if (!filenameIsExtended) {
              filename = attribute.value;
            }
          }
        }
        if (name === null) throw parsingError("name attribute is required in content-disposition header");
        break;
      }
      case "content-type": {
        let headerValue = collectASequenceOfBytes((char) => char !== 0x0a && char !== 0x0d, input, position);
        headerValue = removeChars(headerValue, false, true, (char) => char === 0x9 || char === 0x20);
        contentType = isomorphicDecode(headerValue);
        break;
      }
      case "content-transfer-encoding": {
        let headerValue = collectASequenceOfBytes((char) => char !== 0x0a && char !== 0x0d, input, position);
        headerValue = removeChars(headerValue, false, true, (char) => char === 0x9 || char === 0x20);
        encoding = isomorphicDecode(headerValue);
        break;
      }
      default:
        collectASequenceOfBytes((char) => char !== 0x0a && char !== 0x0d, input, position);
    }
    if (input[position.position] !== 0x0d || input[position.position + 1] !== 0x0a) throw parsingError("expected CRLF");
    position.position += 2;
  }
}

function multipartFormDataParser(input, boundaryString) {
  if (boundaryString === undefined || boundaryString === null) throw parsingError("missing boundary in content-type header");
  const boundary = Buffer.from(`--${boundaryString}`, "utf8");
  const entryList = [];
  const position = { position: 0 };
  const firstBoundaryIndex = input.indexOf(boundary);
  if (firstBoundaryIndex === -1) throw parsingError("no boundary found in multipart body");
  position.position = firstBoundaryIndex;
  while (true) {
    if (input.subarray(position.position, position.position + boundary.length).equals(boundary)) position.position += boundary.length;
    else throw parsingError("expected a value starting with -- and the boundary");
    if (bufferStartsWith(input, dd, position)) return entryList;
    if (input[position.position] !== 0x0d || input[position.position + 1] !== 0x0a) throw parsingError("expected CRLF");
    position.position += 2;
    const result = parseMultipartFormDataHeaders(input, position);
    const { name, filename, encoding } = result;
    let { contentType } = result;
    position.position += 2;
    let body;
    {
      const boundaryIndex = input.indexOf(boundary.subarray(2), position.position);
      if (boundaryIndex === -1) throw parsingError("expected boundary after body");
      body = input.subarray(position.position, boundaryIndex - 4);
      position.position += body.length;
      if (encoding === "base64") body = Buffer.from(body.toString(), "base64");
    }
    if (input[position.position] !== 0x0d || input[position.position + 1] !== 0x0a) throw parsingError("expected CRLF");
    position.position += 2;
    let value;
    if (filename !== null) {
      contentType ??= "text/plain";
      if (!isAsciiString(contentType)) contentType = "";
      value = new File([body], filename, { type: contentType });
    } else {
      value = decoderIgnoreBOM.decode(Buffer.from(body));
    }
    entryList.push(makeEntry(name, value, filename ?? undefined));
  }
}

/** formData(): the body's bytes (a promise of them) parsed as the Content-Type says. */
function parse(bytes, contentType) {
  return bytes.then((value) => {
    let mime = null;
    if (contentType !== null) {
      try {
        mime = new MIMEType(contentType);
      } catch {
        mime = null;
      }
    }
    const input = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (mime !== null && mime.essence === "multipart/form-data") {
      const fd = new FormData();
      states.get(fd).entries = multipartFormDataParser(input, mime.params.get("boundary"));
      return fd;
    }
    if (mime !== null && mime.essence === "application/x-www-form-urlencoded") {
      const fd = new FormData();
      for (const [name, entry] of new URLSearchParams(input.toString())) fd.append(name, entry);
      return fd;
    }
    throw new TypeError('Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".');
  });
}

fetchFormDataHooks(serialize, parse);
Object.defineProperty(globalThis, "FormData", { value: FormData, writable: true, enumerable: false, configurable: true });
