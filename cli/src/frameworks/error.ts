// A framework's failure: its own module, so a framework imports it without importing the registry
// (index.ts), which imports every framework.

/** A framework's failure, as the message to print. */
export class FrameworkError extends Error {}
