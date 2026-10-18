// The integrations (pipeline/types.ts: what one is, and the stages it runs at).
import type { Integration } from "../pipeline/types.ts";

import { next } from "./next.ts";
import { project } from "./project.ts";
import { sharp } from "./sharp.ts";
import { vinext } from "./vinext.ts";

export const INTEGRATIONS: readonly Integration<unknown>[] = [vinext, next, sharp];

/** The entry when the project uses no framework. */
export const FALLBACK: Integration<unknown> = project;
