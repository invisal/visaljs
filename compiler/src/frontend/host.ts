// Host primitives: the C functions host prelude code imports from
// "visaljs:host". Host packages list theirs (node/index.ts); the driver passes the table to
// the adapter (which checks imports against it) and to C emission. Only prelude modules may
// import it (the bundler checks); the compiler turns each imported name into a function
// object for its C function.

export const HOST_MODULE = "visaljs:host";

/** A directive that makes a function sloppy even in module code: the bundler gives it to the
 *  function each CommonJS module is wrapped in, since Node runs CommonJS as sloppy code. */
export const COMMONJS_DIRECTIVE = "visaljs:commonjs";

export interface HostPrimitive {
  c: string;       // its JSNativeFn (a host package's C, or the runtime's)
  length: number;
}

export type HostPrimitives = Readonly<Record<string, HostPrimitive>>;
