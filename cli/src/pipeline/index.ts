// Runs a project's integrations through the stages types.ts documents.
import { execFile } from "node:child_process";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";

import type { Plugin } from "rolldown";

import type { BundleExtras, IgnoredModule } from "../bundle.ts";
import { FALLBACK, INTEGRATIONS } from "../integrations/index.ts";
import type { Report } from "../report.ts";

import { CommandError, IntegrationError } from "./errors.ts";
import { dependencies, installed, packageJson } from "./packages.ts";
import type { BundleContext, Context, DoneContext, Flags, FrameworkBuildContext, Integration, PrepareContext, Project, Rewrite } from "./types.ts";

export interface Pipeline {
  entry: string;
  /** -o's, else an integration's, else the project's directory's name, in it. */
  output: string;
  extras: Pick<BundleExtras, "source" | "plugins" | "requires" | "ignored">;
  /** The last stage, once the binary at `output` is built. */
  done(output: string): void;
}

/** The stages before bundling, for the project in `root` (absolute). `output` is -o's. */
export async function runPipeline(root: string, options: {
  flags: Flags; output: string | undefined; report: Report; integrations?: readonly Integration<unknown>[]; fallback?: Integration<unknown>;
}): Promise<Pipeline> {
  const { flags, report } = options;
  const project: Project = { root, pkg: packageJson(root), packages: new Set(Object.keys(dependencies(root))), installed: (name) => installed(root, name), flags };

  const detected = (options.integrations ?? INTEGRATIONS).filter((i) => i.detect(project));
  const replaced = new Set(detected.flatMap((i) => i.overrides ?? []));
  const kept = detected.filter((i) => !replaced.has(i.id));
  /* before any build runs: a conflict found in prepare would come after both frameworks' builds */
  const frameworks = kept.filter((i) => i.provides === "entry");
  if (frameworks.length > 1) throw new IntegrationError(`the project uses ${frameworks.map((f) => f.name).join(" and ")}: visaljs builds one framework's server`);
  const framework = frameworks[0] ?? options.fallback ?? FALLBACK;
  if (frameworks.length) report.info(` 🧭 A ${framework.name} app: compiling its production server`);
  const used = [framework, ...kept.filter((i) => i !== framework)];

  const open = <T extends object>(fields: (guard: () => void) => T) => {
    let closed = false;
    const guard = () => {
      if (closed) throw new Error("an integration's context was used after its stage was over");
    };
    const context: Context = {
      ...project,
      note(text, icon) {
        guard();
        report.info(icon ? ` ${icon} ${text}` : `    • ${text}`);
      },
      warn(message) {
        guard();
        report.warn(message);
      },
    };
    return { ctx: Object.defineProperties(context, Object.getOwnPropertyDescriptors(fields(guard))) as Context & T, close: () => (closed = true) };
  };

  if (!flags.skipFrameworkBuild) {
    for (const i of used) {
      const hook = i.hooks.frameworkBuild;
      if (!hook) continue;
      const { ctx, close } = open<Omit<FrameworkBuildContext, keyof Context>>((guard) => ({
        async run(args, { env } = {}) {
          guard();
          try {
            return await promisify(execFile)(process.execPath, args, { cwd: root, maxBuffer: 64 << 20, env: { ...process.env, FORCE_COLOR: "0", ...env } });
          } catch (e) {
            const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
            const output = `${stdout}${stderr}`;
            /* `next build`, `vite build`: the script's name, without its extension, and the command */
            const command = [basename(args[0] ?? "").replace(/\.[cm]?js$/, ""), args[1]].filter(Boolean).join(" ");
            throw new CommandError(`${command} failed in ${root}:\n${output.trimEnd().split("\n").slice(-30).join("\n")}`, output);
          }
        },
      }));
      await report.step("🏗️ ", `Building the ${i.name} app`, () => hook(ctx), (what) => what || `Built the ${i.name} app`);
      close();
    }
  }

  const decided: { entryFile?: string | undefined; entrySource?: string | undefined; output?: string | undefined } = {};
  const states = new Map<Integration<unknown>, unknown>();
  for (const i of used) {
    const hook = i.hooks.prepare;
    if (!hook) continue;
    const decide = (guard: () => void) => {
      guard();
      if (i !== framework) throw new Error(`${i.name} sets the entry or the output, which only the integration that provides the entry sets`);
    };
    const { ctx, close } = open<Omit<PrepareContext, keyof Context>>((guard) => ({
      get entryFile() {
        return decided.entryFile;
      },
      set entryFile(file) {
        decide(guard);
        decided.entryFile = file;
      },
      get entrySource() {
        return decided.entrySource;
      },
      set entrySource(source) {
        decide(guard);
        decided.entrySource = source;
      },
      get output() {
        return decided.output;
      },
      set output(file) {
        decide(guard);
        decided.output = file;
      },
    }));
    states.set(i, await hook(ctx));
    close();
  }
  const entry = decided.entryFile ?? join(root, "visaljs-entry.js");  /* generated: its imports resolve from the project */
  const output = options.output ?? decided.output ?? join(root, basename(root));

  const rewrites: (Rewrite & { by: string })[] = [];
  const plugins: Plugin[] = [];
  const requires: string[] = [];
  const ignored: IgnoredModule[] = [];
  for (const i of used) {
    const hook = i.hooks.bundle;
    if (!hook) continue;
    const { ctx, close } = open<Omit<BundleContext, keyof Context>>((guard) => ({
      entry,
      output,
      rewrite(r) {
        guard();
        rewrites.push({ ...r, by: i.name });
      },
      plugin(p) {
        guard();
        plugins.push(p);
      },
      require(name) {
        guard();
        requires.push(name);
      },
      ignore(m) {
        guard();
        ignored.push(m);
      },
    }));
    await hook(ctx, states.get(i));
    close();
  }

  return {
    entry,
    output,
    extras: { ...(decided.entrySource !== undefined && { source: decided.entrySource }), plugins: [...rewritePlugin(root, rewrites), ...plugins], requires, ignored },
    done(binary) {
      for (const i of used) {
        const hook = i.hooks.done;
        if (!hook) continue;
        const { ctx, close } = open<Omit<DoneContext, keyof Context>>(() => ({ entry, output: binary }));
        hook(ctx, states.get(i));
        close();
      }
    },
  };
}

function rewritePlugin(root: string, rewrites: readonly (Rewrite & { by: string })[]): Plugin[] {
  if (!rewrites.length) return [];
  return [{
    name: "visaljs-rewrites",
    transform: {
      filter: { id: rewrites.map((r) => r.file) },
      handler(code, id) {
        let text = code;
        for (const r of rewrites) {
          if (!r.file.test(id)) continue;
          if (typeof r.find === "string" ? !text.includes(r.find) : text.search(r.find) < 0) {
            if (r.missing === "skip") continue;
            this.error(`${relative(root, id)} no longer has the code visaljs rewrites (${String(r.find)}): this ${r.by} version isn't supported yet`);
          }
          /* a string is put in as it is: no $& patterns */
          const replace = typeof r.replace === "string" ? () => r.replace as string : r.replace;
          text = typeof r.find === "string" ? text.replaceAll(r.find, replace) : text.replace(r.find, replace);
        }
        /* the same lines: the module's source map still holds (map: null keeps it) */
        return text === code ? null : { code: text, map: null };
      },
    },
  }];
}
