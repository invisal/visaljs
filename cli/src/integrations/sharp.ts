// sharp wraps a native addon, which a compiled program can't load: it's left out. ERR_DLOPEN_FAILED,
// since Next reports MODULE_NOT_FOUND as "run npm install".
import type { Integration } from "../pipeline/types.ts";

export const sharp: Integration = {
  name: "sharp",
  detect: (project) => project.installed("sharp"),
  hooks: {
    bundle(ctx) {
      ctx.ignore({ module: "sharp", reason: "sharp is a native addon, which visaljs can't load", code: "ERR_DLOPEN_FAILED" });
    },
  },
};
