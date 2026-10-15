// visaljs's stand-in for Node's test/common/watch.js: the skips fs.watch's tests start with. Node's
// also has the test runner's watch-mode helpers, which re-spawn node.
'use strict';
const common = require('./index.js');

function skipIfNoWatch() {
  if (common.isIBMi) {
    common.skip('IBMi does not support `fs.watch()`');
  }
  if (common.isAIX) {
    common.skip('folder watch capability is limited in AIX.');
  }
}

function skipIfNoWatchModeSignals() {
  if (common.isWindows) {
    common.skip('no signals on Windows');
  }
  skipIfNoWatch();
}

module.exports = { skipIfNoWatch, skipIfNoWatchModeSignals };
