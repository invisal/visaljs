// buffer.transcode: between ascii, latin1, ucs2 and utf8, "?" for what the target can't hold.
import { resolveObjectURL, transcode } from "node:buffer";

const show = (label, f) => {
  try {
    print(label + ": " + JSON.stringify([...f()]));
  } catch (e) {
    print(label + ": " + e.code + " " + e.message);
  }
};
show("utf8 to ascii", () => transcode(Buffer.from("héllo€😀"), "utf8", "ascii"));
show("utf8 to latin1", () => transcode(Buffer.from("héllo€😀"), "utf8", "latin1"));
show("utf8 to ucs2", () => transcode(Buffer.from("hé€😀"), "utf8", "ucs2"));
show("latin1 to utf8", () => transcode(Buffer.from("hé", "latin1"), "latin1", "utf8"));
show("ucs2 to utf8", () => transcode(Buffer.from("h€", "ucs2"), "UCS2", "utf-8"));
show("binary", () => transcode(Buffer.from("ab"), "utf8", "binary"));
show("Uint8Array", () => transcode(new Uint8Array([0x68, 0x69]), "utf8", "utf16le"));
show("hex", () => transcode(Buffer.from("ab"), "utf8", "hex"));
show("empty", () => transcode(Buffer.alloc(0), "utf8", "hex"));
show("string", () => transcode("str", "utf8", "ascii"));
print("resolveObjectURL: " + resolveObjectURL("blob:nodedata:1234"));
