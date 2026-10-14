// Readable.from, as Node's internal/streams/from.js: linked into programs that name it
// (implicitModules in node/index.ts, internal/features.js).
import { features } from "./features.js";
import from from "./streams/from.js";

features.readableFrom = from;
