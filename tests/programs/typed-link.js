// visaljs-expected: by hand
// Static files linked by the compiler: a private name declared in two files is each file's own,
// one static file imports another, and an int reached through a renamed import and an alias, or
// declared on an arrow's parameter, divides as C's integers (Node, erasing the types, divides as
// doubles: 1085 halvings, 8 halves, 100.33333333333333 for shadowed(301)). A number is a double
// whatever it holds: a character code divides as one.
import { both, doubled, halfCode, halves, halvings, shadowed } from "./typed-link/a.ts";
import { tripled } from "./typed-link/b.ts";

console.log(doubled(2), tripled(2), both(2), tripled(5));
console.log(halvings(1000), halves(9));
console.log(shadowed(301), shadowed(7), halfCode("a"));
