// @visaljs/compiler: JavaScript to C as a library, with no file system and no C
// compiler: parse (JS → AST), analyze (scopes), lower (AST → IR, @visaljs/ir), and emit
// (IR → one C file for @visaljs/runtime). The driver (visaljs, cli/) bundles, runs these
// stages, and builds the C; the optimizer (@visaljs/optimizer) runs between lower and emit.
export { convertStaticUnit, firstUnsupported, parseModule, parseScript, type StaticUnitSource } from "./frontend/adapter.ts";
export type { Program } from "./frontend/ast.ts";
export { CompileError } from "./frontend/errors.ts";
export { COMMONJS_DIRECTIVE, HOST_MODULE, type HostPrimitive, type HostPrimitives } from "./frontend/host.ts";
export { SourceMap } from "./frontend/sourcemap.ts";
export { analyze } from "./sema/analyze.ts";
export { lower } from "./lower/lower.ts";
export { type CFile, emitHarnessScript, emitProgram, emitProgramFiles, emitUnit, type EmitOptions, type HarnessLink, type HarnessScript } from "./emit/c.ts";
export { COMPONENTS, programNames, reachableComponents, type Component } from "./emit/components.ts";
export { namedCore } from "./emit/core.ts";
export { encodePattern, flagBits, regexpKey } from "./emit/regexp.ts";
export { ATOMS } from "./emit/atoms.ts";
export { jsStringHash } from "./emit/strhash.ts";
