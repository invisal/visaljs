// node:readline (internal/readline.js): Interface, createInterface, the cursor's escapes, and
// node:readline/promises as promises.
import promises from "./readline_promises.js";
import { Interface, clearLine, clearScreenDown, createInterface, cursorTo, emitKeypressEvents, moveCursor } from "./internal/readline.js";

export { Interface, clearLine, clearScreenDown, createInterface, cursorTo, emitKeypressEvents, moveCursor, promises };

export default { Interface, clearLine, clearScreenDown, createInterface, cursorTo, emitKeypressEvents, moveCursor, promises };
