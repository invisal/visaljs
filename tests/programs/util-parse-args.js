// util.parseArgs, case by case: long and short options, groups, values inline and apart, multiple,
// defaults, negation, positionals, the terminator, tokens, and every error.
import { parseArgs } from "node:util";

const options = {
  verbose: { type: "boolean", short: "v" },
  name: { type: "string", short: "n" },
  tag: { type: "string", short: "t", multiple: true },
  color: { type: "boolean", default: true },
  level: { type: "string", default: "info" },
  flag: { type: "boolean", short: "f", multiple: true },
};

function show(label, config) {
  try {
    const { values, positionals, tokens } = parseArgs(config);
    print(label + ": " + JSON.stringify({ values: { ...values }, positionals, tokens }));
  } catch (e) {
    print(label + ": " + e.name + " " + e.code + " " + JSON.stringify(e.message));
  }
}

show("long", { args: ["--verbose", "--name", "ada", "--tag=a", "--tag", "b"], options });
show("short", { args: ["-v", "-n", "bob", "-tx", "-t", "y"], options });
show("group", { args: ["-vf", "-fvnzed"], options });
show("defaults", { args: [], options });
show("override default", { args: ["--level", "debug", "--no-color"], options, allowNegative: true });
show("negative of a string", { args: ["--no-level"], options, allowNegative: true });
show("negative with a value", { args: ["--no-color=1"], options, allowNegative: true });
show("positionals", { args: ["a", "--verbose", "b"], options, allowPositionals: true });
show("terminator", { args: ["--verbose", "--", "--name", "-x"], options, allowPositionals: true });
show("tokens", { args: ["-vn", "x", "--", "y"], options, allowPositionals: true, tokens: true });
show("tokens inline", { args: ["--name=z", "-nq", "-t", "w"], options, tokens: true });
show("not strict", { args: ["--unknown", "--name", "-u=3", "pos", "--verbose=yes"], options, strict: false });
show("not strict tokens", { args: ["-abc", "--x=1"], strict: false, tokens: true });
show("empty value", { args: ["--name="], options });
show("value like an option", { args: ["--name", "-v"], options });
show("value like an option inline", { args: ["--name=-v"], options });
show("short value like an option", { args: ["-n", "--verbose"], options });
show("dash", { args: ["-"], options, allowPositionals: true });
show("proto", { args: ["--__proto__", "x"], options: { __proto__: { type: "string" } } });

/* errors */
show("unknown", { args: ["--nope"], options });
show("unknown short", { args: ["-z"], options, allowPositionals: true });
show("unexpected positional", { args: ["file.txt"], options });
show("missing value", { args: ["--name"], options });
show("missing short value", { args: ["-n"], options });
show("boolean with value", { args: ["--verbose=1"], options });
show("bad type", { args: [], options: { x: { type: "number" } } });
show("bad short", { args: [], options: { x: { type: "string", short: "xy" } } });
show("bad default", { args: [], options: { x: { type: "string", default: 3 } } });
show("bad multiple default", { args: [], options: { x: { type: "boolean", multiple: true, default: [true, "no"] } } });
show("bad multiple", { args: [], options: { x: { type: "boolean", multiple: "yes" } } });
show("bad args", { args: "--x", options });
show("bad args item", { args: ["--x", 1], options });
show("bad strict", { args: [], strict: "no" });
show("bad options", { args: [], options: [] });
show("bad option config", { args: [], options: { x: "string" } });
