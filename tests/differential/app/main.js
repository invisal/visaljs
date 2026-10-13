import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { inspect, format } from "node:util";
import csv from "tiny-csv";
import { tag } from "colorize";
import { Ledger } from "./src/ledger.js";
import settings from "./settings.json" with { type: "json" };

const rows = csv.parse("name,amount\nrent,1200\nfood,310.5\nbooks,42\n");
const ledger = new Ledger(settings.currency);
for (const r of rows) ledger.add(r.name, +r.amount);

const report = path.join(".", "out", "..", "report.txt");
writeFileSync(report, ledger.summary());
console.log(tag("report"), path.basename(report), existsSync(report));
console.log(readFileSync(report, "utf8"));
unlinkSync(report);
console.log(format("%s entries, %d %s", rows.length, ledger.total, settings.currency), inspect(ledger, { depth: 0 }));
console.log(csv.version, path.extname("x.tar.gz"), path.relative("/a/b/c", "/a/d"));
