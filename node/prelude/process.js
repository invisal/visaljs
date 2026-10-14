// node:process: the process global, as a module.
const p = globalThis.process;

export const argv = p.argv;
export const argv0 = p.argv0;
export const arch = p.arch;
export const env = p.env;
export const execPath = p.execPath;
export const pid = p.pid;
export const platform = p.platform;
export const stderr = p.stderr;
/* made when read, by the module the driver adds when the program names it */
export const stdin = p.stdin;
export const stdout = p.stdout;
export const version = p.version;
export const versions = p.versions;
export const cwd = (...args) => p.cwd(...args);
export const emitWarning = (...args) => p.emitWarning(...args);
export const exit = (...args) => p.exit(...args);
export const hrtime = p.hrtime;
export const nextTick = (...args) => p.nextTick(...args);
export const kill = (...args) => p.kill(...args);
/* the members of internal/process_more.js, which the driver adds when the program names them:
 * called through process, so a program that imports node:process links none of them */
export const chdir = (...args) => p.chdir(...args);
export const umask = (...args) => p.umask(...args);
export const memoryUsage = (...args) => p.memoryUsage(...args);
export const uptime = (...args) => p.uptime(...args);
export const cpuUsage = (...args) => p.cpuUsage(...args);
export const threadCpuUsage = (...args) => p.threadCpuUsage(...args);
export const resourceUsage = (...args) => p.resourceUsage(...args);
export const availableMemory = (...args) => p.availableMemory(...args);
export const constrainedMemory = (...args) => p.constrainedMemory(...args);
export const setuid = (...args) => p.setuid(...args);
export const setgid = (...args) => p.setgid(...args);
export const seteuid = (...args) => p.seteuid(...args);
export const setegid = (...args) => p.setegid(...args);
export const getgroups = (...args) => p.getgroups(...args);
export const setgroups = (...args) => p.setgroups(...args);
export const initgroups = (...args) => p.initgroups(...args);
export const abort = (...args) => p.abort(...args);
export const reallyExit = (...args) => p.reallyExit(...args);
export const execve = (...args) => p.execve(...args);
export const getBuiltinModule = (...args) => p.getBuiltinModule(...args);
export const loadEnvFile = (...args) => p.loadEnvFile(...args);
export const hasUncaughtExceptionCaptureCallback = (...args) => p.hasUncaughtExceptionCaptureCallback(...args);
export const setUncaughtExceptionCaptureCallback = (...args) => p.setUncaughtExceptionCaptureCallback(...args);
export const setSourceMapsEnabled = (...args) => p.setSourceMapsEnabled(...args);
export const getActiveResourcesInfo = (...args) => p.getActiveResourcesInfo(...args);
export const openStdin = (...args) => p.openStdin(...args);
export const ref = (...args) => p.ref(...args);
export const unref = (...args) => p.unref(...args);
export const assert = (...args) => p.assert(...args);
export const binding = (...args) => p.binding(...args);
export const dlopen = (...args) => p.dlopen(...args);
/* using it gets the driver to add process's events (node/index.ts) */
export const emit = (...args) => p.emit(...args);

export default p;
