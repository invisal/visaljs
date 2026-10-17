// The integrations (pipeline/types.ts: what one is, and the stages it runs at), in the order each
// stage runs them.
import type { Integration } from "../pipeline/types.ts";

import { next } from "./next.ts";
import { project } from "./project.ts";
import { sharp } from "./sharp.ts";
import { vinext } from "./vinext.ts";

/* vinext first: a vinext app depends on next too. project last: the entry when no framework set one */
export const INTEGRATIONS: readonly Integration<unknown>[] = [vinext, next, sharp, project];
