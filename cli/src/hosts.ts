// Host packages: what a program's `node:*` (or other host) imports resolve to. Each
// package provides modules (prelude JS), the host primitives they import from "visaljs:host",
// and the C libraries those need. The driver composes them with the compiler and the runtime;
// a later package's module replaces an earlier one's (the hook for replacing node:http, say).
import type { HostPrimitives } from "@visaljs/compiler";
import type { Notice } from "@visaljs/runtime";
import * as node from "@visaljs/node";

/** A C library the driver builds once (cached) and links: its sources and compile flags. */
export interface CLibrary {
  name: string;
  sources: string[];
  /** Hashed with the sources: a change rebuilds the library. */
  headers: string[];
  flags: string[];
  /** System libraries it needs at link (-l): Windows' ws2_32 for libuv, say. */
  link?: string[];
}

export interface HostPackage {
  name: string;
  /** Prelude modules may import "visaljs:host". */
  preludeDir: string;
  /** Module name (`node:` prefix dropped) → its prelude file. */
  modules: Readonly<Record<string, string>>;
  /** Prelude modules a program gets without importing them, when its bundled code `reached` them:
   *  `code` is the whole bundle, `program` the code of its own modules and packages (no prelude). */
  implicitModules?: readonly { file: string; reached: (code: string, program: string) => boolean }[];
  /** The Symbol.for key on globalThis where createRequire's require() finds the packages the
   *  bundler found it may be asked for: a Map, name → a function giving the module's exports. */
  requireTable?: string;
  primitives: HostPrimitives;
  /** The C libraries to link before libjsrt, given the runtime's include directory, for
   *  `platform` (this one's when not given). */
  libraries(runtimeInclude: string, platform?: NodeJS.Platform): CLibrary[];
  /** The third-party code its modules and libraries put in a binary, and their licenses. */
  notices?: readonly Notice[];
}

export const DEFAULT_HOSTS: readonly HostPackage[] = [{ name: "@visaljs/node", ...node }];

/** Every host package's modules, later packages replacing earlier ones'. */
export function hostModules(hosts: readonly HostPackage[]): Record<string, string> {
  return Object.assign({}, ...hosts.map((h) => h.modules));
}

/** Every host package's primitives. */
export function hostPrimitives(hosts: readonly HostPackage[]): HostPrimitives {
  return Object.assign({}, ...hosts.map((h) => h.primitives));
}
