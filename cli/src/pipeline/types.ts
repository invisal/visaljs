// The pipeline's API for integrations: `visaljs build <project directory>` builds a project through
// a pipeline, and an integration is what a framework or a package adds to it where the project
// needs more than its modules bundled: the framework's own build, the entry that starts its
// server, rewrites of its code, modules it never runs, notes for the report. An integration is a
// module in integrations/, listed in its INTEGRATIONS; the runner is index.ts.
//
// The stages, in order, each run for every integration the project uses (INTEGRATIONS' order):
//
//   detect          which integrations the project uses (pure: its package.json, installed packages)
//   frameworkBuild  the framework's own build (`next build`); skipped with --no-framework-build
//   prepare         reads the build output: sets the entry and the binary's path, returns state
//   bundle          adds to the bundler: rewrites, rolldown plugins, require() table entries,
//                   ignored modules
//                   … visaljs bundles, compiles to C and links the binary …
//   done            the binary is built: notes for the report
//
// What a stage decides is there for the stages after it, read-only (the entry, the output); what a
// stage adds, it adds through its own context's methods, which throw once the stage is over. One
// integration provides the entry, and only it sets the entry and the output: the framework the
// project uses (two are an error, unless one overrides the other), else the package.json fallback.
import type { Plugin } from "rolldown";

import type { IgnoredModule } from "../bundle.ts";

import type { PackageJson } from "./packages.ts";

/** A framework or a package, as the build pipeline sees it: whether a project uses it (`detect`),
 *  and what it does at each stage (`hooks`). `S` is its state: what `prepare` returns, which the
 *  hooks after it get. */
export interface Integration<S = undefined> {
  /** What `overrides` names it by: "next". */
  id: string;
  /** Its name in the report and errors: "Next.js". */
  name: string;
  /** "entry": it's a framework, whose server is the program. It alone sets the entry and the
   *  output, and the report says "A Next.js app". */
  provides?: "entry";
  /** The ids of the integrations it replaces when both are detected: vinext's ["next"], since a
   *  vinext app depends on next too. Theirs don't run at all. */
  overrides?: readonly string[];
  /** Whether the project uses it: from the project as it is before any build (its package.json,
   *  its installed packages), never from build output, which `frameworkBuild` makes. Runs for every
   *  integration on every build: cheap, and no side effects. */
  detect(project: Project): boolean;
  /** Its work at each stage of the build, in the order they run. Each is optional. */
  hooks: Hooks<S>;
}

export interface Hooks<S> {
  /** 1. The framework's own build of the project (`next build`, `vite build`), which the stages
   *  after it compile: it runs first, and not at all with --no-framework-build
   *  (`flags.skipFrameworkBuild`), when the project's build output is used as it is. Runs its
   *  commands with `ctx.run`; returns what it did, for the report ("Built the app with next
   *  build"). IntegrationError when the build fails. */
  frameworkBuild?(ctx: FrameworkBuildContext): Promise<string | void>;

  /** 2. After the framework's build (or in its place, with --no-framework-build): reads the build
   *  output, and decides what the binary is. The integration that provides the entry sets it (`ctx.entryFile`, a file
   *  in the project, or `ctx.entrySource`, a module generated in the project's directory, whose
   *  imports resolve from there) and can set the binary's path (`ctx.output`). Returns the state
   *  `bundle` and `done` get, so what it read is read once. IntegrationError when the build output
   *  isn't there or isn't one visaljs can compile. */
  prepare?(ctx: PrepareContext): S | Promise<S>;

  /** 3. Before visaljs bundles the program from the entry: adds what the bundler needs for the
   *  project's code (`ctx.rewrite`, a change to a file's code as it's loaded; `ctx.plugin`, a
   *  rolldown plugin, for what a rewrite can't do; `ctx.require`, a package its code require()s at
   *  run time; `ctx.ignore`, a module its code requires but never runs). The entry and the output
   *  are known by now. Bundling, compiling to C and linking follow, the same for every program. */
  bundle?(ctx: BundleContext, state: S): void | Promise<void>;

  /** 4. Last, once the binary is built: what the report says about it (`ctx.note`), such as how
   *  to run it, or a feature it lacks under visaljs. Not run when the build stops before a binary
   *  (--emit-c, --dump-ir) or fails. */
  done?(ctx: DoneContext, state: S): void;
}

/** The project, as every stage and `detect` see it. */
export interface Project {
  /** Its directory: absolute. */
  readonly root: string;
  /** Its package.json, or {} without one. */
  readonly pkg: PackageJson;
  /** The packages its package.json depends on: dependencies and devDependencies. */
  readonly packages: ReadonlySet<string>;
  /** Whether a package is installed for the project, a dependency's dependency too: one a
   *  framework brings (sharp, which Next depends on). */
  installed(name: string): boolean;
  /** The command line's options an integration may follow. */
  readonly flags: Flags;
}

export interface Flags {
  /** --no-framework-build: the project's build output is compiled as it is (the runner skips
   *  `frameworkBuild`). */
  readonly skipFrameworkBuild: boolean;
}

/** What every stage's context has: the project, and the report. Each method throws once the
 *  stage is over. */
export interface Context extends Project {
  /** A line in the report (not with --quiet): under what's there ("    • text"), or with `icon`,
   *  a line of its own (" 📄 text"). */
  note(text: string, icon?: string): void;
  /** A warning: printed even with --quiet. */
  warn(message: string): void;
}

/** Given to `frameworkBuild`. */
export interface FrameworkBuildContext extends Context {
  /** Runs `node <args>` in the project, its output captured: `[packageBin(…), "build"]`. `env`
   *  adds to the environment. CommandError when it fails: the last of its output, and all of it. */
  run(args: string[], options?: { env?: Record<string, string> }): Promise<{ stdout: string; stderr: string }>;
}

/** Given to `prepare`. Only the integration that provides the entry sets these. */
export interface PrepareContext extends Context {
  /** The entry: a file in the project (absolute). */
  entryFile: string | undefined;
  /** The entry's source, generated: a module at `entryFile`, else at the project's
   *  visaljs-entry.js. */
  entrySource: string | undefined;
  /** The binary's path (absolute), unless -o gives one; by default, the project's directory's
   *  name, in it. */
  output: string | undefined;
}

/** Given to `bundle`. */
export interface BundleContext extends Context {
  /** The entry file: absolute (generated or not). */
  readonly entry: string;
  /** The binary's path: absolute. */
  readonly output: string;
  /** A change to a file's code as the bundler loads it. */
  rewrite(rewrite: Rewrite): void;
  /** A rolldown plugin, after the bundler's own. */
  plugin(plugin: Plugin): void;
  /** A package the code may require() at run time, for the bundler's require table (bundle.ts). */
  require(name: string): void;
  /** A module the program never runs, which its code still requires: left out (bundle.ts). */
  ignore(module: IgnoredModule): void;
}

/** Given to `done`. */
export interface DoneContext extends Context {
  readonly entry: string;
  /** The binary: absolute. */
  readonly output: string;
}

/** A change to the code of the files `file` matches, as the bundler loads them: `find` becomes
 *  `replace` (every match of a string; a RegExp's matches as String.prototype.replace finds them),
 *  a string as it is (no `$&` patterns), a function's result as String.prototype.replace calls it.
 *  The same number of lines, so the file's source map still holds. */
export interface Rewrite {
  file: RegExp;
  find: string | RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
  /** When the code has no `find`: "error" (the default), the build fails, saying this version of
   *  the package isn't supported; "skip", the file is left as it is (the program only bigger). */
  missing?: "error" | "skip";
}
