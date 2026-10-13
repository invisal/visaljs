// KeyObject's type slot (Node's kKeyType), apart from keys.js so util.types.isKeyObject can check
// for it without bringing in node:crypto.
export const kKeyType = Symbol("kKeyType");
