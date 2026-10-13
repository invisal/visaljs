// util.styleText, and util.inspect's colors and styles: the SGR codes of each style. Linked into
// programs that name them (internal/features.js).
import { utilInspect } from "visaljs:host";
import { inspect } from "../util.js";
import { codeError, invalidArgType, validateString } from "./errors.js";
import { features } from "./features.js";

/* the styles: [open, close] SGR codes, and aliases that aren't enumerated */
inspect.colors = Object.assign(Object.create(null), {
  reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], blink: [5, 25], inverse: [7, 27], hidden: [8, 28],
  strikethrough: [9, 29], doubleunderline: [21, 24], black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39],
  magenta: [35, 39], cyan: [36, 39], white: [37, 39], bgBlack: [40, 49], bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49],
  bgBlue: [44, 49], bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49], framed: [51, 54], overlined: [53, 55], gray: [90, 39],
  redBright: [91, 39], greenBright: [92, 39], yellowBright: [93, 39], blueBright: [94, 39], magentaBright: [95, 39], cyanBright: [96, 39],
  whiteBright: [97, 39], bgGray: [100, 49], bgRedBright: [101, 49], bgGreenBright: [102, 49], bgYellowBright: [103, 49],
  bgBlueBright: [104, 49], bgMagentaBright: [105, 49], bgCyanBright: [106, 49], bgWhiteBright: [107, 49],
});
for (const [alias, name] of [["grey", "gray"], ["blackBright", "gray"], ["bgGrey", "bgGray"], ["bgBlackBright", "bgGray"], ["faint", "dim"],
  ["crossedout", "strikethrough"], ["strikeThrough", "strikethrough"], ["crossedOut", "strikethrough"], ["conceal", "hidden"],
  ["swapColors", "inverse"], ["swapcolors", "inverse"], ["doubleUnderline", "doubleunderline"]]) {
  Object.defineProperty(inspect.colors, alias, {
    get() {
      return this[name];
    },
    set(value) {
      Object.defineProperty(this, alias, { configurable: true, enumerable: true, writable: true, value });
    },
    configurable: true,
    enumerable: false,
  });
}
inspect.styles = Object.assign(Object.create(null), {
  special: "cyan", number: "yellow", bigint: "yellow", boolean: "yellow", undefined: "grey", null: "bold", string: "green",
  symbol: "green", date: "magenta", regexp: "red", module: "underline",
});

/* whether a stream gets colors: FORCE_COLOR says, else a terminal that NO_COLOR, NODE_DISABLE_COLORS
 * and TERM=dumb don't turn off */
function shouldColorize(stream) {
  const env = process.env;
  if (env.FORCE_COLOR !== undefined) return !["0", "false"].includes(env.FORCE_COLOR);
  if (!stream?.isTTY) return false;
  if (typeof stream.getColorDepth === "function") return stream.getColorDepth() > 2;
  return env.NO_COLOR === undefined && env.NODE_DISABLE_COLORS === undefined && env.TERM !== "dumb";
}

/** The text in the styles (a name or an array of names from inspect.colors), when the stream
 *  shows colors (validateStream: false always styles it). */
function styleText(format, text, { validateStream = true, stream = process.stdout } = {}) {
  validateString(text, "text");
  if (typeof validateStream !== "boolean") throw invalidArgType("validateStream", "of type boolean", validateStream);
  let skipColorize = false;
  if (validateStream) {
    if (stream === null || typeof stream !== "object" || (typeof stream.write !== "function" && typeof stream.getReader !== "function" && typeof stream.getWriter !== "function")) {
      throw invalidArgType("stream", "an instance of ReadableStream, WritableStream, or Stream", stream);
    }
    skipColorize = !shouldColorize(stream);
  }
  const formats = Array.isArray(format) ? format : [format];
  let left = "";
  let right = "";
  for (const key of formats) {
    if (key === "none") continue;
    const code = inspect.colors[key];
    if (code === undefined) {
      throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'format' must be one of: " +
        Object.keys(inspect.colors).map((k) => `'${k}'`).join(", ") + ". Received " + utilInspect(key));
    }
    if (skipColorize) continue;
    left += `\u001b[${code[0]}m`;
    right = `\u001b[${code[1]}m` + right;
  }
  return skipColorize ? text : `${left}${text}${right}`;
}

features.styleText = styleText;
