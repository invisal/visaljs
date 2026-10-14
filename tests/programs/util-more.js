// node:util's functions beyond inspect and format: callbackify, debuglog, the system errors,
// styleText, diff, MIMEType, parseEnv, aborted, toUSVString, and the deprecated isArray and _extend
// (Node 24 removed the other is* and log).
import util, {
  MIMEType, aborted, callbackify, debuglog, diff, getSystemErrorMap, getSystemErrorMessage, getSystemErrorName, isArray,
  parseEnv, styleText, toUSVString, transferableAbortController,
} from "node:util";

/* callbackify: the value, a rejection, a falsy rejection; name and length */
{
  const ok = callbackify(async (a, b) => a + b);
  const bad = callbackify(async () => {
    throw new Error("failed");
  });
  const falsy = callbackify(() => Promise.reject(0));
  print("callbackified: " + ok.name + " " + ok.length);
  await new Promise((resolve) => ok(1, 2, (err, value) => {
    print("value: " + err + " " + value);
    resolve();
  }));
  await new Promise((resolve) => bad((err) => {
    print("rejected: " + err.message);
    resolve();
  }));
  await new Promise((resolve) => falsy((err) => {
    print("falsy: " + err.code + " " + err.reason + " " + err.message);
    resolve();
  }));
  try {
    ok(1, 2, "not a function");
  } catch (err) {
    print("no callback: " + err.code);
  }
}

/* debuglog: NODE_DEBUG isn't set, so nothing is written */
{
  const log = debuglog("mysection");
  log("hidden %d", 1);
  print("debuglog enabled: " + log.enabled + " " + (util.debug === debuglog));
}

/* the system errors */
{
  print("names: " + getSystemErrorName(-2) + " " + getSystemErrorName(-13) + " " + getSystemErrorName(-999));
  print("message: " + getSystemErrorMessage(-2));
  const map = getSystemErrorMap();
  print("map: " + (map.size > 70) + " " + JSON.stringify(map.get(-2)) + " " + JSON.stringify([...map.keys()].slice(0, 3)));
  for (const bad of [2, 1.5, "x"]) {
    try {
      getSystemErrorName(bad);
    } catch (err) {
      print("getSystemErrorName(" + JSON.stringify(bad) + "): " + err.code);
    }
  }
}

/* styleText: plain unless the stream shows colors */
{
  print("styled: " + JSON.stringify(styleText("red", "x")));
  print("forced: " + JSON.stringify(styleText(["bold", "underline", "green"], "y", { validateStream: false })));
  print("none: " + JSON.stringify(styleText("none", "z", { validateStream: false })));
  print("alias: " + JSON.stringify(styleText("grey", "g", { validateStream: false })) + " " + Object.keys(util.inspect.colors).length);
  for (const args of [["nope", "x"], ["red", 5], ["red", "x", { stream: {} }]]) {
    try {
      styleText(...args);
    } catch (err) {
      print("styleText error: " + err.code);
    }
  }
}

/* diff */
print("diff strings: " + JSON.stringify(diff("abcd", "acbd")));
print("diff arrays: " + JSON.stringify(diff(["a", "b", "x"], ["a", "c", "b"])));
print("diff same: " + JSON.stringify(diff("same", "same")) + " " + JSON.stringify(diff([], ["a"])));

/* MIMEType and MIMEParams */
{
  const m = new MIMEType('  Text/HTML ; Charset="utf-8"; q=0.9; empty=; charset=ignored; x="a\\"b"  ');
  print("mime: " + m.type + " " + m.subtype + " " + m.essence + " " + m.params.get("charset") + " " + m.params.has("empty"));
  print("mime string: " + String(m) + " " + JSON.stringify(m));
  m.params.set("boundary", "a b");
  m.params.delete("q");
  m.subtype = "Plain";
  print("mime edited: " + m + " " + [...m.params.keys()].join(","));
  for (const bad of ["text", "/html", "text/", "te xt/html"]) {
    try {
      new MIMEType(bad);
    } catch (err) {
      print("bad mime " + JSON.stringify(bad) + ": " + err.code + " " + err.message);
    }
  }
  try {
    m.params.set("bad name", "v");
  } catch (err) {
    print("bad param: " + err.message);
  }
}

/* parseEnv, toUSVString, aborted, transferableAbortController */
{
  print("parseEnv: " + JSON.stringify(parseEnv('A=1\nexport B="x\\ny"\n# c\nC = \'q\' # tail')));
  print("toUSVString: " + JSON.stringify(toUSVString("a\ud800b")));
  const ac = transferableAbortController();
  const resource = {};
  const waiting = aborted(ac.signal, resource);
  ac.abort();
  await waiting;
  print("aborted resolved");
  try {
    await aborted(ac.signal, 1);
  } catch (err) {
    print("aborted bad resource: " + err.code);
  }
}

/* deprecated: they work (their warnings, as Node's, carry the process id: not compared here) */
process.noDeprecation = true;
print("is*: " + isArray([]) + " " + typeof util.isBoolean + " " + typeof util.isFunction + " " + typeof util.log);
print("_extend: " + JSON.stringify(util._extend({ a: 1 }, { b: 2 })));
print("again: " + isArray("x"));
