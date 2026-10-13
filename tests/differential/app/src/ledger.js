export class Ledger {
  #entries = [];
  constructor(currency) { this.currency = currency; }
  add(name, amount) { this.#entries.push({ name, amount }); }
  get total() {
    let t = 0;
    for (const e of this.#entries) t += e.amount;
    return t;
  }
  summary() {
    return this.#entries.map((e) => e.name + ": " + e.amount + " " + this.currency).join("\n") + "\n";
  }
}
