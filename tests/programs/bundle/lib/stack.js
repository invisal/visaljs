export class Stack {
  #items = [];
  push(x) { this.#items.push(x); }
  pop() { return this.#items.pop(); }
  get size() { return this.#items.length; }
}
export const total = (xs) => { let t = 0; for (const x of xs) t += x; return t; };
