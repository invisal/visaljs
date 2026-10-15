// vinext (Next.js on Vite, github.com/cloudflare/vinext): its own production server, the one
// `vinext start` runs (vinext/server/prod-server), compiled with the app's build. The project is
// built with its own Vite first (`vite build`: dist/server, dist/client). The server imports the
// build by a path it computes from ./dist, which a compiled program can't load: the build's
// entries become imports the bundler follows. At run time it serves ./dist under the working
// directory, as `vinext start` does. A project made for Cloudflare Workers (create-vinext-app's
// default) is built for Node: its own Vite config, without the Cloudflare plugin (WORKERS_CONFIG).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import { FrameworkError } from "./error.ts";
import type { Framework } from "./index.ts";
import { dependencies, packageBin, packageJson } from "./project.ts";

/** The Vite config file and mode the project's build script gives `vite build` (-c, -m), if any. */
export function buildScriptOptions(root: string): { config?: string; mode?: string } {
  const words = packageJson(root).scripts?.build?.split(/\s+/) ?? [];
  if (!words.includes("vite") && !words.includes("vinext")) return {};
  const options: { config?: string; mode?: string } = {};
  for (let i = 0; i < words.length; i++) {
    const [flag, value = words[i + 1]] = words[i]!.split("=", 2) as [string, string?];
    if (value === undefined) continue;
    if (flag === "-c" || flag === "--config") options.config = value;
    if (flag === "-m" || flag === "--mode") options.mode = value;
  }
  return options;
}

/* the files vinext takes for a Cloudflare Workers project (its hasWranglerConfig) */
const WORKERS_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml", "cloudflare.config.ts"];

/** Whether the project is made for Cloudflare Workers: its own build makes a Worker. */
export function isWorkersProject(root: string): boolean {
  return WORKERS_FILES.some((f) => existsSync(join(root, f))) || "@cloudflare/vite-plugin" in dependencies(root);
}

/* The Vite config visaljs builds a Workers project with: the project's own (loaded as `vite build`
 * would, a function of { command, mode } or an object), without the Cloudflare plugin's plugins.
 * vinext refuses a Node build of a project with a Workers config file, which it looks for with
 * fs.existsSync: during this build, those files aren't there for it. The project isn't changed. */
const WORKERS_CONFIG = `import fs from "node:fs";
import path from "node:path";
import { loadConfigFromFile } from "vite";

const root = process.cwd();
const hidden = new Set(${JSON.stringify(WORKERS_FILES)}.map((f) => path.join(root, f)));
const existsSync = fs.existsSync;
fs.existsSync = (p) => !hidden.has(path.resolve(String(p))) && existsSync(p);

const mode = process.env.VISALJS_VITE_MODE || "production";
const loaded = await loadConfigFromFile({ command: "build", mode }, process.env.VISALJS_VITE_CONFIG || undefined, root);
const flat = async (plugins) => (await Promise.all((plugins ?? []).map(async (p) => {
  p = await p;
  return Array.isArray(p) ? flat(p) : p ? [p] : [];
}))).flat();
const plugins = (await flat(loaded?.config.plugins)).filter((p) => !p.name?.startsWith("vite-plugin-cloudflare"));
export default { ...loaded?.config, root, plugins };
`;

const MARKER = join("dist", "server", "vinext-server.json");  /* written by vinext's build */
const BUILD_ENTRIES = ["dist/server/index.js", "dist/server/entry.js"];  /* App Router's, Pages Router's */

export const vinext: Framework = {
  name: "vinext",

  detect: (root) => "vinext" in dependencies(root),

  async build(root) {
    const vite = packageBin(root, "vite", "vite");
    const { config, mode } = buildScriptOptions(root);
    const workers = isWorkersProject(root);
    const args = [vite, "build"];
    if (mode) args.push("--mode", mode);
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
    /* in node_modules: the config's own imports (vite) resolve from the project */
    const wrapper = join(root, "node_modules", ".visaljs", "vite.config.mjs");
    if (workers) {
      mkdirSync(dirname(wrapper), { recursive: true });
      writeFileSync(wrapper, WORKERS_CONFIG);
      args.push("--config", wrapper);
      if (config) env.VISALJS_VITE_CONFIG = join(root, config);
      if (mode) env.VISALJS_VITE_MODE = mode;
    } else if (config) {
      args.push("--config", config);
    }
    try {
      await promisify(execFile)(process.execPath, args, { cwd: root, maxBuffer: 64 << 20, env });
    } catch (e) {
      const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
      /* a Worker's bindings (env, KV, D1, …): there's no Node for them */
      const cloudflare = /failed to resolve import "(cloudflare:[\w-]+)" from "([^"]+)"/.exec(stdout + stderr);
      if (workers && cloudflare) {
        throw new FrameworkError(`${relative(root, cloudflare[2]!)} imports ${cloudflare[1]}: Cloudflare Workers' own APIs (bindings: env, KV, D1, …) ` +
          "have no Node equivalent, so visaljs can't build this app for Node");
      }
      const output = `${stdout}${stderr}`.trimEnd().split("\n").slice(-30).join("\n");
      throw new FrameworkError(`vite build failed in ${root}:\n${output}`);
    } finally {
      if (workers) rmSync(dirname(wrapper), { recursive: true, force: true });
    }
    return workers ? "Built the app for Node with vite build, without its Cloudflare plugin (dist/)" : "Built the app with vite build (dist/)";
  },

  entry(root) {
    if (!existsSync(join(root, MARKER))) {
      throw new FrameworkError(`${root} has no vinext build (no ${MARKER}): run \`vite build\`, or build without --no-framework-build`);
    }
    if (!BUILD_ENTRIES.some((f) => existsSync(join(root, f)))) {
      throw new FrameworkError(isWorkersProject(root)
        ? `${root}'s dist/ is a Cloudflare Workers build, which has no Node server: build without --no-framework-build, and visaljs builds the app for Node`
        : `${root}'s vinext build has no Node server (${BUILD_ENTRIES.join(", ")}): this vinext setup isn't supported yet`);
    }
    /* `vinext start`'s options are the defaults ($PORT, 0.0.0.0, ./dist, compression) */
    return 'import { startProdServer } from "vinext/server/prod-server";\n' +
      "await startProdServer();\n";
  },

  plugins(root) {
    /* the server imports the build by the path it computes from ./dist: one of these files */
    const entries = BUILD_ENTRIES.filter((f) => existsSync(join(root, f)));
    const choose = entries.map((f) => `entryPath.replaceAll("\\\\", "/").endsWith(${JSON.stringify("/" + f)}) ? import(${JSON.stringify(join(root, f))}) : `).join("");
    return [{
      name: "visaljs-vinext",
      transform: {
        filter: { id: /[\\/]vinext[\\/]dist[\\/]server[\\/]prod-server\.js$/ },
        handler(code) {
          const call = "import(resolveServerEntryImportUrl(entryPath))";
          if (!code.includes(call)) this.error("vinext's prod-server.js no longer imports its build as visaljs expects: this vinext version isn't supported yet");
          /* on the same line: the module's source map still holds (map: null keeps it) */
          return { code: code.replace(call, `(${choose}Promise.reject(new Error("visaljs: the build has no " + entryPath)))`), map: null };
        },
      },
    }];
  },

  /* the packages vinext's build left external, which its server code require()s */
  requires(root) {
    const file = join(root, "dist", "server", "vinext-externals.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : [];
  },

  notes: (root) => [
    "It serves ./dist under the working directory, as `vinext start` does: run it from the project",
    ...isWorkersProject(root) ? ["Built for Node, not Workers: the project's own build still makes its Worker"] : [],
  ],
};
