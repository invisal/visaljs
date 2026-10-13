// Builds the prebuilt libraries (cc.ts, prebuiltArchive) in build/prebuilt/<target>: each
// platform's third-party C libraries (BoringSSL, libuv, zlib, Brotli, zstd), cross-compiled with
// Zig from one machine. dist.ts puts them in the published package, under prebuilt/<target>. The
// runtime and the host code (libjsrt, libjsnode) aren't prebuilt: they change with nearly every
// release, and build in seconds.
//
//   npm run prebuilt [-- target…]    # all of TARGETS when none is given (Zig on the PATH)
//
// Linux's are built against glibc 2.28 (so they link on any glibc since: Debian 10, RHEL 8), or
// musl; macOS's for macOS 11.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { boringsslLibrary, RUNTIME_INCLUDE } from "@visaljs/runtime";
import { libraries } from "@visaljs/node";

import { buildArchive, PREBUILT_COMMON, PREBUILT_OPT, prebuiltKey } from "../src/cc.ts";
import { DEFAULT_HOSTS } from "../src/hosts.ts";
import { notices } from "../src/licenses.ts";

export interface Target {
  /** Its directory's name: cc.ts's hostTarget() on that machine. */
  name: string;
  /** Zig's -target. */
  zig: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
}

export const TARGETS: readonly Target[] = [
  { name: "linux-x64", zig: "x86_64-linux-gnu.2.28", platform: "linux", arch: "x64" },
  { name: "linux-arm64", zig: "aarch64-linux-gnu.2.28", platform: "linux", arch: "arm64" },
  { name: "linux-x64-musl", zig: "x86_64-linux-musl", platform: "linux", arch: "x64" },
  { name: "linux-arm64-musl", zig: "aarch64-linux-musl", platform: "linux", arch: "arm64" },
  { name: "darwin-arm64", zig: "aarch64-macos.11.0", platform: "darwin", arch: "arm64" },
  { name: "darwin-x64", zig: "x86_64-macos.11.0", platform: "darwin", arch: "x64" },
  { name: "win32-x64", zig: "x86_64-windows-gnu", platform: "win32", arch: "x64" },
];

/** The libraries prebuilt for a target: everything but libjsrt and the hosts' own (jsnode). */
export function prebuiltLibraries(target: Target) {
  return [boringsslLibrary(target.platform, target.arch), ...libraries(RUNTIME_INCLUDE, target.platform).filter((l) => l.name !== "jsnode" && l.sources.length)];
}

/** Each library's notice (licenses.ts): the published package carries their licenses (dist.ts,
 *  THIRD_PARTY_LICENSES). */
const LICENSES: Record<string, string> = { boringssl: "BoringSSL", uv: "libuv", zlib: "zlib", brotli: "Brotli", zstd: "Zstandard" };
const NOTICED = new Set(notices(DEFAULT_HOSTS).map((n) => n.name));
/** Where they're built: build/prebuilt/<target>/<name>-<prebuiltKey>.a. */
export const PREBUILT_DIR = join(import.meta.dirname, "..", "..", "build", "prebuilt");

function build(target: Target) {
  const dir = join(PREBUILT_DIR, target.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  /* Linux executables are position-independent by default: their libraries' code must be too */
  const common = [...PREBUILT_COMMON, ...(target.platform === "linux" ? ["-fPIC"] : [])];
  /* ld64 wants the BSD archive format */
  const arFlags = target.platform === "darwin" ? ["--format=darwin"] : [];
  for (const lib of prebuiltLibraries(target)) {
    if (!NOTICED.has(LICENSES[lib.name] ?? "")) throw new Error(`${lib.name}: no notice (LICENSES, licenses.ts)`);
    const started = Date.now();
    buildArchive(`zig cc -target ${target.zig}`, lib, join(dir, `${lib.name}-${prebuiltKey(lib)}.a`), { common, flags: PREBUILT_OPT, arFlags });
    console.log(`${target.name}: ${lib.name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }
}

if (process.argv[1] === import.meta.filename) {
  const names = process.argv.slice(2);
  const unknown = names.filter((n) => !TARGETS.some((t) => t.name === n));
  if (unknown.length) throw new Error(`unknown target ${unknown.join(", ")}: ${TARGETS.map((t) => t.name).join(", ")}`);
  for (const target of TARGETS.filter((t) => !names.length || names.includes(t.name))) build(target);
}
