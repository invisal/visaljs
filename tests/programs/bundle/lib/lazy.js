let calls = 0;
export function lazyValue() { calls++; return "loaded " + calls; }
