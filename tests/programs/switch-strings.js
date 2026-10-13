// switch on string literals (js_switch_string): the first case === the discriminant, by content
function tag(x) {
  switch (x) {
    case "div": return "block";
    case "span":
    case "a": return "inline";
    case "": return "empty";
    case "é": return "one unit";
    case "日本": return "utf-16";
    case "div": return "never: a duplicate";
    default: return "other";
    case "select": return "select";
  }
}
const heap = "di" + "v".repeat(1);              // not an atom
const rope = ["sel", "ect"].join("");           // built at run time
console.log(["div", "span", "a", "", "é", "日本", "select", "nope"].map(tag).join(" | "));
console.log(tag(heap), tag(rope), tag("divx".slice(0, 3)), tag("日本".slice(0)), tag("x".repeat(0)));
console.log(tag(1), tag(null), tag(undefined), tag(new String("div")), tag(["div"]), tag({ toString: () => "div" }));

/* fall through, and a default that falls into the cases after it */
function steps(x) {
  const out = [];
  switch (x) {
    case "one": out.push(1);
    case "two": out.push(2); break;
    default: out.push("d");
    case "three": out.push(3);
  }
  return out.join(",");
}
console.log(steps("one"), steps("two"), steps("three"), steps("four"));

/* the discriminant is evaluated once; a case that isn't a literal keeps the generic path */
let calls = 0;
const key = () => (calls++, "b");
switch (key()) { case "a": console.log("a"); break; case "b": console.log("b"); break; }
const c = "c";
switch ("c") { case "a": console.log("lit a"); break; case c: console.log("const c"); break; }
switch (2) { case "1": console.log("string 1"); break; case "2": console.log("string 2"); break; default: console.log("2 isn't \"2\""); }
console.log(calls);
