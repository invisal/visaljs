// stream.Transform and stream.PassThrough, as Node's internal/streams/transform.js and
// passthrough.js: linked into programs that name them (implicitModules in node/index.ts,
// internal/features.js). node:zlib and node:crypto import the class directly.
import { PassThrough as PassThroughWrapper, Transform as TransformWrapper } from "../stream.js";
import { provideClass } from "./features.js";
import PassThrough from "./streams/passthrough.js";
import Transform from "./streams/transform.js";

provideClass(TransformWrapper, Transform);
provideClass(PassThroughWrapper, PassThrough);
