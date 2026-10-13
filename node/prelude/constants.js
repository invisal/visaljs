// node:constants (deprecated in Node, still loaded by graceful-fs): os.constants'
// dlopen, errno, priority and signals, fs.constants and crypto.constants in one frozen object, as
// Node's lib/constants.js assigns them.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { constants as crypto } from "./crypto.js";
import { constants as fs } from "./fs.js";
import { constants as os } from "./os.js";

const constants = Object.freeze(Object.assign({}, os.dlopen, os.errno, os.priority, os.signals, fs, crypto));
export default constants;
