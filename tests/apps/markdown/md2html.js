import fs from "node:fs";
import { marked } from "marked";

const file = process.argv[2];
if (!file) {
  console.error("usage: md2html <file.md>");
  process.exit(1);
}

process.stdout.write(marked.parse(fs.readFileSync(file, "utf8")));
