"use static";

/** Indices proven in s (from 0, below s.length): each unit read as an int32. */
export function codeSum(s: string): number {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return sum;
}

/** i <= s.length isn't proven in s: the last read is NaN, as JavaScript's. */
export function readsPastEnd(s: string): number {
  let numbers = 0;
  for (let i = 0; i <= s.length; i++) if (s.charCodeAt(i) >= 0) numbers++;
  return numbers;
}

/** `!` of a Boolean: a C bool. */
export function notUpper(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const upper = c >= 65 && c <= 90;
    if (!upper) n++;
  }
  return n;
}
