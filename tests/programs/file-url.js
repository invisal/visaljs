// node:url's file-URL helpers, POSIX and Windows ({ windows }), whatever the OS: paths to file
// URLs and back, UNC paths, and the errors for URLs that name no file.
import { fileURLToPath, fileURLToPathBuffer, pathToFileURL } from "node:url";

const show = (f) => {
  try {
    const r = f();
    print(Buffer.isBuffer(r) ? `<Buffer ${r.toString("hex")}>` : r instanceof URL ? r.href : JSON.stringify(r));
  } catch (e) {
    print(`${e.code}: ${e.message}`);
  }
};

for (const windows of [false, true]) {
  print(`-- windows: ${windows}`);
  const o = { windows };
  for (const p of windows
    ? ["C:\\Users\\me\\dist\\server\\index.js", "c:\\a b\\#x?y%z\\", "C:/mixed/slashes", "D:\\tab\there", "\\\\server\\share\\file.txt",
      "\\\\?\\UNC\\server\\share\\x", "\\\\server", "\\\\\\x", "C:\\Ünïcode\\😀"]
    : ["/home/me/dist/server/index.js", "/a b/#x?y%z/", "/back\\slash", "/tab\there", "/Ünïcode/😀"]) {
    show(() => pathToFileURL(p, o));
    show(() => fileURLToPath(pathToFileURL(p, o), o));
  }
  for (const u of ["file:///C:/Users/me/x.js", "file:///c%3A/encoded/colon", "file://server/share/f", "file://xn--nxasmq6b/s/f",
    "file:///a%2Fb", "file:///C:/a%5Cb", "file:///no/drive", "file:///C:/sp%20ace/%E2%82%AC", "file:///C:/bad%FF"]) {
    show(() => fileURLToPath(u, o));
    show(() => fileURLToPathBuffer(u, o));
  }
}
print("-- errors");
show(() => fileURLToPath("http://x/y"));
show(() => fileURLToPath(42));
show(() => pathToFileURL(42));
show(() => fileURLToPath(new URL("file:///x/y")));
