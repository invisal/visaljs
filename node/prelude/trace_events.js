// node:trace_events: Tracing objects that enable and disable their categories, as Node's; a compiled
// program has no trace writer, so nothing is written (Node writes node_trace.*.log).
import { invalidArgType } from "./internal/errors.js";

/* the enabled categories, each counted by the Tracings that enable it */
const enabledCounts = new Map();

class Tracing {
  #categories;
  #enabled = false;

  constructor(categories) {
    this.#categories = categories;
  }

  get categories() {
    return this.#categories.join(",");
  }

  get enabled() {
    return this.#enabled;
  }

  enable() {
    if (this.#enabled) return;
    this.#enabled = true;
    for (const c of this.#categories) enabledCounts.set(c, (enabledCounts.get(c) ?? 0) + 1);
  }

  disable() {
    if (!this.#enabled) return;
    this.#enabled = false;
    for (const c of this.#categories) {
      const n = enabledCounts.get(c) - 1;
      if (n === 0) enabledCounts.delete(c);
      else enabledCounts.set(c, n);
    }
  }
}

export function createTracing(options) {
  if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
  if (!Array.isArray(options.categories)) throw invalidArgType("options.categories", "an instance of Array", options.categories);
  return new Tracing(options.categories.map(String));
}

/** The enabled categories, comma-separated, or undefined. */
export function getEnabledCategories() {
  return enabledCounts.size ? [...enabledCounts.keys()].join(",") : undefined;
}

export default { createTracing, getEnabledCategories };
