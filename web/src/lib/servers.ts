// servers.json (written by `npm run bench:servers -- --json=…`): the HTTP apps as visaljs's binary,
// Node's single executable application and Bun's compiled binary, read at build time for the front
// page's cards: binary size and memory. The last night's, from gh-pages (nightly.yml's publish job);
// bench/servers.json when that can't be fetched (offline).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Result {
  name: string;
  size?: number;
  /** resident memory, kilobytes: at rest and its highest under load */
  idle: number;
  peak: number;
  routes: { path: string; rps: number }[];
}

interface Report {
  date: string;
  node: string;
  bun: string | null;
  machine: string;
  wrk: string;
  apps: { app: string; framework?: string; version?: string; routes: string[]; results: Result[] }[];
}

/** The rows of a card, in this order; the names are bench/servers.ts's. */
const TARGETS = [
  { name: "visaljs", label: "visaljs" },
  { name: "bun (compiled)", label: "Bun" },
  { name: "node (SEA)", label: "Node" },
];

export interface Row {
  label: string;
  /** bytes */
  size: number | null;
  /** kilobytes: the highest resident memory under load */
  memory: number | null;
}

export interface Card {
  framework: string;
  app: string;
  rows: Row[];
}

const NIGHTLY = "https://invisal.github.io/visaljs/servers.json";

async function report(): Promise<Report> {
  try {
    const res = await fetch(NIGHTLY, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) return (await res.json()) as Report;
    console.warn(`${NIGHTLY}: ${res.status}, using bench/servers.json`);
  } catch (e) {
    console.warn(`${NIGHTLY}: ${(e as Error).message}, using bench/servers.json`);
  }
  /* from web/, where astro runs */
  const root = resolve(process.cwd(), "..");
  return JSON.parse(readFileSync(resolve(root, "bench/servers.json"), "utf8")) as Report;
}

/** The cards of the frameworks named, in that order. */
export async function serverCards(frameworks: string[]) {
  const data = await report();
  const cards: Card[] = frameworks.flatMap((framework) => {
    const a = data.apps.find((x) => x.framework === framework);
    if (!a) return [];
    const rows = TARGETS.map(({ name, label }) => {
      const r = a.results.find((x) => x.name === name);
      return { label, size: r?.size ?? null, memory: r?.peak ?? null };
    });
    return [{ framework, app: a.app, rows }];
  });
  return cards;
}

/** decimal megabytes, as `ls -lh --si` and file managers show them */
export const mb = (n: number) => `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`;
