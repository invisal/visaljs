// Next.js (Turbopack builds): its standalone production server (next/dist/server/lib/start-server),
// with the app's build compiled in. Next loads the build by paths it computes at run time, which a
// compiled program has no files at: those loads look in a table of .next/server's modules first.
// Only the package files next build traced as the server's are bundled. At run time the server
// reads the rest of .next and public/ from the working directory, as `next start` does.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Plugin } from "rolldown";

import type { IgnoredModule } from "../bundle.ts";

import { IntegrationError } from "../pipeline/errors.ts";
import { packageBin } from "../pipeline/packages.ts";
import type { Integration, Rewrite } from "../pipeline/types.ts";

const TABLE = "\0visaljs-next-table";
const UNTRACED = "\0visaljs-next-untraced:";

interface RequiredServerFiles {
  config: { distDir?: string; [key: string]: unknown };
}

function serverConfig(root: string): { config: RequiredServerFiles["config"]; distDir: string } {
  for (const distDir of [".next", ...configuredDistDir(root)]) {
    const file = join(root, distDir, "required-server-files.json");
    if (existsSync(file)) {
      const { config } = JSON.parse(readFileSync(file, "utf8")) as RequiredServerFiles;
      return { config, distDir: config.distDir ?? distDir };
    }
  }
  if (existsSync(join(root, "out", "index.html")) || existsSync(join(root, "out", "404.html"))) {
    throw new IntegrationError(`${root} is a static export (output: "export" in next.config): it has no server to compile. ` +
      "Serve out/ with any static file server, or remove output: \"export\" to compile the Next.js server");
  }
  throw new IntegrationError(`${root} has no Next.js build (no .next/required-server-files.json): run \`next build\`, or build without --no-framework-build`);
}

function isTurbopackBuild(root: string, distDir: string): boolean {
  const chunks = join(root, distDir, "server", "chunks");
  return existsSync(join(chunks, "[turbopack]_runtime.js")) || existsSync(join(chunks, "ssr", "[turbopack]_runtime.js"));
}

/* next.config can't be evaluated here: a custom distDir is found by its build files */
function configuredDistDir(root: string): string[] {
  return readdirSync(root).filter((d) => d !== ".next" && existsSync(join(root, d, "required-server-files.json")));
}

/** Every file under `dir`, relative to it, with "/". */
function files(dir: string, under = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, under))) {
    const path = under ? `${under}/${entry}` : entry;
    if (statSync(join(dir, path)).isDirectory()) out.push(...files(dir, path));
    else out.push(path);
  }
  return out;
}

/* CommonJS, so each of the build's modules is required only when it's first loaded */
function tableModule(root: string, distDir: string): string {
  const build = join(root, distDir);
  const server = files(join(build, "server")).filter((f) => f.endsWith(".js")).map((f) => `server/${f}`);
  const manifest = (f: string) => /_client-reference-manifest\.js$/.test(f);
  const modules = server.filter((f) => !manifest(f)).map((f) => `  ${JSON.stringify(f)}: () => require(${JSON.stringify(join(build, f))}),`);
  /* Next evaluates these as source text in a context of its own: the context becomes globalThis */
  const manifests = server.filter(manifest).map((f) =>
    `  ${JSON.stringify(f)}: function (globalThis) { var process = globalThis.process;\n${readFileSync(join(build, f), "utf8")}\n},`);
  return `"use strict";\nexports.modules = {\n${modules.join("\n")}\n};\nexports.manifests = {\n${manifests.join("\n")}\n};\n`;
}

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

/** The variables Next picks a route runtime by, as this build's server has them: NEXT_RUNTIME (only
 *  the edge runtime sets it), TURBOPACK (set for a Turbopack build), __NEXT_EXPERIMENTAL_REACT (as
 *  next build defines it). */
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

/* every build lists a static 404.html and 500.html: only a .js module is a Pages route */
function hasPagesRoutes(root: string, distDir: string): boolean {
  const file = join(root, distDir, "server", "pages-manifest.json");
  if (!existsSync(file)) return true;
  return Object.values(JSON.parse(readFileSync(file, "utf8")) as Record<string, string>).some((f) => f.endsWith(".js"));
}

function hasMiddleware(root: string, distDir: string): boolean {
  const file = join(root, distDir, "server", "middleware-manifest.json");
  if (!existsSync(file)) return true;
  const { middleware = {}, functions = {} } = JSON.parse(readFileSync(file, "utf8")) as { middleware?: object; functions?: object };
  return Object.keys(middleware).length > 0 || Object.keys(functions).length > 0;
}

function ignoredModules(root: string, distDir: string): IgnoredModule[] {
  const dev = "Next's dev mode: visaljs builds its production server";
  return [
    /* next.js, when options.dev */
    { module: "next/dist/server/dev/next-dev-server.js", reason: dev },
    /* router-server.js, in dev */
    { module: "next/dist/server/lib/router-utils/setup-dev-bundler.js", reason: dev },
    { module: "next/dist/telemetry/storage.js", reason: dev },
    /* the dev overlay (app-router.js) */
    { module: "next/dist/client/dev/hot-reloader/app/hot-reloader-app.js", reason: dev },
    /* next.js, when an editor's TypeScript service loads the package as its plugin */
    { module: "next/dist/server/next-typescript.js", reason: "Next's TypeScript plugin for editors" },
    /* config.js would transpile next.config.ts, but returns the saved config first */
    { module: "next/dist/build/next-config-ts/transpile-config.js", stub: "call", reason: "the server gets the config next build saved" },
    /* required where modules load (code-frame.js), and reaching a quarter of a million lines of C */
    { module: "next/dist/build/swc/index.js", stub: "call", reason: "SWC is a native addon, which visaljs can't load" },
    ...(hasPagesRoutes(root, distDir) ? [] : [{ module: "next/dist/server/route-modules/pages/module.compiled.js", reason: "the Pages Router's renderer, and this build has no Pages routes" }]),
    ...(hasMiddleware(root, distDir) ? [] : [{ module: "next/dist/server/web/sandbox/index.js", reason: "the edge sandbox runs middleware, which this build has none of" }]),
  ];
}

/* they only read the variables: safe to replace each read */
const RUNTIME_PICKERS = /[\\/]next[\\/]dist[\\/]server[\\/]route-modules[\\/](?:[\w-]+[\\/]module\.compiled|app-page[\\/]vendored[\\/]\w+[\\/]entrypoints)\.js$/;

/* Dev and test mode, off in this build, as constants: the bundler drops the branches and what only
 * they require. A site that's no longer there only leaves the program bigger. */
function constants(root: string, config: RequiredServerFiles["config"]): Rewrite[] {
  const testProxy = (config.experimental as { testProxy?: unknown } | undefined)?.testProxy;
  /* config-schema.js loads all of `next experimental-test` only for this list */
  const runners = testRunners(root);
  return [
    ...(runners ? [{
      file: /[\\/]next[\\/]dist[\\/]server[\\/]config-schema\.js$/,
      find: 'const _nexttest = require("../cli/next-test");',
      replace: `const _nexttest = { SUPPORTED_TEST_RUNNERS_LIST: ${runners} };`,
    }] : []),
    {
      file: /[\\/]next[\\/]dist[\\/]server[\\/]lib[\\/]start-server\.js$/,
      find: "const { dir, isDev, hostname,",
      replace: "const isDev = false, { dir, hostname,",
    },
    ...(testProxy ? [] : [
      { file: /[\\/]next[\\/]dist[\\/]server[\\/]next-server\.js$/, find: "this.serverOptions.experimentalTestProxy", replace: "false" },
      { file: /[\\/]next[\\/]dist[\\/]server[\\/]lib[\\/]router-server\.js$/, find: "config.experimental.testProxy", replace: "false" },
      { file: /[\\/]next[\\/]dist[\\/]server[\\/]web[\\/]adapter\.js$/, find: "process.env.NEXT_PRIVATE_TEST_PROXY === 'true'", replace: "false" },
    ]),
  ].map((c) => ({ ...c, missing: "skip" as const }));
}

function testRunners(root: string): string | undefined {
  try {
    const file = createRequire(join(root, "package.json")).resolve("next/dist/cli/next-test.js");
    const list = /\bconst SUPPORTED_TEST_RUNNERS_LIST = (\[[\s\w'",]*\]);/.exec(readFileSync(file, "utf8"))?.[1];
    return list && JSON.stringify(JSON.parse(list.replaceAll("'", '"').replace(/,\s*\]$/, "]")) as string[]);
  } catch {
    return undefined;
  }
}

/* the build's loads: the table first, the original load as the fallback */
const LOADS: Rewrite[] = [
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

/* standalone's server.js, with the table's lookups */
function entrySource(config: RequiredServerFiles["config"], distDir: string): string {
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
}

/* the table, and a stand-in for each package file next build didn't trace as the server's */
function buildModules(root: string, distDir: string): Plugin {
  const traced = tracedFiles(root, distDir);
  const packages = join(root, "node_modules") + sep;
  return {
    name: "visaljs-next",
    async resolveId(source, importer, { kind }) {
      if (source === TABLE) return source;
      if (kind !== "require-call" || source.startsWith("\0") || !importer?.startsWith(packages)) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved || resolved.external || !resolved.id.startsWith(packages) || traced.has(resolved.id)) return resolved;
      return UNTRACED + source;
    },
    load(id) {
      if (id === TABLE) return tableModule(root, distDir);
      if (!id.startsWith(UNTRACED)) return null;
      /* CommonJS: wrapped, so it throws only when required */
      const message = `Cannot find module '${id.slice(UNTRACED.length)}' (next build didn't trace it as the server's)`;
      return `throw Object.assign(new Error(${JSON.stringify(message)}), { code: "MODULE_NOT_FOUND" });\n`;
    },
  };
}

export const next: Integration<{ config: RequiredServerFiles["config"]; distDir: string }> = {
  name: "Next.js",
  summary: "A Next.js app: compiling its production server",
  detect: (project) => project.packages.has("next"),
  hooks: {
    async frameworkBuild(ctx) {
      const bin = packageBin(ctx.root, "next", "next");
      /* standalone/ copies node_modules' traced files, which visaljs bundles from where they are */
      const standalone = join(ctx.root, ".next", "standalone");
      const hadStandalone = existsSync(standalone);
      try {
        /* a standalone build without changing next.config: its traces include start-server's */
        await ctx.run([bin, "build"], { env: { NEXT_PRIVATE_STANDALONE: "1", NEXT_TELEMETRY_DISABLED: "1" } });
      } finally {
        if (!hadStandalone) rmSync(standalone, { recursive: true, force: true });
      }
      return "Built the app with next build, as a standalone build (.next/)";
    },

    prepare(ctx) {
      const { root } = ctx;
      const { config, distDir } = serverConfig(root);
      if (!existsSync(join(root, distDir, "server", "app")) && !existsSync(join(root, distDir, "server", "pages"))) {
        throw new IntegrationError(`${root}'s ${distDir}/server has no app/ or pages/: this Next.js build isn't supported yet`);
      }
      if (config.output !== "standalone") {
        throw new IntegrationError(`${root}'s ${distDir} isn't a standalone build, whose traces visaljs bundles from: build without ` +
          "--no-framework-build (visaljs runs next build as one, without changing next.config), or set output: \"standalone\"");
      }
      if (!isTurbopackBuild(root, distDir)) {
        throw new IntegrationError(`${root}'s ${distDir} was built with webpack (next build --webpack): visaljs compiles Turbopack builds, ` +
          "next build's default, for now. Build without --webpack");
      }
      ctx.entrySource = entrySource(config, distDir);
      return { config, distDir };
    },

    bundle(ctx, { config, distDir }) {
      for (const m of ignoredModules(ctx.root, distDir)) ctx.ignore(m);
      const variables = runtimeVariables(ctx.root, config);
      const read = new RegExp(`\\bprocess\\.env\\.(${Object.keys(variables).join("|")})\\b(?!\\s*(?:=[^=]|\\?\\?=|\\|\\|=|&&=))`, "g");
      ctx.rewrite({ file: RUNTIME_PICKERS, find: read, replace: (_, name) => variables[name]!, missing: "skip" });
      for (const r of [...constants(ctx.root, config), ...LOADS]) ctx.rewrite(r);
      ctx.plugin(buildModules(ctx.root, distDir));
    },

    done(ctx, { distDir }) {
      const { root, output } = ctx;
      const inside = relative(root, output);
      const bin = !inside.startsWith("..") && !isAbsolute(inside) ? `./${inside.replaceAll("\\", "/")}` : output;
      const project = relative(process.cwd(), root);
      const cd = project && project !== "." ? `cd ${project.startsWith("..") ? root : project} && ` : "";
      ctx.note(`Run it in the project: it serves ${distDir}/ and public/ from the working directory, as \`next start\` does: ${cd}PORT=3000 ${bin}`);
      ctx.note(`To deploy it, copy ${basename(output)}, ${distDir}/ (without ${distDir}/cache) and public/ to the server, and run it there the same way`);
    },
  },
};
