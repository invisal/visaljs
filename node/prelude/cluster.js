// node:cluster: a compiled program is the primary, with no workers: forking one would start a Node
// process, so fork() throws ERR_VISALJS_UNSUPPORTED. The settings, scheduling policy and events
// are Node's.
import { EventEmitter } from "./events.js";
import { notSupported } from "./internal/errors.js";

const cluster = new EventEmitter();

export const isPrimary = true;
export const isMaster = true;
export const isWorker = false;
export const SCHED_NONE = 1;
export const SCHED_RR = 2;
export const workers = {};
export const settings = {};
export let schedulingPolicy = process.platform === "win32" ? SCHED_NONE : SCHED_RR;

/** A worker: made only by fork(). */
export function Worker() {
  throw notSupported("cluster.Worker (forking a Node process)");
}
Object.setPrototypeOf(Worker.prototype, EventEmitter.prototype);

/** setupPrimary([settings]): the settings fork() would use; 'setup' follows. */
export function setupPrimary(options) {
  Object.assign(settings, { args: process.argv.slice(2), exec: process.argv[1], execArgv: process.execArgv, silent: false, ...options });
  cluster.emit("setup", settings);
}
export const setupMaster = setupPrimary;

export function fork() {
  throw notSupported("cluster.fork (forking a Node process)");
}

/** No workers to disconnect: the callback on a later tick. */
export function disconnect(callback) {
  if (typeof callback === "function") process.nextTick(callback);
}

Object.assign(cluster, {
  isPrimary, isMaster, isWorker, SCHED_NONE, SCHED_RR, workers, settings, Worker, setupPrimary, setupMaster, fork, disconnect,
});
Object.defineProperty(cluster, "schedulingPolicy", {
  get: () => schedulingPolicy,
  set: (value) => {
    schedulingPolicy = value;
  },
  enumerable: true,
  configurable: true,
});

export default cluster;
