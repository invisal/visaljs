// @visaljs/runtime: the C runtime that generated code links against, described for
// the driver: where its headers and sources are, and how to build libjsrt.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export { COMPONENTS, type Component } from "./components.ts";

/** The runtime's directory. */
export const RUNTIME_DIR = import.meta.dirname;
/** Public headers: js_runtime.h, what generated code and host packages include. */
export const RUNTIME_INCLUDE = join(RUNTIME_DIR, "include");
/** The core-method catalog the compiler reads. */
export const CORE_DEF = join(RUNTIME_INCLUDE, "js_core.def");

/** BoringSSL's directory (boringsslLibrary) */
const BORINGSSL = join(RUNTIME_DIR, "third_party", "boringssl");

/** Vendored libraries: every .c of these is part of libjsrt. */
const THIRD_PARTY = ["quickjs-dtoa", "v8-ieee754", "quickjs-regexp", "ada-idna"].map((d) => join(RUNTIME_DIR, "third_party", d));

const cFiles = (dir: string, ext: string) => readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));

/** libjsrt, as a C library the driver builds (the shape host packages give theirs too). */
export function runtimeLibrary() {
  const src = join(RUNTIME_DIR, "src");
  return {
    name: "jsrt",
    sources: [src, ...THIRD_PARTY].flatMap((d) => cFiles(d, ".c")),
    headers: [RUNTIME_INCLUDE, src, ...THIRD_PARTY].flatMap((d) => cFiles(d, ".h").concat(cFiles(d, ".def"))),
    flags: [`-I${RUNTIME_INCLUDE}`, ...THIRD_PARTY.map((d) => `-I${d}`), `-I${join(BORINGSSL, "include")}`],
  };
}

/** BoringSSL: the crypto component's, node:crypto's and node:tls's primitives,
 *  behind runtime/src/crypto*.c; a library of its own, so runtime changes don't rebuild it. Its
 *  sources are C++ (built without exceptions, RTTI or the C++ library) and per-platform assembly, which guards
 *  itself: every file is compiled everywhere. The lists are BoringSSL's (sources.json, from its
 *  gen/sources.json at the vendored commit). */
export function boringsslLibrary(platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch) {
  const lists = JSON.parse(readFileSync(join(BORINGSSL, "sources.json"), "utf8")) as Record<string, Record<string, string[]>>;
  const parts = ["bcm", "crypto", "ssl"].map((k) => lists[k]!);
  const at = (f: string) => join(BORINGSSL, f);
  return {
    name: "boringssl",
    /* boringssl_support.cc: what it needs from a C++ library */
    sources: [...parts.flatMap((p) => [...p.srcs!, ...p.asm!]).map(at), join(RUNTIME_DIR, "src", "boringssl_support.cc")],
    headers: parts.flatMap((p) => [...(p.hdrs ?? []), ...(p.internal_hdrs ?? [])]).map(at),
    flags: [`-I${join(BORINGSSL, "include")}`, ...(platform === "win32" ? boringsslWindows(arch) : [])],
  };
}

/* as BoringSSL's CMakeLists.txt builds it on Windows (wincrypt.h's X509_NAME macro clashes with
 * its type); its Windows x64 assembly is NASM, not vendored: the C implementations instead */
const boringsslWindows = (arch: string) => ["-DWIN32_LEAN_AND_MEAN", "-DNOMINMAX", "-D_HAS_EXCEPTIONS=0", ...(arch === "x64" ? ["-DOPENSSL_NO_ASM"] : [])];

/** The runtime's libraries, in link order: libjsrt, then the libraries it uses. */
export function runtimeLibraries() {
  return [runtimeLibrary(), boringsslLibrary()];
}

/** Third-party code in a program's binary: who wrote it, its license, and the files whose text
 *  must go with a binary that is distributed (`visaljs licenses` prints them). */
export interface Notice {
  name: string;
  /** What of it is in the binary. */
  what: string;
  /** SPDX license expression. */
  license: string;
  files: string[];
}

const thirdParty = (...path: string[]) => join(RUNTIME_DIR, "third_party", ...path);

/** The runtime's third-party code. Each directory of third_party/ is in one of these. */
export const NOTICES: readonly Notice[] = [
  { name: "QuickJS", what: "regular expressions, Unicode tables, number printing and parsing, BigInt arithmetic", license: "MIT",
    files: [thirdParty("quickjs-regexp", "LICENSE"), thirdParty("quickjs-dtoa", "LICENSE")] },
  { name: "Unicode data", what: "the Unicode Character Database's tables, CLDR's time zone names", license: "Unicode-3.0",
    files: [thirdParty("unicode", "LICENSE")] },
  { name: "V8", what: "Math's functions (fdlibm) and Date.parse", license: "BSD-3-Clause AND SunPro",
    files: [thirdParty("v8-ieee754", "LICENSE"), thirdParty("v8-ieee754", "LICENSE.fdlibm")] },
  { name: "Ada", what: "domain names in URLs (IDNA)", license: "MIT", files: [thirdParty("ada-idna", "LICENSE-MIT")] },
  { name: "Node.js", what: "util.inspect and console.table", license: "MIT", files: [thirdParty("nodejs", "LICENSE")] },
  { name: "BoringSSL", what: "cryptography and TLS", license: "Apache-2.0",
    files: [thirdParty("boringssl", "LICENSE"), thirdParty("boringssl", "third_party", "fiat", "LICENSE")] },
  { name: "Mozilla's CA certificates", what: "the root certificates TLS trusts", license: "MPL-2.0",
    files: [thirdParty("mozilla-ca", "README.md"), thirdParty("mozilla-ca", "LICENSE")] },
];
