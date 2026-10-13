// Preloaded into Node by the GC benchmarks (bench/gc.ts): reports the peak resident memory at exit, as
// a visaljs program's JS_GC_STATS does.
process.on("exit", () => process.stderr.write(`[rss] ${process.resourceUsage().maxRSS * 1024}\n`));
