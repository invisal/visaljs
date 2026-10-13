// process's members beyond the basics: the working directory and mask, time and resource figures,
// ids, getBuiltinModule, loadEnvFile, the uncaught exception capture callback, finalization,
// ref/unref, report, and the constants. What depends on the machine prints as its type.
// (finalization warns with the process id: programs.test.ts tests it.)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { chdir as importedChdir, cpuUsage as importedCpuUsage } from "node:process";

const show = (label, f) => {
  try {
    print(label + ": " + JSON.stringify(f()));
  } catch (e) {
    print(label + ": " + e.name + " " + e.code + " " + e.message.replace(process.cwd(), "CWD"));
  }
};

/* chdir and umask */
const start = process.cwd();
process.chdir("..");
print("chdir: " + (process.cwd() === path.dirname(start)));
importedChdir(start);
print("back: " + (process.cwd() === start));
show("chdir missing", () => process.chdir("/nonexistent-directory-xyz"));
show("chdir number", () => process.chdir(5));
const mask = process.umask();
show("umask set", () => process.umask("027") === mask);
show("umask now", () => process.umask());
process.umask(mask);
show("umask bad string", () => process.umask("0o22"));
show("umask negative", () => process.umask(-1));

/* time, CPU, resources, memory, the parent */
print("uptime: " + typeof process.uptime() + " " + (process.uptime() >= 0));
const cpu = process.cpuUsage();
print("cpuUsage: " + Object.keys(cpu) + " " + typeof cpu.user + " " + (importedCpuUsage(cpu).user >= 0));
show("cpuUsage negative", () => process.cpuUsage({ user: -1, system: 0 }));
show("cpuUsage string", () => process.cpuUsage({ user: "a", system: 0 }));
print("threadCpuUsage: " + Object.keys(process.threadCpuUsage()));
print("resourceUsage: " + Object.keys(process.resourceUsage()).join(","));
print("memory: " + typeof process.availableMemory() + " " + typeof process.constrainedMemory() + " ppid " + typeof process.ppid);
process.title = "renamed";
print("title: " + process.title);

/* ids: errors only (this isn't root) */
show("setuid root", () => process.setuid(0));
show("setuid unknown", () => process.setuid("no-such-user-xyz"));
show("setgid unknown", () => process.setgid("no-such-group-xyz"));
show("setuid object", () => process.setuid({}));
show("setgroups string", () => process.setgroups("x"));
print("getgroups: " + process.getgroups().every((g) => typeof g === "number"));

/* getBuiltinModule */
print("getBuiltinModule: " + typeof process.getBuiltinModule("fs").readFileSync + " " + (process.getBuiltinModule("node:path") === path) +
  " " + process.getBuiltinModule("no-such-module"));
show("getBuiltinModule number", () => process.getBuiltinModule(5));

/* loadEnvFile: what's set stays */
writeFileSync(".env", "LOADED_VAR=from file\nHOME=not this\n# comment\n");
process.loadEnvFile();
print("loadEnvFile: " + process.env.LOADED_VAR + " " + (process.env.HOME !== "not this"));
show("loadEnvFile missing", () => process.loadEnvFile("/nonexistent-xyz.env"));

/* the capture callback takes uncaught errors */
print("capture: " + process.hasUncaughtExceptionCaptureCallback());
process.setUncaughtExceptionCaptureCallback((err) => print("captured: " + err.message));
show("capture again", () => process.setUncaughtExceptionCaptureCallback(() => {}));
show("capture number", () => process.setUncaughtExceptionCaptureCallback(5));
print("capture now: " + process.hasUncaughtExceptionCaptureCallback());
setTimeout(() => {
  throw new Error("thrown in a timer");
}, 0);
await new Promise((resolve) => setTimeout(resolve, 20));
process.setUncaughtExceptionCaptureCallback(null);

/* ref and unref call what an object offers */
const refable = { [Symbol.for("nodejs.ref")]: () => print("ref called"), unref: () => print("unref called") };
process.ref(refable);
process.unref(refable);
process.ref(null);

/* the constants */
print("release: " + process.release.name + " " + process.release.lts + " " + process.release.sourceUrl.endsWith(`${process.version}.tar.gz`));
print("config: " + Object.isFrozen(process.config) + " " + Object.keys(process.config).join(","));
print("flags: " + (process.allowedNodeEnvironmentFlags instanceof Set) + " debugPort " + process.debugPort + " domain " + process.domain +
  " sourceMaps " + process.sourceMapsEnabled + " " + Array.isArray(process.moduleLoadList));
show("setSourceMapsEnabled string", () => process.setSourceMapsEnabled("x"));
print("report: " + typeof process.report.getReport + " " + (process.report.getReport().header.nodejsVersion === process.version) + " " +
  process.report.signal);
print("finalization: " + Object.keys(process.finalization).join(","));
print("functions: " + ["abort", "reallyExit", "execve", "dlopen", "binding", "openStdin", "getActiveResourcesInfo"].every((n) => typeof process[n] === "function"));
