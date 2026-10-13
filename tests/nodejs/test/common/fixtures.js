// visaljs's stand-in for Node's test/common/fixtures.js. A compiled test's __dirname is where
// its source was, so fixtures resolve to the Node checkout's test/fixtures (linked next to it).
'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const fixturesDir = path.join(__dirname, '..', 'fixtures');

function fixturesPath(...args) {
  return path.join(fixturesDir, ...args);
}

function fixturesFileURL(...args) {
  return pathToFileURL(fixturesPath(...args));
}

function readFixtureSync(args, enc) {
  if (Array.isArray(args))
    return fs.readFileSync(fixturesPath(...args), enc);
  return fs.readFileSync(fixturesPath(args), enc);
}

module.exports = {
  fixturesDir,
  path: fixturesPath,
  fileURL: fixturesFileURL,
  readSync: readFixtureSync,
};
