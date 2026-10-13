import { Stack, total } from "./lib/stack.js";
import describe, { VERSION as version } from "./lib/describe.js";
import * as shapes from "./lib/shapes.js";
import legacy from "legacy-math";
import { clamp } from "legacy-math";
import { sloppy } from "legacy-math/helpers.js";
import { greet, format } from "dual-format";
import config from "./config.json" with { type: "json" };

const s = new Stack();
s.push(1); s.push(2); s.push(3);
print(s.pop() + " " + s.size + " " + total([1, 2, 3, 4]));
print(describe(s) + " v" + version);
print(Object.keys(shapes).join(",") + " " + shapes.area(shapes.square(3)));
print(legacy.gcd(12, 18) + " " + clamp(15, 0, 10) + " " + legacy.calls);
print(greet("bundle") + " " + format);
print(config.name + " " + config.tags.join("+") + " " + config.limits.max);

const { lazyValue } = await import("./lib/lazy.js");
print("lazy: " + lazyValue());
shapes.bump();
print("live binding: " + shapes.counter);

// the same names in two files: the bundler renames one (square$1); the source map restores it
function square(n) { return n * n; }
class Shape {}
const make = () => {};
print(shapes.square.name + " " + square.name + " " + shapes.Shape.name + " " + Shape.name + " " + shapes.make.name + " " + make.name + " " + square(4));

// __filename and __dirname exist only in CommonJS modules
print(legacy.where + " " + legacy.strict + " " + typeof __filename + " " + typeof __dirname);
print("sloppy CommonJS: " + sloppy);
