// node:stream/promises: pipeline and finished, as promises.
import { promises } from "./stream.js";

export const pipeline = promises.pipeline;
export const finished = promises.finished;

export default promises;
