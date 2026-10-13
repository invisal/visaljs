export type Category = "tools" | "garden" | "kitchen";

export interface Item {
  sku: string;
  name: string;
  category: Category;
  price: number;
  tags?: readonly string[];
}

export enum Stock {
  Out = 0,
  Low = 1 << 0,
  Reserved = 1 << 1,
  Discontinued = 1 << 30,
}

export class Inventory<T extends Item = Item> {
  readonly #items = new Map<string, { item: T; count: number; flags: Stock }>();

  add(item: T, count = 1): this {
    const entry = this.#items.get(item.sku);
    if (entry) entry.count += count;
    else this.#items.set(item.sku, { item, count, flags: count < 3 ? Stock.Low : Stock.Out });
    return this;
  }

  byCategory(): Record<Category, T[]> {
    const out: Record<Category, T[]> = { tools: [], garden: [], kitchen: [] };
    for (const { item } of this.#items.values()) out[item.category].push(item);
    return out;
  }

  total(): number {
    let sum = 0;
    for (const { item, count } of this.#items.values()) sum += item.price * count;
    return sum;
  }
}
