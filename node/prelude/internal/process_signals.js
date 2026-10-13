// process's signal events and process.kill: Node's startListeningIfSignal and
// stopListeningIfSignal, on libuv's signal handles (src/host_signal.c). A program gets this
// module when its code names process and a signal ("SIGINT") or kill (implicitModules in
// node/index.ts); apart from process_events.js, as it links libuv.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { osConstants, processKill, signalStart, signalStop } from "visaljs:host";
import { codeError, errnoException, invalidArgType } from "./errors.js";
import "./process_events.js";

const p = globalThis.process;
const signals = Object.create(null);  // "SIGINT" → 2, as os.constants.signals
const [table] = osConstants();
for (let i = 0; i < table.length; i += 2) signals[table[i]] = table[i + 1];
const watched = Object.create(null);

/* the first listener of a signal replaces its default action; listeners get (name, number) */
p.on("newListener", (type) => {
  if (typeof type !== "string" || signals[type] === undefined || watched[type]) return;
  const err = signalStart(signals[type], (signum) => p.emit(type, type, signum));
  if (err < 0) throw errnoException(err, "uv_signal_start");
  watched[type] = true;
});

/* the last one gone, the default action again */
p.on("removeListener", (type) => {
  if (typeof type !== "string" || !watched[type] || p.listenerCount(type) > 0) return;
  signalStop(signals[type]);
  watched[type] = false;
});

p.kill = function kill(pid, sig) {
  if (pid != (pid | 0)) throw invalidArgType("pid", "of type number", pid);
  let signum;
  if (sig === (sig | 0)) signum = sig;
  else {
    sig = sig || "SIGTERM";
    signum = signals[sig];
    if (signum === undefined) throw codeError(TypeError, "ERR_UNKNOWN_SIGNAL", "Unknown signal: " + sig);
  }
  const err = processKill(pid, signum);
  if (err < 0) throw errnoException(err, "kill");
  return true;
};
