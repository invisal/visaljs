// Next.js (next build, with Turbopack, its default): its own production server, the one
// `next start` and a standalone build's server.js run (next/dist/server/lib/start-server), with the
// app's build compiled in. Next loads the build by paths it computes at run time from its
// manifests, which a compiled program has no files to load from: the route's entry
// (server/require.js, `require(pagePath)`), the chunks it lists (the Turbopack runtime,
// `require(path.resolve(RUNTIME_ROOT, chunkPath))`), and the client reference manifests, which it
// evaluates as source text (load-manifest, `vm.runInNewContext`). A table made at build time has
// every module of .next/server, by its path under .next: those loads look it up first. Of the
// packages, only the files next build traced as the server's (its .nft.json files, what a standalone
// build copies; visaljs runs next build as a standalone build, which traces start-server too, the
// entry, without changing next.config: NEXT_PRIVATE_STANDALONE, Next's default output) are bundled: a require() of another (the dev server, webpack, the dev overlay, in
// branches production never takes) throws if it's reached, as in a standalone build. Where Next
// picks a route runtime by environment variable (module.compiled.js: edge or Node, experimental
// React or not, Turbopack or webpack), the variables are fixed as this build's, so the bundler
// drops the runtimes it can't pick; without middleware, the edge sandbox isn't bundled. At run time
// the server reads the rest of .next (its JSON manifests, the prerendered pages, static/) and
// public/ under the working directory, as `next start` does.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { Plugin } from "rolldown";

import { FrameworkError } from "./error.ts";
import type { Framework } from "./index.ts";
import { dependencies, packageBin } from "./project.ts";

const TABLE = "\0visaljs-next-table";
const UNTRACED = "\0visaljs-next-untraced:";
const UNCALLED_PREFIX = "\0visaljs-next-uncalled:";

interface RequiredServerFiles {
  config: { distDir?: string; [key: string]: unknown };
}

/** next build's config, as the standalone server.js gets it, and its build directory (.next). */
function serverConfig(root: string): { config: RequiredServerFiles["config"]; distDir: string } {
  for (const distDir of [".next", ...configuredDistDir(root)]) {
    const file = join(root, distDir, "required-server-files.json");
    if (existsSync(file)) {
      const { config } = JSON.parse(readFileSync(file, "utf8")) as RequiredServerFiles;
      return { config, distDir: config.distDir ?? distDir };
    }
  }
  /* `output: "export"`: static files in out/, and no server */
  if (existsSync(join(root, "out", "index.html")) || existsSync(join(root, "out", "404.html"))) {
    throw new FrameworkError(`${root} is a static export (output: "export" in next.config): it has no server to compile. ` +
      "Serve out/ with any static file server, or remove output: \"export\" to compile the Next.js server");
  }
  throw new FrameworkError(`${root} has no Next.js build (no .next/required-server-files.json): run \`next build\`, or build without --no-framework-build`);
}

/** Whether next build used Turbopack (its default since Next.js 16): its chunks' runtime is there. */
function isTurbopackBuild(root: string, distDir: string): boolean {
  const chunks = join(root, distDir, "server", "chunks");
  return existsSync(join(chunks, "[turbopack]_runtime.js")) || existsSync(join(chunks, "ssr", "[turbopack]_runtime.js"));
}

/* a distDir other than .next: next.config's, which this can't evaluate; the build directories there */
function configuredDistDir(root: string): string[] {
  return readdirSync(root).filter((d) => d !== ".next" && existsSync(join(root, d, "required-server-files.json")));
}

/** Every file under `dir`, by its path relative to it, with "/". */
function files(dir: string, under = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, under))) {
    const path = under ? `${under}/${entry}` : entry;
    if (statSync(join(dir, path)).isDirectory()) out.push(...files(dir, path));
    else out.push(path);
  }
  return out;
}

/** The table's module (CommonJS: each entry is required when it's first loaded): .next/server's
 *  modules by their path under .next, and its client reference manifests as functions of the
 *  context Next evaluates them in. */
function tableModule(root: string, distDir: string): string {
  const build = join(root, distDir);
  const server = files(join(build, "server")).filter((f) => f.endsWith(".js")).map((f) => `server/${f}`);
  const manifest = (f: string) => /_client-reference-manifest\.js$/.test(f);
  const modules = server.filter((f) => !manifest(f)).map((f) => `  ${JSON.stringify(f)}: () => require(${JSON.stringify(join(build, f))}),`);
  /* source text Next runs in a context of its own: the same code, with the context as globalThis */
  const manifests = server.filter(manifest).map((f) =>
    `  ${JSON.stringify(f)}: function (globalThis) { var process = globalThis.process;\n${readFileSync(join(build, f), "utf8")}\n},`);
  return `"use strict";\nexports.modules = {\n${modules.join("\n")}\n};\nexports.manifests = {\n${manifests.join("\n")}\n};\n`;
}

/** The files next build traced as the server's and its routes' (their .nft.json files): absolute paths. */
function tracedFiles(root: string, distDir: string): Set<string> {
  const build = join(root, distDir);
  const traces = [...files(build, "").filter((f) => !f.startsWith("standalone/") && !f.startsWith("cache/") && f.endsWith(".nft.json"))];
  const traced = new Set<string>();
  for (const trace of traces) {
    const { files: listed } = JSON.parse(readFileSync(join(build, trace), "utf8")) as { files: string[] };
    for (const f of listed) traced.add(resolve(build, dirname(trace), f));
  }
  return traced;
}

/** process.env's variables Next's server reads to pick a route runtime, as this build's server has
 *  them: NEXT_RUNTIME (only the edge runtime sets it), TURBOPACK (next.js sets it for a Turbopack
 *  build) and __NEXT_EXPERIMENTAL_REACT (as next build defines it in the code it compiles). */
function runtimeVariables(root: string, config: RequiredServerFiles["config"]): Record<string, string> {
  let experimental: boolean;
  try {
    const { needsExperimentalReact } = createRequire(join(root, "package.json"))("next/dist/lib/needs-experimental-react.js") as
      { needsExperimentalReact: (c: unknown) => boolean };
    experimental = needsExperimentalReact(config);
  } catch {
    experimental = true;  /* not this version's: keep both runtimes */
  }
  return {
    NEXT_RUNTIME: "undefined",
    TURBOPACK: JSON.stringify("1"),
    ...(experimental ? {} : { __NEXT_EXPERIMENTAL_REACT: "undefined" }),
  };
}

/** Whether the build has middleware or edge functions: the edge sandbox runs them. */
function hasMiddleware(root: string, distDir: string): boolean {
  const file = join(root, distDir, "server", "middleware-manifest.json");
  if (!existsSync(file)) return true;
  const { middleware = {}, functions = {} } = JSON.parse(readFileSync(file, "utf8")) as { middleware?: object; functions?: object };
  return Object.keys(middleware).length > 0 || Object.keys(functions).length > 0;
}

/* Next's dev mode, where the production server only names it: the dev server (next.js, when
 * options.dev), its bundler setup (router-server.js, in dev) and the dev overlay's hot reloader
 * (app-router.js). Next traces them, and what they reach (webpack, the edge runtime, the dev
 * tools): as an importer's path suffix and the specifier it requires. */
const DEV_ONLY: [importer: string, source: string][] = [
  ["next/dist/server/next.js", "./dev/next-dev-server"],
  ["next/dist/server/lib/router-server.js", "./router-utils/setup-dev-bundler"],
  ["next/dist/client/components/app-router.js", "../dev/hot-reloader/app/hot-reloader-app"],
  /* telemetry: router-server.js starts it in dev */
  ["next/dist/server/lib/router-server.js", "../../telemetry/storage"],
];

/* Modules a production file requires when it loads, for a function it calls only in a case this
 * build's server never has: each export a function that throws when called. config.js transpiles
 * a next.config.ts with SWC (which reaches webpack's and the edge runtime's code), but the server
 * gets the config next build saved (__NEXT_PRIVATE_STANDALONE_CONFIG) and returns it first. */
const UNCALLED: [importer: string, source: string, exports: string[]][] = [
  ["next/dist/server/config.js", "../build/next-config-ts/transpile-config", ["transpileConfig"]],
];

/* the files that pick a route runtime by those variables, and only read them */
const RUNTIME_PICKERS = /[\\/]next[\\/]dist[\\/]server[\\/]route-modules[\\/](?:[\w-]+[\\/]module\.compiled|app-page[\\/]vendored[\\/]\w+[\\/]entrypoints)\.js$/;

/* where each load is: the file, the code there, and what it becomes (the original as the fallback) */
const LOADS: { file: RegExp; find: string; replace: string }[] = [
  {
    file: /[\\/]next[\\/]dist[\\/]server[\\/]require\.js$/,
    find: "require(/* turbopackIgnore: true */ pagePath)",
    replace: "globalThis.__visaljs_next.require(pagePath, () => require(/* turbopackIgnore: true */ pagePath))",
  },
  {
    file: /[\\/]server[\\/]chunks[\\/](?:ssr[\\/])?\[turbopack\]_runtime\.js$/,
    find: "require(resolved)",
    replace: "globalThis.__visaljs_next.require(resolved, () => require(resolved))",
  },
  {
    file: /[\\/]next[\\/]dist[\\/]server[\\/]load-manifest\.external\.js$/,
    find: "(0, _vm.runInNewContext)(content, contextObject)",
    replace: "globalThis.__visaljs_next.evaluate(path, contextObject, () => (0, _vm.runInNewContext)(content, contextObject))",
  },
];

export const next: Framework = {
  name: "Next.js",
  detect: (root) => "next" in dependencies(root) && !("vinext" in dependencies(root)),
  async build(root) {
    const bin = packageBin(root, "next", "next");
    /* a standalone build also copies the traced files to .next/standalone, which visaljs doesn't
     * need (it bundles from node_modules): removed after, unless the project had one */
    const standalone = join(root, ".next", "standalone");
    const hadStandalone = existsSync(standalone);
    try {
      /* NEXT_PRIVATE_STANDALONE: output "standalone" unless next.config says otherwise */
      const env = { ...process.env, NEXT_PRIVATE_STANDALONE: "1", NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0" };
      await promisify(execFile)(process.execPath, [bin, "build"], { cwd: root, maxBuffer: 64 << 20, env });
    } catch (e) {
      const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
      throw new FrameworkError(`next build failed in ${root}:\n${`${stdout}${stderr}`.trimEnd().split("\n").slice(-30).join("\n")}`);
    } finally {
      if (!hadStandalone) rmSync(standalone, { recursive: true, force: true });
    }
    return "Built the app with next build, as a standalone build (.next/)";
  },
  entry(root) {
    const { config, distDir } = serverConfig(root);
    if (!existsSync(join(root, distDir, "server", "app")) && !existsSync(join(root, distDir, "server", "pages"))) {
      throw new FrameworkError(`${root}'s ${distDir}/server has no app/ or pages/: this Next.js build isn't supported yet`);
    }
    /* the traces of a standalone build: start-server's files, which the entry starts, are among them */
    if (config.output !== "standalone") {
      throw new FrameworkError(`${root}'s ${distDir} isn't a standalone build, whose traces visaljs bundles from: build without ` +
        "--no-framework-build (visaljs runs next build as one, without changing next.config), or set output: \"standalone\"");
    }
    if (!isTurbopackBuild(root, distDir)) {
      throw new FrameworkError(`${root}'s ${distDir} was built with webpack (next build --webpack): visaljs compiles Turbopack builds, ` +
        "next build's default, for now. Build without --webpack");
    }
    /* standalone's server.js: the config next build saved, then the server on $PORT and $HOSTNAME */
    return `import { modules, manifests } from ${JSON.stringify(TABLE)};
const config = ${JSON.stringify(config)};
const key = (path) => {
  const p = String(path).replaceAll("\\\\", "/");
  const at = p.lastIndexOf(${JSON.stringify(`/${distDir}/`)});
  return at < 0 ? undefined : p.slice(at + ${distDir.length + 2});
};
globalThis.__visaljs_next = {
  require(path, original) {
    const load = modules[key(path)];
    return load ? load() : original();
  },
  evaluate(path, context, original) {
    const run = manifests[key(path)];
    return run ? run(context) : original();
  },
};
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
await import("next");
const { startServer } = await import("next/dist/server/lib/start-server");
let keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10);
if (!Number.isFinite(keepAliveTimeout) || keepAliveTimeout < 0) keepAliveTimeout = undefined;
await startServer({
  dir: process.cwd(),
  isDev: false,
  config,
  hostname: process.env.HOSTNAME || "0.0.0.0",
  port: parseInt(process.env.PORT, 10) || 3000,
  allowRetry: false,
  keepAliveTimeout,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
  },
  plugins(root): Plugin[] {
    const { config, distDir } = serverConfig(root);
    const traced = tracedFiles(root, distDir);
    const variables = runtimeVariables(root, config);
    const read = new RegExp(`\\bprocess\\.env\\.(${Object.keys(variables).join("|")})\\b(?!\\s*(?:=[^=]|\\?\\?=|\\|\\|=|&&=))`, "g");
    const sandbox = !hasMiddleware(root, distDir);
    const packages = join(root, "node_modules") + sep;
    return [{
      name: "visaljs-next",
      async resolveId(source, importer, { kind }) {
        if (source === TABLE) return source;
        if (kind !== "require-call" || source.startsWith("\0") || !importer?.startsWith(packages)) return null;
        const from = importer.replaceAll("\\", "/");
        if (DEV_ONLY.some(([file, s]) => s === source && from.endsWith(`/node_modules/${file}`))) return UNTRACED + source;
        const uncalled = UNCALLED.find(([file, s]) => s === source && from.endsWith(`/node_modules/${file}`));
        if (uncalled) return UNCALLED_PREFIX + JSON.stringify([source, uncalled[2]]);
        /* the edge sandbox, which runs middleware: a build without any never reaches it */
        if (sandbox && source === "./web/sandbox" && /[\\/]next[\\/]dist[\\/]server[\\/]next-server\.js$/.test(importer)) return UNTRACED + source;
        const resolved = await this.resolve(source, importer, { skipSelf: true });
        if (!resolved || resolved.external || !resolved.id.startsWith(packages) || traced.has(resolved.id)) return resolved;
        return UNTRACED + source;
      },
      load(id) {
        if (id === TABLE) return tableModule(root, distDir);
        if (id.startsWith(UNCALLED_PREFIX)) {
          const [source, names] = JSON.parse(id.slice(UNCALLED_PREFIX.length)) as [string, string[]];
          const message = JSON.stringify(`${source} isn't in the compiled server: visaljs builds Next's production server, which doesn't call it`);
          return names.map((n) => `exports.${n} = function () { throw new Error(${message}); };\n`).join("");
        }
        if (!id.startsWith(UNTRACED)) return null;
        /* CommonJS: wrapped, so it throws only when required */
        const message = `Cannot find module '${id.slice(UNTRACED.length)}' (next build didn't trace it as the server's)`;
        return `throw Object.assign(new Error(${JSON.stringify(message)}), { code: "MODULE_NOT_FOUND" });\n`;
      },
      transform: {
        filter: { id: /(?:require|load-manifest\.external|_runtime|module\.compiled|entrypoints)\.js$/ },
        handler(code, id) {
          if (RUNTIME_PICKERS.test(id)) return { code: code.replace(read, (_, name: string) => variables[name]!), map: null };
          const load = LOADS.find((l) => l.file.test(id));
          if (!load) return null;
          if (!code.includes(load.find)) {
            this.error(`${relative(root, id)} no longer loads the build as visaljs expects (${load.find}): this Next.js version isn't supported yet`);
          }
          /* on the same line: the module's source map still holds (map: null keeps it) */
          return { code: code.replaceAll(load.find, load.replace), map: null };
        },
      },
    }];
  },
  notes(root, output) {
    const { distDir } = serverConfig(root);
    const inside = relative(root, output);
    const bin = !inside.startsWith("..") && !isAbsolute(inside) ? `./${inside.replaceAll("\\", "/")}` : output;
    const project = relative(process.cwd(), root);
    const cd = project && project !== "." ? `cd ${project.startsWith("..") ? root : project} && ` : "";
    return [
      `Run it in the project: it serves ${distDir}/ and public/ from the working directory, as \`next start\` does: ${cd}PORT=3000 ${bin}`,
      `To deploy it, copy ${basename(output)}, ${distDir}/ (without ${distDir}/cache) and public/ to the server, and run it there the same way`,
    ];
  },
};
