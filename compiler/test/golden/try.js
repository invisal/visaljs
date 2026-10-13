function risky(n) {
  if (n > 2) throw "too big";
  return n;
}
function guarded(n) {
  let log = "";
  for (let i = 0; i < n; i++) {
    try {
      log += risky(i);
      if (i === 1) continue;
      if (i === 4) return log;
    } catch (e) {
      log += "!" + e;
      break;
    } finally {
      log += ";";
    }
  }
  return log;
}
print(guarded(5));
