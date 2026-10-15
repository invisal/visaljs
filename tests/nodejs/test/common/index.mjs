// test/common for Node's ES module tests: index.js's helpers as named exports. Node's own loads
// index.js with createRequire; a default import is the same object, and the bundler can follow it.
import common from './index.js';

export const {
  allowGlobals,
  canCreateSymLink,
  escapePOSIXShell,
  expectWarning,
  mustNotMutateObjectDeep,
  expectsError,
  getArrayBufferViews,
  getBufferSources,
  invalidArgTypeHelper,
  isAIX,
  isFreeBSD,
  isIBMi,
  isInsideDirWithUnusualChars,
  isLinux,
  isMacOS,
  isOpenBSD,
  isSunOS,
  isWindows,
  mustCall,
  mustCallAtLeast,
  mustNotCall,
  mustSucceed,
  platformTimeout,
  skip,
} = common;

export default common;
