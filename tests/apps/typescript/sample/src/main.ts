import { Inventory, type Item, Stock } from "./inventory.js";

const shop = new Inventory()
  .add({ sku: "HAM-1", name: "Hammer", category: "tools", price: 12.5 }, 4)
  .add({ sku: "RAK-2", name: "Rake", category: "garden", price: 18 })
  .add({ sku: "PAN-3", name: "Pan", category: "kitchen", price: 25, tags: ["cast iron"] }, 2);

const names = (items: Item[]) => items.map((i) => i.name).join(", ");
for (const [category, items] of Object.entries(shop.byCategory())) console.log(`${category}: ${names(items)}`);
console.log(`total: ${shop.total().toFixed(2)}`, Stock[Stock.Discontinued]);

// two mistakes for tsc to find
const discount: number = "10%";
shop.add({ sku: "SAW-4", name: "Saw", category: "workshop", price: 30 });
