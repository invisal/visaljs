// What `visaljs build` tells the user while it works: a line per step on stderr. On a terminal
// the running step spins and is redrawn as a check mark (or a red cross) with its time when it
// ends; piped, only finished steps print, without color.

export interface ReportStyle {
  /** Draw the running step and redraw it in place (a terminal). */
  live: boolean;
  color: boolean;
}

const CLEAR = "\r\x1b[2K";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Report {
  readonly #write: (text: string) => void;
  readonly #style: ReportStyle | undefined;
  readonly #start = performance.now();
  #running: { icon: string; label: string; since: number } | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #frame = 0;

  /** No style: reports nothing (--quiet, and callers that capture the CLI's output). */
  constructor(write: (text: string) => void, style: ReportStyle | undefined) {
    this.#write = write;
    this.#style = style;
  }

  /** Runs one step: `label` while it runs, then `done(result)`. A failed step is crossed out
   *  and its error rethrown, for the caller to print. The spinner turns only while the event
   *  loop is free: an asynchronous step. */
  async step<T>(icon: string, label: string, run: () => T | Promise<T>, done: (result: T) => string): Promise<T> {
    this.#running = { icon, label, since: performance.now() };
    if (this.#live) {
      this.#draw();
      this.#timer = setInterval(() => (this.#frame++, this.#draw()), 80);
      this.#timer.unref();
    }
    let result: T;
    try {
      result = await run();
    } catch (e) {
      this.#end(this.#paint("31", `✗ ${label}`));
      throw e;
    }
    this.#end(`${this.#paint("32", "✓")} ${icon} ${done(result)}`);
    return result;
  }

  /** Renames the running step (what it turned out to be doing). */
  relabel(label: string) {
    if (!this.#running) return;
    this.#running.label = label;
    if (this.#live) this.#draw();
  }

  /** A message from inside a step (a bundler warning): printed even when quiet. */
  note(text: string) {
    if (this.#live && this.#running) this.#write(CLEAR);
    this.#write(`${text}\n`);
    if (this.#live && this.#running) this.#draw();
  }

  /** A warning, after its location (`where`, if any): printed even when quiet, its label in yellow. */
  warn(message: string, where = "") {
    this.note(`${where}${this.#paint("1;33", "warning:")} ${message}`);
  }

  /** The last line, given the whole build's time. */
  finish(icon: string, text: (time: string) => string) {
    if (this.#style) this.#write(`\n ${icon} ${this.#paint("1", text(since(this.#start)))}\n`);
  }

  get #live() {
    return this.#style?.live === true;
  }

  #paint(code: string, text: string) {
    return this.#style?.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  #draw() {
    const { icon, label } = this.#running!;
    this.#write(`${CLEAR} ${this.#paint("36", FRAMES[this.#frame % FRAMES.length]!)} ${icon} ${this.#paint("2", `${label}…`)}`);
  }

  /** A multi-line `line` keeps its time on the first: the rest is detail under it. */
  #end(line: string) {
    clearInterval(this.#timer);
    const start = this.#running!.since;
    this.#running = undefined;
    const [first, ...rest] = line.split("\n");
    if (this.#style) this.#write(`${this.#live ? CLEAR : ""} ${first}  ${this.#paint("2", since(start))}\n${rest.map((l) => `${l}\n`).join("")}`);
  }
}

function since(start: number): string {
  const ms = performance.now() - start;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** 383.2 kB, 1.2 MB (decimal units). */
export function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  return bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} kB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

/** The binary's size, put in scale. */
export function sizeQuip(bytes: number): string {
  const FLOPPY = 1_474_560;
  if (bytes <= 65_536) return "small enough for a Commodore 64 🕹️";
  if (bytes <= FLOPPY) return "fits on a floppy disk 💾";
  return `${Math.ceil(bytes / FLOPPY)} floppy disks' worth 💾`;
}

/** "1 module", "1,204 lines". */
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function lineCount(text: string): number {
  let n = text.length > 0 && !text.endsWith("\n") ? 1 : 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}
