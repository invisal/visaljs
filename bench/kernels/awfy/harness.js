// Runs an Are We Fast Yet benchmark (src/) as the suite's own harness does with one iteration:
// innerBenchmarkLoop with the suite's argument for it (rebench.conf's), which is a repeat count
// for most benchmarks and the problem size for CD, Havlak, Mandelbrot and NBody. The benchmark
// checks its own result. Prints a line that doesn't depend on timing, so the kernels runner can
// compare visaljs's output with Node's: the suite's harness prints times, so it isn't vendored.
exports.run = (suite, name, inner) => {
  if (!suite.newInstance().innerBenchmarkLoop(inner)) throw new Error(`${name}: wrong result`);
  console.log(`${name} ${inner}: result verified`);
};
