// vinext (Next.js on Vite, github.com/cloudflare/vinext): the server `vinext start` runs, compiled
// with the app's `vite build`. A Cloudflare Workers project (create-vinext-app's default) is built
// for Node: its own Vite config without the Cloudflare plugin (WORKERS_CONFIG).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { CommandError, IntegrationError } from "../pipeline/errors.ts";
import { dependencies, packageBin, packageJson } from "../pipeline/packages.ts";
import type { Integration } from "../pipeline/types.ts";

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

export function isWorkersProject(root: string): boolean {
  return WORKERS_FILES.some((f) => existsSync(join(root, f))) || "@cloudflare/vite-plugin" in dependencies(root);
}

/* vinext refuses a Node build when a Workers config file exists, which it checks with
 * fs.existsSync: this hides them during the build, without changing the project. */
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

export const vinext: Integration = {
  name: "vinext",
  summary: "A vinext app: compiling its production server",
  overrides: ["Next.js"],
  detect: (project) => project.packages.has("vinext"),
  hooks: {
    async frameworkBuild(ctx) {
      const { root } = ctx;
      const vite = packageBin(root, "vite", "vite");
      const { config, mode } = buildScriptOptions(root);
      const workers = isWorkersProject(root);
      const args = [vite, "build"];
      if (mode) args.push("--mode", mode);
      const env: Record<string, string> = {};
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
        await ctx.run(args, { env });
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
        /* a Worker's bindings (env, KV, D1, …): there's no Node for them */
        const cloudflare = /failed to resolve import "(cloudflare:[\w-]+)" from "([^"]+)"/.exec(e.output);
        if (workers && cloudflare) {
          throw new IntegrationError(`${relative(root, cloudflare[2]!)} imports ${cloudflare[1]}: Cloudflare Workers' own APIs (bindings: env, KV, D1, …) ` +
            "have no Node equivalent, so visaljs can't build this app for Node");
        }
        throw e;
      } finally {
        if (workers) rmSync(dirname(wrapper), { recursive: true, force: true });
      }
      return workers ? "Built the app for Node with vite build, without its Cloudflare plugin (dist/)" : "Built the app with vite build (dist/)";
    },

    prepare(ctx) {
      const { root } = ctx;
      if (!existsSync(join(root, MARKER))) {
        throw new IntegrationError(`${root} has no vinext build (no ${MARKER}): run \`vite build\`, or build without --no-framework-build`);
      }
      if (!BUILD_ENTRIES.some((f) => existsSync(join(root, f)))) {
        throw new IntegrationError(isWorkersProject(root)
          ? `${root}'s dist/ is a Cloudflare Workers build, which has no Node server: build without --no-framework-build, and visaljs builds the app for Node`
          : `${root}'s vinext build has no Node server (${BUILD_ENTRIES.join(", ")}): this vinext setup isn't supported yet`);
      }
      /* `vinext start`'s options are the defaults ($PORT, 0.0.0.0, ./dist, compression) */
      ctx.entrySource = 'import { startProdServer } from "vinext/server/prod-server";\n' +
        "await startProdServer();\n";
    },

    bundle(ctx) {
      const { root } = ctx;
      /* the server imports the build by the path it computes from ./dist: one of these files */
      const entries = BUILD_ENTRIES.filter((f) => existsSync(join(root, f)));
      const choose = entries.map((f) => `entryPath.replaceAll("\\\\", "/").endsWith(${JSON.stringify("/" + f)}) ? import(${JSON.stringify(join(root, f))}) : `).join("");
      ctx.rewrite({
        file: /[\\/]vinext[\\/]dist[\\/]server[\\/]prod-server\.js$/,
        find: "import(resolveServerEntryImportUrl(entryPath))",
        replace: `(${choose}Promise.reject(new Error("visaljs: the build has no " + entryPath)))`,
      });
      /* the packages vinext's build left external, which its server code require()s */
      const externals = join(root, "dist", "server", "vinext-externals.json");
      if (existsSync(externals)) for (const name of JSON.parse(readFileSync(externals, "utf8")) as string[]) ctx.require(name);
    },

    done(ctx) {
      ctx.note("It serves ./dist under the working directory, as `vinext start` does: run it from the project");
      if (isWorkersProject(ctx.root)) ctx.note("Built for Node, not Workers: the project's own build still makes its Worker");
    },
  },
};
