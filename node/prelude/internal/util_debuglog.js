// util.debuglog (util.debug): loggers for NODE_DEBUG's sections. Linked into programs that name it
// (internal/features.js).
import { format, formatWithOptions, inspect } from "../util.js";
import { features } from "./features.js";

/* NODE_DEBUG's sections, as a test: a comma-separated list, * a wildcard */
let debugEnabled;
const debugImpls = Object.create(null);

function testDebugEnabled(section) {
  if (debugEnabled === undefined) {
    const env = process.env.NODE_DEBUG;
    if (env) {
      const pattern = env.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*").replaceAll(",", "$|^");
      const regex = new RegExp(`^${pattern}$`, "i");
      debugEnabled = (str) => regex.exec(str) !== null;
    } else debugEnabled = () => false;
  }
  return debugEnabled(section);
}

function debuglogImpl(enabled, set) {
  if (debugImpls[set] === undefined) {
    if (enabled) {
      const pid = process.pid;
      if (set === "HTTP" || set === "HTTP2") {
        process.emitWarning("Setting the NODE_DEBUG environment variable to '" + set.toLowerCase() +
          "' can expose sensitive data (such as passwords, tokens and authentication headers) in the resulting log.");
      }
      debugImpls[set] = function debug(...args) {
        process.stderr.write(format("%s %s: %s\n", set, inspect(pid), formatWithOptions({ colors: false }, ...args)));
      };
    } else debugImpls[set] = () => {};
  }
  return debugImpls[set];
}

/** A logger for the section, writing to stderr when NODE_DEBUG names it (decided when first
 *  used); `enabled` says whether it does. */
function debuglog(set, cb) {
  let enabled;
  const init = () => {
    set = set.toUpperCase();
    enabled = testDebugEnabled(set);
  };
  let debug = (...args) => {
    init();
    debug = debuglogImpl(enabled, set);
    if (typeof cb === "function") cb(debug);
    debug(...args);
  };
  let test = () => {
    init();
    test = () => enabled;
    return enabled;
  };
  const logger = (...args) => debug(...args);
  Object.defineProperty(logger, "enabled", {
    get() {
      return test();
    },
    configurable: true,
    enumerable: true,
  });
  return logger;
}

features.debuglog = debuglog;
