// The modules a compiled program has only in part: what works as in Node (sea outside a single
// executable, trace_events' categories, vm's contexts, cluster as the primary, domain for
// synchronous errors, repl's constants and writer).
import cluster from "node:cluster";
import domain from "node:domain";
import repl from "node:repl";
import sea from "node:sea";
import traceEvents from "node:trace_events";
import vm from "node:vm";

process.noDeprecation = true;  /* Node warns about domains (DEP0097), with the process id */

const show = (label, f) => {
  try {
    print(label + ": " + JSON.stringify(f()));
  } catch (e) {
    print(label + ": " + e.name + " " + e.code + " " + e.message);
  }
};

show("sea", () => sea.isSea());
show("sea asset", () => sea.getAsset("x"));

const tracing = traceEvents.createTracing({ categories: ["node.perf", "v8"] });
print("trace: " + [traceEvents.getEnabledCategories(), tracing.enabled, tracing.categories].join(" "));
tracing.enable();
print("enabled: " + [tracing.enabled, traceEvents.getEnabledCategories()].join(" "));
tracing.disable();
print("disabled: " + [tracing.enabled, traceEvents.getEnabledCategories()].join(" "));
show("trace no categories", () => traceEvents.createTracing({}));

const context = vm.createContext({ a: 1 });
print("vm: " + [vm.isContext(context), vm.isContext({}), context.a, Object.keys(vm.constants).join(",")].join(" "));
show("isContext number", () => vm.isContext(1));
print("measureMemory: " + typeof vm.measureMemory);  /* Node's settles after a collection, and warns */

print("cluster: " + [cluster.isPrimary, cluster.isMaster, cluster.isWorker, cluster.SCHED_NONE, cluster.SCHED_RR, cluster.schedulingPolicy,
  JSON.stringify(cluster.workers), typeof cluster.on].join(" "));
cluster.on("setup", (settings) => print("setup: " + settings.silent + " " + typeof settings.exec));
cluster.setupPrimary({ silent: true });
await new Promise((resolve) => cluster.disconnect(resolve));
print("disconnected");

/* an error thrown in a domain ends its callback, as any uncaught error, and goes to 'error' */
const d = domain.create();
print("domain: " + [domain.active, d.constructor.name, JSON.stringify(d.members)].join(" "));
d.on("error", (err) => print("domain error: " + err.message + " " + (err.domain === d) + " " + err.domainThrown));
const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => {
  d.run(() => {
    print("inside: " + (domain.active === d) + " " + (process.domain === d));
    throw new Error("thrown in run");
  });
  print("never");
}, 0);
await later(20);
print("after run: " + domain.active);
setTimeout(() => {
  d.bind((x) => {
    throw new Error("thrown in bound " + x);
  })(1);
}, 0);
await later(20);
d.intercept((value) => print("intercepted value " + value))(null, 42);
d.intercept(() => print("never"))(new Error("intercepted error"));
const plain = domain.create();
show("no error listener", () => plain.run(() => {
  throw new Error("rethrown");
}));

print("repl: " + [typeof repl.REPL_MODE_SLOPPY, typeof repl.REPL_MODE_STRICT, repl.writer({ a: [1, 2] }), new repl.Recoverable(new Error("x")) instanceof SyntaxError].join(" "));
