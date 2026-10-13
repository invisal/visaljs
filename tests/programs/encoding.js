// TextEncoder, TextDecoder, atob, btoa and DOMException (the web-standard host layer)
import util, { TextDecoder as UtilTextDecoder, TextEncoder as UtilTextEncoder } from "node:util";

const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
};

const enc = new TextEncoder();
const dec = new TextDecoder();
console.log(enc.encoding, enc.encode("héllo €😀"), enc.encode(), enc.encode("\ud800x"), enc.encode(12));
console.log(enc.encodeInto("héllo😀", new Uint8Array(5)), enc.encodeInto("a\ud800b", new Uint8Array(4)));
const dest = new Uint8Array(8);
console.log(enc.encodeInto("😀😀", dest), dest);
console.log(dec.encoding, dec.fatal, dec.ignoreBOM, dec.decode(enc.encode("héllo €😀")), JSON.stringify(dec.decode()));
console.log(dec.decode(new Uint8Array([104, 105]).buffer), dec.decode(new DataView(new Uint8Array([104, 105]).buffer)), dec.decode(new Uint16Array([0x6968])));
console.log(JSON.stringify(dec.decode(new Uint8Array([0xe0, 0x80, 0x41, 0xf4, 0x90, 0xc0, 0xed, 0xa0, 0x80, 0xc3]))));
console.log(JSON.stringify(dec.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))), JSON.stringify(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))));

// streaming: a code point split across calls
const s = new TextDecoder();
const bytes = enc.encode("a😀b€");
let out = "";
for (const b of bytes) out += s.decode(new Uint8Array([b]), { stream: true });
console.log(JSON.stringify(out + s.decode()), JSON.stringify(s.decode(new Uint8Array([0xf0, 0x9f]), { stream: true }) + "|" + s.decode()));

// UTF-16 and windows-1252
console.log(new TextDecoder("utf-16le").decode(new Uint8Array([0xff, 0xfe, 0x41, 0, 0x3d, 0xd8, 0, 0xde])), new TextDecoder("UTF-16BE").decode(new Uint8Array([0, 65, 0xd8, 0x3d, 0xde, 0])));
console.log(JSON.stringify(new TextDecoder("utf-16le").decode(new Uint8Array([0x41, 0, 0x3d, 0xd8, 0x41]))), JSON.stringify(new TextDecoder("utf-16le").decode(new Uint8Array([0x3d, 0xd8, 0x41, 0]))));
const latin = new TextDecoder(" Latin1 ");
console.log(latin.encoding, latin.decode(new Uint8Array([0x80, 0x9f, 0xe9, 0x41])), new TextDecoder("ascii").encoding, new TextDecoder("unicode").encoding);

// inspection
console.log(enc, dec, [new TextDecoder("utf-16be", { fatal: true })], Object.prototype.toString.call(dec));
class MyDecoder extends TextDecoder {}
console.log(new MyDecoder(), new MyDecoder() instanceof TextDecoder);

// errors
t(() => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])));
t(() => new TextDecoder("utf-16le", { fatal: true }).decode(new Uint8Array([0x41])));
t(() => new TextDecoder("foo"));
t(() => new TextDecoder(null));
t(() => new TextDecoder("utf-8", 5));
t(() => dec.decode("x"));
t(() => enc.encodeInto(5, new Uint8Array(2)));
t(() => enc.encodeInto("a", []));
t(() => enc.encodeInto("a", new Uint16Array(2)));
t(() => TextEncoder.prototype.encode.call({}, "a"));
t(() => Reflect.get(TextDecoder.prototype, "fatal", {}));
t(() => TextDecoder());

// atob and btoa
console.log(btoa("abc"), btoa("ab"), btoa("a"), btoa(""), btoa("\xff\xfe"), btoa(null), atob.length, btoa.length);
console.log(atob(" YW Jj\n"), atob("YWI="), atob("YQ"), JSON.stringify(atob("//79")), atob(btoa("héllo")));
t(() => btoa("€"));
t(() => atob("a"));
t(() => atob("YQ==="));
t(() => atob("Y=Q="));
t(() => atob("YQ=*"));
t(() => atob("YWJ=c"));
t(() => btoa());

// DOMException
const de = new DOMException("m", "AbortError");
const gone = new DOMException("gone");
const firstLine = (e) => (e.stack = e.stack.split("\n")[0]);  /* Node records frames; visaljs doesn't */
firstLine(de);
firstLine(gone);
console.log(de.name, de.message, de.code, de.stack, String(de), Object.keys(de), Object.getOwnPropertyNames(de));
console.log(de instanceof DOMException, de instanceof Error, Object.prototype.toString.call(de), DOMException.ABORT_ERR, de.DATA_CLONE_ERR);
console.log(new DOMException().name, JSON.stringify(new DOMException().message), new DOMException("x", { name: "DataCloneError" }).code, new DOMException(5).message, new DOMException("x", "Foo").code);
console.log(new DOMException("x", { cause: 1 }).cause, Object.getOwnPropertyDescriptor(DOMException.prototype, "name").enumerable, DOMException.length);
console.log(de, [de], { e: gone });
t(() => DOMException());
t(() => DOMException.prototype.name);
try {
  btoa("Ā");
} catch (e) {
  console.log(e instanceof DOMException, e.name, e.code, e.message);
}

// the globals' attributes: classes are hidden, atob and btoa are enumerable
const shown = (k) => Object.getOwnPropertyDescriptor(globalThis, k).enumerable;
console.log(shown("TextEncoder"), shown("TextDecoder"), shown("DOMException"), shown("atob"), shown("btoa"));

// node:util's are the globals (React's server build makes a `new util.TextEncoder()`)
console.log(UtilTextEncoder === TextEncoder, UtilTextDecoder === TextDecoder, util.TextEncoder === TextEncoder, util.TextDecoder === TextDecoder);
console.log(new util.TextDecoder().decode(new util.TextEncoder().encode("ü€")));
