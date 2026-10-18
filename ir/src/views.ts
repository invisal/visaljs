// Typed arrays with an inline view (Instr.taView): their elements read and written in C.

export type ViewKind = "i8" | "u8" | "i32" | "f64";

/** Each kind's constructor, and its JSTypedArrayType in C. */
export const VIEWS: Record<ViewKind, { ctor: string; c: string }> = {
  i8: { ctor: "Int8Array", c: "JS_TA_INT8" },
  u8: { ctor: "Uint8Array", c: "JS_TA_UINT8" },
  i32: { ctor: "Int32Array", c: "JS_TA_INT32" },
  f64: { ctor: "Float64Array", c: "JS_TA_FLOAT64" },
};

const BY_CTOR = new Map(Object.entries(VIEWS).map(([kind, v]) => [v.ctor, kind as ViewKind]));

/** The kind whose constructor is named `ctor`. */
export function viewOf(ctor: string): ViewKind | undefined {
  return BY_CTOR.get(ctor);
}
