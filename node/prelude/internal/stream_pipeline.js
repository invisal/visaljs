// stream.pipeline and stream/promises' pipeline, as Node's internal/streams/pipeline.js: linked
// into programs that name pipeline (implicitModules in node/index.ts, internal/features.js).
import { features } from "./features.js";
import { pipeline, pipelineImpl } from "./streams/pipeline.js";

features.pipeline = pipeline;
features.pipelineImpl = pipelineImpl;
