import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "rolldown";
import { describe, expect, it } from "vitest";

import { IntegrationError } from "../src/pipeline/errors.ts";
import { runPipeline } from "../src/pipeline/index.ts";
import type { BundleContext, Integration } from "../src/pipeline/types.ts";
import { Report } from "../src/report.ts";

const tempDir = () => realpathSync.native(mkdtempSync(join(tmpdir(), "visaljs-")));

function pipeline(root: string, integrations: Integration<unknown>[], options: { skipFrameworkBuild?: boolean; output?: string } = {}) {
  let reported = "";
  const report = new Report((t) => (reported += t), { live: false, color: false });
  const run = runPipeline(root, { flags: { skipFrameworkBuild: options.skipFrameworkBuild ?? false }, output: options.output, report, integrations });
  return { run, reported: () => reported };
}

/** A framework's integration: detected always, its entry generated. */
const framework = (id: string, more: Partial<Integration<unknown>> = {}): Integration<unknown> => ({
  id,
  name: id,
  provides: "entry",
  detect: () => true,
  hooks: { prepare: (ctx) => void (ctx.entrySource = `print(${JSON.stringify(id)});\n`) },
  ...more,
});

describe("the integrations' pipeline", () => {
  it("runs the stages in order, each hook with the state prepare returned", async () => {
    const root = tempDir();
    const order: string[] = [];
    const a: Integration<{ n: number }> = {
      id: "a",
      name: "A",
      provides: "entry",
      detect: () => true,
      hooks: {
        frameworkBuild: async () => void order.push("frameworkBuild"),
        prepare: (ctx) => (order.push("prepare"), (ctx.entrySource = "print(1);\n"), { n: 42 }),
        bundle: (ctx, s) => (order.push(`bundle ${s.n}`), ctx.require("pkg")),
        done: (ctx, s) => (order.push(`done ${s.n}`), ctx.note(`built ${ctx.output}`)),
      },
    };
    const { run, reported } = pipeline(root, [a as Integration<unknown>]);
    const p = await run;
    expect(p.entry).toBe(join(root, "visaljs-entry.js"));
    expect(p.output).toBe(join(root, root.split(/[\\/]/).at(-1)!));
    expect(p.extras).toMatchObject({ source: "print(1);\n", requires: ["pkg"] });
    p.done("/bin/app");
    expect(order).toEqual(["frameworkBuild", "prepare", "bundle 42", "done 42"]);
    expect(reported()).toContain(" 🧭 A A app: compiling its production server\n");
    expect(reported()).toContain("    • built /bin/app\n");
  });

  it("skips frameworkBuild with --no-framework-build", async () => {
    let built = false;
    const a = framework("a", { hooks: { frameworkBuild: async () => void (built = true), prepare: (ctx) => void (ctx.entrySource = "") } });
    await pipeline(tempDir(), [a], { skipFrameworkBuild: true }).run;
    expect(built).toBe(false);
  });

  it("leaves out an integration another overrides", async () => {
    const p = await pipeline(tempDir(), [framework("vinext", { overrides: ["next"] }), framework("next")]).run;
    expect(p.extras.source).toBe('print("vinext");\n');
  });

  it("refuses two frameworks before either builds", async () => {
    let built = false;
    const b = framework("b", { hooks: { frameworkBuild: async () => void (built = true) } });
    await expect(pipeline(tempDir(), [framework("a"), b]).run).rejects.toThrow(new IntegrationError("the project uses a and b: visaljs builds one framework's server"));
    expect(built).toBe(false);
  });

  it("lets only the integration that provides the entry set it", async () => {
    const helper: Integration<unknown> = { id: "helper", name: "helper", detect: () => true, hooks: { prepare: (ctx) => void (ctx.output = "/out") } };
    await expect(pipeline(tempDir(), [framework("a"), helper]).run).rejects.toThrow("helper sets the entry or the output");
  });

  it("takes the entry from package.json when the project uses no framework, and -o over any integration's output", async () => {
    const root = tempDir();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "api", main: "server.js" }));
    writeFileSync(join(root, "server.js"), "");
    const { run, reported } = pipeline(root, []);
    const p = await run;
    expect(p).toMatchObject({ entry: join(root, "server.js"), output: join(root, "api") });
    expect(reported()).toContain(' 📄 Entry: server.js (package.json "main")\n');
    expect(reported()).not.toContain("🧭");
    expect((await pipeline(root, [framework("next")], { output: "/out/app" }).run))
      .toMatchObject({ entry: join(root, "visaljs-entry.js"), output: "/out/app" });
  });

  it("throws when a context is used after its stage", async () => {
    let kept: BundleContext | undefined;
    const a = framework("a", { hooks: { prepare: (ctx) => void (ctx.entrySource = ""), bundle: (ctx) => void (kept = ctx) } });
    await pipeline(tempDir(), [a]).run;
    expect(() => kept!.require("late")).toThrow("an integration's context was used after its stage was over");
  });

  it("rewrites the files a rewrite names: as they are, else an error or nothing, as `missing` says", async () => {
    const a = framework("thing", {
      name: "Thing",
      hooks: {
        prepare: (ctx) => void (ctx.entrySource = ""),
        bundle(ctx) {
          ctx.rewrite({ file: /a\.js$/, find: "isDev", replace: "$&false" });
          ctx.rewrite({ file: /a\.js$/, find: /process\.env\.(\w+)/g, replace: (_, name) => JSON.stringify(name) });
          ctx.rewrite({ file: /b\.js$/, find: "gone", replace: "", missing: "skip" });
          ctx.rewrite({ file: /c\.js$/, find: "gone", replace: "" });
        },
      },
    });
    const root = tempDir();
    const [plugin] = (await pipeline(root, [a]).run).extras.plugins! as Plugin[];
    const { handler } = plugin!.transform as { handler: (this: unknown, code: string, id: string) => { code: string } | null };
    const context = { error: (message: string) => { throw new Error(message); } };
    expect(handler.call(context, "if (isDev) f(process.env.MODE);\n", join(root, "a.js"))).toEqual({ code: 'if ($&false) f("MODE");\n', map: null });
    expect(handler.call(context, "here\n", join(root, "b.js"))).toBeNull();
    expect(() => handler.call(context, "here\n", join(root, "c.js"))).toThrow("c.js no longer has the code visaljs rewrites (gone): this Thing version isn't supported yet");
  });
});
