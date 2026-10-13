// The web-platform-tests URL cases (tests/programs/data/wpt-url): every parse, setter and host
// result, printed, to match Node's.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* read when the program runs: bundled, the JSON would be a very large literal to compile */
const data = (name) => JSON.parse(readFileSync(join(import.meta.dirname, "data", "wpt-url", name), "utf8"));
const urltestdata = data("urltestdata.json");
const setters = data("setters_tests.json");
const toascii = data("toascii.json");

const FIELDS = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"];
const show = (u) => (u === null ? "failure" : FIELDS.map((f) => u[f]).join(" | "));
const parse = (input, base) => {
  try {
    return base === undefined || base === null ? new URL(input) : new URL(input, base);
  } catch {
    return null;
  }
};

let n = 0;
for (const t of urltestdata) {
  if (typeof t === "string") continue;
  console.log(n++, JSON.stringify(t.input), show(parse(t.input, t.base)), URL.canParse(t.input, t.base ?? undefined));
}

for (const [setter, cases] of Object.entries(setters)) {
  if (setter === "comment") continue;
  for (const t of cases) {
    const u = parse(t.href);
    if (u === null) {
      console.log(setter, "unparsable", JSON.stringify(t.href));
      continue;
    }
    u[setter] = t.new_value;
    console.log(setter, JSON.stringify(t.href), JSON.stringify(t.new_value), show(u));
  }
}

for (const t of toascii) {
  if (typeof t === "string") continue;
  const u = parse(`https://${t.input}/x`);
  const v = parse("https://example/x");
  if (v) v.hostname = t.input;
  console.log("toascii", JSON.stringify(t.input), u === null ? "failure" : u.host, v.host);
}
