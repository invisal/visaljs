// node:worker_threads: a compiled program is one thread, the main one. What a
// program reads to find that out is as in Node's main thread (isMainThread, threadId 0, no
// parentPort or workerData), and the environment data and transfer marks work in it. Starting a
// thread (Worker) and message ports throw ERR_VISALJS_UNSUPPORTED: libraries that only load the
// module for a parallel mode (mocha's workerpool) run until asked for it.
import { notSupported } from "./internal/errors.js";

export const isMainThread = true;
export const isInternalThread = false;
export const parentPort = null;
export const workerData = null;
export const threadId = 0;
export const threadName = "";
export const resourceLimits = {};
export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");

const environmentData = new Map();
export function getEnvironmentData(key) {
  return environmentData.get(key);
}
export function setEnvironmentData(key, value) {
  if (value === undefined) environmentData.delete(key);
  else environmentData.set(key, value);
}

const untransferable = new WeakSet();
export function markAsUntransferable(object) {
  if ((typeof object === "object" && object !== null) || typeof object === "function") untransferable.add(object);
}
export function isMarkedAsUntransferable(object) {
  return ((typeof object === "object" && object !== null) || typeof object === "function") && untransferable.has(object);
}
/* nothing is sent between threads, so nothing to refuse to clone */
export function markAsUncloneable() {}

export class Worker {
  constructor() { throw notSupported("worker_threads.Worker"); }
}
export class MessageChannel {
  constructor() { throw notSupported("worker_threads.MessageChannel"); }
}
export class MessagePort {
  constructor() { throw notSupported("worker_threads.MessagePort"); }
}
export class BroadcastChannel {
  constructor() { throw notSupported("worker_threads.BroadcastChannel"); }
}
export function moveMessagePortToContext() { throw notSupported("worker_threads.moveMessagePortToContext"); }
export function receiveMessageOnPort() { throw notSupported("worker_threads.receiveMessageOnPort"); }
export function postMessageToThread() { throw notSupported("worker_threads.postMessageToThread"); }

export default {
  isMainThread, isInternalThread, parentPort, workerData, threadId, threadName, resourceLimits, SHARE_ENV,
  getEnvironmentData, setEnvironmentData, markAsUntransferable, isMarkedAsUntransferable, markAsUncloneable,
  Worker, MessageChannel, MessagePort, BroadcastChannel, moveMessagePortToContext, receiveMessageOnPort, postMessageToThread,
};
