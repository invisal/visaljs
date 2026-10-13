// node:punycode (RFC 3492 and IDNA's toASCII / toUnicode) and node:sys (node:util's old name).
/* sys warns as it loads (DEP0025), with the process id: loaded once deprecations are silenced */
process.noDeprecation = true;
const { default: punycode } = await import("node:punycode");
const { default: sys } = await import("node:sys");
const { default: util } = await import("node:util");

print(punycode.version + " " + punycode.encode("mañana") + " " + punycode.decode("bcher-kva") + " " + punycode.encode("☃-⌘"));
print(punycode.toASCII("mañana.com") + " " + punycode.toASCII("foo@bücher.example") + " " + punycode.toUnicode("xn--maana-pta.com"));
print(punycode.toUnicode("日本語。ＪＰ") + " " + punycode.toASCII("日本語。ＪＰ"));
print(JSON.stringify(punycode.ucs2.decode("a😀")) + " " + punycode.ucs2.encode([97, 0x1f600]));
try {
  punycode.decode("ü-");
} catch (e) {
  print(e.name + ": " + e.message);
}
print("sys is util: " + (sys === util) + " " + typeof sys.format);
