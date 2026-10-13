// fs.openAsBlob: a file's contents as a Blob. Linked into programs that name it (internal/features.js):
// it links the runtime's Blob.
import { readFileSync } from "../fs.js";
import { invalidArgType } from "./errors.js";
import { features } from "./features.js";

/** openAsBlob(path[, { type }]): a promise of the file's Blob (read now, as fs's other calls). */
function openAsBlob(path, options = {}) {
  if (typeof path !== "string" && !(path instanceof URL) && !(path instanceof Uint8Array)) {
    throw invalidArgType("path", "of type string or an instance of Buffer or URL", path);
  }
  if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
  const type = options.type ?? "";
  if (typeof type !== "string") throw invalidArgType("options.type", "of type string", type);
  const file = path instanceof URL ? decodeURIComponent(path.pathname) : path instanceof Uint8Array ? Buffer.from(path).toString() : path;
  return Promise.resolve(new globalThis.Blob([readFileSync(file)], { type }));
}

features.openAsBlob = openAsBlob;
