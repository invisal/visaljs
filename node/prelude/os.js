// node:os: the system's facts through libuv, as Node's lib/os.js gets them,
// and the constants of the platform the program was built for.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  errnoMessage, errnoName, osConstants, osCpus, osGetPriority, osHomedir, osHostname, osInterfaces, osLoadavg, osMemory, osParallelism,
  osSetPriority, osUname, osUptime, osUserInfo,
} from "visaljs:host";
import { codeError, invalidArgType } from "./internal/errors.js";

/* Node's SystemError (ERR_SYSTEM_ERROR): "A system error occurred: uv_os_getpriority returned ESRCH
 * (no such process)", with errno, code, syscall and info */
function osError(errno, syscall) {
  const code = errnoName(errno), message = errnoMessage(errno);
  const e = codeError(Error, "ERR_SYSTEM_ERROR", `A system error occurred: ${syscall} returned ${code} (${message})`);
  e.name = "SystemError";
  e.errno = errno;
  e.syscall = syscall;
  e.info = { errno, code, message, syscall };
  return e;
}

const check = (result, syscall) => {
  if (typeof result === "number" && result < 0) throw osError(result, syscall);
  return result;
};
const uname = () => check(osUname(), "uv_os_uname");

export const EOL = process.platform === "win32" ? "\r\n" : "\n";
export const devNull = process.platform === "win32" ? "\\\\.\\nul" : "/dev/null";

export function arch() {
  return process.arch;
}

export function platform() {
  return process.platform;
}

export function endianness() {
  return "LE";
}

export function type() {
  return uname()[0];
}

export function release() {
  return uname()[1];
}

export function version() {
  return uname()[2];
}

export function machine() {
  return uname()[3];
}

export function hostname() {
  return check(osHostname(), "uv_os_gethostname");
}

export function homedir() {
  return check(osHomedir(), "uv_os_homedir");
}

/* Node's: TEMP, TMP or %SystemRoot%\temp on Windows; elsewhere TMPDIR, TMP or TEMP (getTempDir), without a trailing separator */
export function tmpdir() {
  const env = process.env;
  if (process.platform === "win32") {
    const path = env.TEMP || env.TMP || (env.SystemRoot || env.windir) + "\\temp";
    return path.length > 1 && path.endsWith("\\") && path[path.length - 2] !== ":" ? path.slice(0, -1) : path;
  }
  const dir = env.TMPDIR || env.TMP || env.TEMP;
  if (!dir) return "/tmp";
  return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
}
tmpdir[Symbol.toPrimitive] = () => tmpdir();

export function totalmem() {
  return osMemory()[0];
}

export function freemem() {
  return osMemory()[1];
}

export function uptime() {
  return check(osUptime(), "uv_uptime");
}

export function loadavg() {
  return osLoadavg();
}

export function availableParallelism() {
  return osParallelism();
}

export function cpus() {
  const list = osCpus();
  if (typeof list === "number") return [];
  return list.map(([model, speed, user, nice, sys, idle, irq]) => ({ model, speed, times: { user, nice, sys, idle, irq } }));
}

export function userInfo(options) {
  const [uid, gid, username, home, shell] = check(osUserInfo(), "uv_os_get_passwd");
  const asBuffer = options != null && typeof options === "object" && options.encoding === "buffer";
  const enc = (s) => (asBuffer && s !== null ? Buffer.from(s) : s);
  return { uid, gid, username: enc(username), homedir: enc(home), shell: enc(shell) };
}

/* the prefix length of a contiguous netmask, else null (Node's getCIDR) */
function cidrOf(address, netmask, family) {
  let ones = 0, run = true;
  if (family === "IPv4") {
    for (const part of netmask.split(".")) {
      for (let bit = 7; bit >= 0; bit--) {
        if ((Number(part) >> bit) & 1) {
          if (!run) return null;
          ones++;
        } else run = false;
      }
    }
  } else {
    const groups = expandIPv6(netmask);
    for (const group of groups) {
      for (let bit = 15; bit >= 0; bit--) {
        if ((group >> bit) & 1) {
          if (!run) return null;
          ones++;
        } else run = false;
      }
    }
  }
  return `${address}/${ones}`;
}

/* an IPv6 address's eight groups, :: expanded */
function expandIPv6(address) {
  const [head, tail] = address.includes("::") ? address.split("::") : [address, undefined];
  const parse = (s) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const left = parse(head), right = parse(tail);
  return tail === undefined ? left : [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
}

/** The network interfaces and their addresses: name → [{ address, netmask, family, mac, internal,
 *  cidr, scopeid (IPv6) }], as libuv lists them. */
export function networkInterfaces() {
  const flat = check(osInterfaces(), "uv_interface_addresses");
  const result = {};
  for (let i = 0; i < flat.length; i += 7) {
    const [name, address, netmask, family, mac, internal, scopeid] = flat.slice(i, i + 7);
    const entry = { address, netmask, family: family === 4 ? "IPv4" : "IPv6", mac, internal, cidr: null };
    entry.cidr = cidrOf(address, netmask, entry.family);
    if (family === 6) entry.scopeid = scopeid;
    (result[name] ??= []).push(entry);
  }
  return result;
}

function validatePid(pid) {
  if (typeof pid !== "number") throw invalidArgType("pid", "of type number", pid);
  if (!Number.isInteger(pid) || pid < -2147483648 || pid > 2147483647) {
    throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "pid" is out of range. It must be an integer. Received ${pid}`);
  }
}

/** A process's scheduling priority (0: this one). */
export function getPriority(pid = 0) {
  validatePid(pid);
  return check(osGetPriority(pid), "uv_os_getpriority");
}

/** setPriority([pid,] priority): -20 (highest) to 19 (lowest). */
export function setPriority(pid, priority) {
  if (priority === undefined) {
    priority = pid;
    pid = 0;
  }
  validatePid(pid);
  if (typeof priority !== "number") throw invalidArgType("priority", "of type number", priority);
  if (!Number.isInteger(priority) || priority < -20 || priority > 19) {
    throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "priority" is out of range. It must be >= -20 && <= 19. Received ${priority}`);
  }
  check(osSetPriority(pid, priority), "uv_os_setpriority");
}

function nameTable(flat) {
  const o = { __proto__: null };
  for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return Object.freeze(o);
}

const [signals, errno] = osConstants();

export const constants = Object.freeze({
  __proto__: null,
  UV_UDP_REUSEADDR: 4,
  dlopen: Object.freeze(process.platform === "darwin"
    ? { __proto__: null, RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 8, RTLD_LOCAL: 4 }
    : { __proto__: null, RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 }),
  errno: nameTable(errno),
  signals: nameTable(signals),
  priority: Object.freeze({
    __proto__: null, PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14,
    PRIORITY_HIGHEST: -20,
  }),
});

/* as Node's: `${os.hostname}` and the like give their value */
for (const f of [availableParallelism, freemem, hostname, version, type, release, machine, homedir, totalmem, uptime, arch, platform, endianness]) {
  f[Symbol.toPrimitive] = () => f();
}

/* as Node's module object: EOL and devNull read-only (but configurable), constants fixed */
export default Object.defineProperties({
  arch, availableParallelism, cpus, endianness, freemem, getPriority, homedir, hostname, loadavg, networkInterfaces, platform, release,
  setPriority, tmpdir, totalmem, type, userInfo, uptime, version, machine,
}, {
  constants: { configurable: false, enumerable: true, value: constants },
  EOL: { configurable: true, enumerable: true, writable: false, value: EOL },
  devNull: { configurable: true, enumerable: true, writable: false, value: devNull },
});
