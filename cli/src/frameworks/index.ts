// Frameworks: `visaljs build <project directory>` builds what a framework's own production server
// would serve, through hooks at each stage of the build where a framework differs: what the
// project is (detect), the framework's own build (build), the entry that starts its server
// (entry), rewrites of its code the bundler needs (plugins), packages it require()s at run time
// (requires), and what the report should say about the result (notes). The stages after bundling
// are the same for every program. A framework is a module in this folder, listed in FRAMEWORKS.
import type { Plugin } from "rolldown";

import { next } from "./next.ts";
import { vinext } from "./vinext.ts";

export { FrameworkError } from "./error.ts";

export interface Framework {
  name: string;
  /** Whether the project in `root` uses this framework: from the project (its package.json), not
   *  its build output, which `build` makes. */
  detect(root: string): boolean;
  /** The framework's own build of the project (`vite build`, …), which visaljs then compiles;
   *  what it did, for the report. */
  build?(root: string): Promise<string>;
  /** The entry module's source: it starts the framework's server, as its `start` command does.
   *  FrameworkError when the build output isn't there. */
  entry(root: string): string;
  /** Rewrites of the framework's code (rolldown plugins): a dynamic import the bundler can't
   *  follow, say. */
  plugins?(root: string): Plugin[];
  /** Packages its code may require() at run time, for the bundler's require table (bundle.ts). */
  requires?(root: string): string[];
  /** What the build report says about the result (the binary at `output`): how to run it, a
   *  feature it lacks under visaljs. */
  notes?(root: string, output: string): string[];
}

/* vinext first: a vinext app depends on next too */
export const FRAMEWORKS: readonly Framework[] = [vinext, next];

/** The framework of the project in `root`, or undefined. */
export function detectFramework(root: string): Framework | undefined {
  return FRAMEWORKS.find((f) => f.detect(root));
}
