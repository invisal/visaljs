// require()s of files that aren't there: a framework's dev-only files, which its production build
// leaves out (Next.js's standalone output). visaljs builds the program, warning, and the require()
// throws when it's reached, as in Node.
if (process.env.VISALJS_NEVER_SET) require("./dev-only-file");  /* never reached: the build doesn't fail */
let missing;
try {
  require("./not-here");
} catch (e) {
  missing = e.code;
}
let addon;
try {
  require("./not-here.node");
} catch (e) {
  addon = e.code;
}
module.exports = { missing, addon };
