// The licenses a program's binary carries: visaljs's own (the runtime is in every binary), then
// those of the third-party code the runtime and the host packages bring. Their notices must go
// with a binary that is distributed; `visaljs licenses` prints them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NOTICES, type Notice, RUNTIME_DIR } from "@visaljs/runtime";

import type { HostPackage } from "./hosts.ts";

/** visaljs's license: the repository's, or the published package's, beside runtime/. */
export const VISALJS_LICENSE = join(dirname(RUNTIME_DIR), "LICENSE");

/** The runtime's notices and the host packages', one per project (a project both bring, such as
 *  Node.js, once, with both parts in `what`). */
export function notices(hosts: readonly HostPackage[]): Notice[] {
  const byName = new Map<string, Notice>();
  for (const n of [...NOTICES, ...hosts.flatMap((h) => h.notices ?? [])]) {
    const seen = byName.get(n.name);
    if (!seen) byName.set(n.name, { ...n, files: [...n.files] });
    else {
      seen.what += `; ${n.what}`;
      for (const f of n.files) if (!seen.files.includes(f)) seen.files.push(f);
    }
  }
  return [...byName.values()];
}

/** The text to ship with a binary: visaljs's license, then each notice's files. A file whose
 *  text an earlier one already printed is named instead of repeated. */
export function licensesText(hosts: readonly HostPackage[], version: string): string {
  const rule = "=".repeat(78);
  const printed = new Map<string, string>();
  const sections = notices(hosts).map((n) => {
    const texts = n.files.map((f) => {
      const text = readFileSync(f, "utf8").trimEnd();
      const earlier = printed.get(text);
      if (earlier) return `(the same text as ${earlier}'s, above)`;
      printed.set(text, n.name);
      return text;
    });
    return `${rule}\n${n.name}: ${n.what}\nLicense: ${n.license}\n${rule}\n\n${texts.join("\n\n")}\n`;
  });
  return `A program built by visaljs ${version} holds visaljs's runtime and, of the third-party code
below, the parts the program uses. Their licenses require these notices to go with copies of the
code: ship this text with a binary you distribute, in its documentation or a file beside it.

${rule}
visaljs: the runtime
License: MIT
${rule}

${readFileSync(VISALJS_LICENSE, "utf8").trimEnd()}

${sections.join("\n")}`;
}
