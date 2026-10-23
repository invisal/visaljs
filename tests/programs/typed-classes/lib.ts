"use static";
import type { i32, int } from "visaljs";

import { Vec } from "./vec.ts";

/** A class another static file declares. */
export function walk(n: number): number {
  let p = new Vec(0, 0);
  const step = new Vec(1.5, -0.5);
  for (let i = 0; i < n; i++) p = p.plus(step);
  return p.dot(new Vec(2, 3));
}

class Node {
  value: number;
  next: Node | null = null;

  constructor(value: number) {
    this.value = value;
  }
}

/** Fields of the class's own type, a private one among them. */
class Stack {
  private top: Node | null = null;
  size = 0;

  push(v: number): void {
    const n = new Node(v);
    n.next = this.top;
    this.top = n;
    this.size++;
  }

  pop(): number {
    const n = this.top!;
    this.top = n.next;
    this.size--;
    return n.value;
  }

  sum(): number {
    let s = 0;
    for (let n = this.top; n !== null; n = n.next) s += n.value;
    return s;
  }
}

export function stack(n: number): string {
  const s = new Stack();
  for (let i = 0; i < n; i++) s.push(i * 2);
  const popped = s.pop() + s.pop();
  return `${s.size} ${s.sum()} ${popped}`;
}

/** Field initializers see `this`: the fields before them. */
class Counter {
  start = 10;
  current = this.start * 2;

  tick(): number {
    return ++this.current;
  }
}

export function counted(n: number): number {
  const c = new Counter();
  let last = 0;
  for (let i = 0; i < n; i++) last = c.tick();
  return last + c.start;
}

/** Arrays in fields; an arrow sees its method's `this`; an i32[] field's elements wrap as C's. */
class Histogram {
  counts: i32[] = [];
  labels: string[] = [];

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.counts.push(0);
      this.labels.push(`b${i}`);
    }
  }

  addAll(xs: number[]): void {
    const bump = (k: number) => {
      this.counts[k % this.counts.length] += 1;
    };
    for (const x of xs) bump(x);
  }

  report(): string {
    let out = "";
    for (let i = 0; i < this.counts.length; i++) out += `${this.labels[i]}=${this.counts[i]} `;
    return out;
  }
}

export function histogram(n: number): string {
  const h = new Histogram(3);
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i * i);
  h.addAll(xs);
  h.counts[2] = 2147483647;
  h.counts[2] += 1;
  return h.report();
}

/** A method's int parameter divides as C's integers. */
class Halver {
  half(n: int): number {
    return n / 2;
  }
}

export function halved(n: number): number {
  return new Halver().half(n);
}

/** A generic class, at two types; a recursive method. */
class Box<T> {
  value: T;

  constructor(value: T) {
    this.value = value;
  }

  get(): T {
    return this.value;
  }
}

class Fib {
  of(n: number): number {
    return n < 2 ? n : this.of(n - 1) + this.of(n - 2);
  }
}

export function boxed(n: number): string {
  const a = new Box<string>(`n${n}`);
  const b = new Box(new Fib().of(n));
  return `${a.get()} ${b.get()}`;
}

export function isVec(n: number): boolean {
  const v: Vec | null = n > 0 ? new Vec(n, n) : null;
  return v instanceof Vec;
}

/** A top-level function takes an instance. */
function lengthSquared(v: Vec): number {
  return v.dot(v);
}

export function measured(n: number): number {
  return lengthSquared(new Vec(n, n + 1));
}

/** A field read before the constructor set it is a TypeError (Node reads undefined). */
class Late {
  early: number;
  late: number;

  constructor(n: number) {
    this.early = this.peek();
    this.late = n;
  }

  peek(): number {
    return this.late;
  }
}

export function late(n: number): number {
  return new Late(n).early;
}

/** A field of null is JavaScript's TypeError. */
export function popEmpty(): number {
  return new Stack().pop();
}

/** A field initializer reaching a later field through a method, before its declaration defined
 *  it: a TypeError (Node reads undefined, or writes it first and redefines it after). */
class Early {
  a = this.peek();
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  f = 0;
  g = 0;
  h = 1;

  peek(): number {
    return this.h;
  }
}

class EarlyWrite {
  a = this.poke();
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  f = 0;
  g = 0;
  h = 1;

  poke(): number {
    this.h = 5;
    return 0;
  }
}

export function early(): number {
  return new Early().a;
}

export function earlyWrite(): number {
  return new EarlyWrite().h;
}
