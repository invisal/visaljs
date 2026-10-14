// node:test's only: run directly (not under --test), a file runs only its tests marked only, and the
// suites around them, with the global hooks (Node 24; Node 22 ran everything and warned)
import { after, before, describe, it, test } from "node:test";

before(() => console.log("global before"));
after(() => console.log("global after"));

describe("not marked", () => {
  it("is filtered out", () => console.log("unreachable"));
});

describe("marked inside", () => {
  it("is filtered out too", () => console.log("unreachable"));
  it.only("runs", () => console.log("only: runs"));
});

describe.only("marked suite", () => {
  it("runs, with its siblings", () => console.log("only: suite test"));
});

test("a test, not marked", () => console.log("unreachable"));
test.only("a test, marked", () => console.log("only: marked test"));

console.log("module code done");
