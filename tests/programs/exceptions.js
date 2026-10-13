// visaljs-flags: --script
function check(n) {
  if (n > 3) throw "too big: " + n;
  return n * 2;
}
function withFinally(n) {
  let trace = "";
  try {
    trace += "try;";
    if (n === 0) return trace + "early";
    trace += check(n) + ";";
  } catch (e) {
    trace += "caught " + e + ";";
  } finally {
    trace += "finally";
  }
  return trace;
}
print(withFinally(0));
print(withFinally(2));
print(withFinally(9));

function loopWithFinally() {
  let out = "";
  for (let i = 0; i < 5; i++) {
    try {
      if (i === 1) continue;
      if (i === 3) break;
      out += i;
    } finally {
      out += "f";
    }
  }
  return out;
}
print(loopWithFinally());

try {
  print(notDefined);
} catch (e) {
  print(e);
}
try {
  const c = 1;
  c = 2;
} catch (e) {
  print(e);
}
try {
  print(early);
  let early = 1;
} catch (e) {
  print(e);
}
function deep(n) {
  return deep(n + 1) + 1;
}
try {
  deep(0);
} catch (e) {
  print(e);
}
try {
  try {
    throw 1;
  } finally {
    print("inner finally");
  }
} catch (e) {
  print("outer caught " + e);
}
