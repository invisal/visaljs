// An inventory with classes, inheritance, accessors and errors, reported with console.
Error.stackTraceLimit = 0;  /* errors print as [Error: …] in both (visaljs records no frames) */

class OutOfStock extends Error {
  constructor(sku, wanted, left) {
    super("only " + left + " of " + sku + " left, " + wanted + " wanted");
    this.name = "OutOfStock";
    this.sku = sku;
  }
}

class Item {
  static count = 0;
  #stock;
  constructor(sku, name, price, stock) {
    this.sku = sku;
    this.name = name;
    this.price = price;
    this.#stock = stock;
    Item.count++;
  }
  get stock() { return this.#stock; }
  take(n) {
    if (n > this.#stock) throw new OutOfStock(this.sku, n, this.#stock);
    this.#stock -= n;
    return n * this.price;
  }
  toString() { return this.name + " (" + this.sku + ")"; }
}

class Perishable extends Item {
  constructor(sku, name, price, stock, days) {
    super(sku, name, price, stock);
    this.days = days;
  }
  take(n) {
    const cost = super.take(n);
    return this.days < 3 ? cost / 2 : cost;
  }
}

const items = [
  new Item("A-1", "hammer", 25, 4),
  new Perishable("F-7", "bread", 3, 10, 2),
  new Item("A-2", "nails", 0.05, 1000),
];
console.log(items[0], items[1]);
console.log("%d items, first is %s", Item.count, items[0]);
console.table(items);

const orders = [["A-1", 2], ["F-7", 4], ["A-1", 3], ["A-2", 250], ["Z-9", 1]];
let total = 0;
for (const [sku, n] of orders) {
  let found = null;
  for (const it of items) if (it.sku === sku) found = it;
  try {
    if (!found) throw new RangeError("unknown sku " + sku);
    const cost = found.take(n);
    total += cost;
    console.log("took", n, "x", String(found), "for", cost);
  } catch (e) {
    console.error("order failed:", e);
  }
}
console.log({ total, stock: items.map((i) => [i.sku, i.stock]) });
console.dir(items[1], { depth: 0 });
