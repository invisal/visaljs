import fs from "node:fs";
import { z } from "zod";

// An order file: a customer and their orders. `./validate orders.json`
const Sku = z.string().regex(/^[A-Z]{3}-\d{4}$/, "SKU like ABC-1234");

const Item = z.object({
  sku: Sku,
  quantity: z.number().int().positive(),
  price: z.number().nonnegative(),
});

const Order = z.object({
  id: z.number().int(),
  status: z.enum(["pending", "paid", "shipped"]),
  placed: z.iso.date(),
  items: z.array(Item).min(1),
  coupon: z.string().optional(),
  shipping: z.discriminatedUnion("method", [
    z.object({ method: z.literal("pickup"), store: z.string() }),
    z.object({ method: z.literal("post"), address: z.string().min(5), express: z.boolean().default(false) }),
  ]),
}).transform((o) => ({
  ...o,
  total: o.items.reduce((sum, i) => sum + i.quantity * i.price, 0),
}));

const Customer = z.object({
  name: z.string().min(1),
  email: z.email(),
  tags: z.array(z.string()).default([]),
  orders: z.array(Order),
}).strict();

const file = process.argv[2];
if (!file) {
  console.error("usage: validate <file.json>");
  process.exit(1);
}

const result = Customer.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
if (!result.success) {
  console.log(z.prettifyError(result.error));
  process.exit(1);
}

const customer = result.data;
console.log(`${customer.name} <${customer.email}>${customer.tags.length ? " [" + customer.tags.join(", ") + "]" : ""}`);
for (const order of customer.orders) {
  const how = order.shipping.method === "pickup"
    ? `pickup at ${order.shipping.store}`
    : `post to ${order.shipping.address}${order.shipping.express ? " (express)" : ""}`;
  console.log(`  #${order.id} ${order.placed} ${order.status.padEnd(7)} ${order.items.length} item(s) ${order.total.toFixed(2)} — ${how}`);
}
