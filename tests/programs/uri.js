// The URI handling functions (§19.2.6): encodeURI(Component), decodeURI(Component), URIError
const inputs = ["http://a.b/c d?x=1&y=é#h", "a;/?:@&=+$,#-_.!~*'()", "日本\u{1F600}", "", "%"];
for (const s of inputs) console.log(encodeURI(s), encodeURIComponent(s));
for (const s of ["%E6%97%A5%F0%9F%98%80", "%3B%2F%3f%23x", "a%20b", "%41%c3%a9"]) console.log(decodeURI(s), decodeURIComponent(s));
for (const bad of ["%", "%zz", "%E6%97", "%C0%80", "%ED%A0%80", "%F4%90%80%80", "%80"]) {
  try { console.log("no error", decodeURIComponent(bad)); } catch (e) { console.log(e.name, e.message, e instanceof URIError); }
}
try { console.log(encodeURI("\uD800")); } catch (e) { console.log(e.name, e.message); }
console.log(encodeURIComponent("😀x"), encodeURI.length, encodeURI.name, decodeURI(encodeURI("ü ü")));
