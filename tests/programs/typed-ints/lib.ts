"use visaljs";
import type { i8, i16, i32, u8, u16 } from "visaljs";

export function wrap8(a: u8, b: u8): u8 { return a + b; }
export function wrapI8(a: i8): i8 { return a + 1; }
export function wrap16(a: u16): u16 { let x: u16 = a * 3; return x; }
export function wrapI16(a: i16, b: i16): i16 { return a * b; }
export function wrap32(a: i32, b: i32): i32 { return a * b; }
export function checksum(n: i32): u16 {
  let h: u16 = 0;
  for (let i: i32 = 0; i < n; i++) h = h * 31 + i;
  return h;
}
