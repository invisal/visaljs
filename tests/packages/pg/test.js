import { Buffer } from "node:buffer";
import pg from "pg";

const url = process.env.DATABASE_URL || "postgres://app:app@localhost:55432/app";
const pool = new pg.Pool({ connectionString: url, max: 4 });

await pool.query("DROP TABLE IF EXISTS pkg_pg_items");
await pool.query(`CREATE TABLE pkg_pg_items (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL,
  price numeric(10, 2) NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  meta jsonb,
  data bytea,
  made timestamptz
)`);

const insert = "INSERT INTO pkg_pg_items (name, price, tags, meta, data, made) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id";
for (const [i, name] of ["apple", "banana", "cherry"].entries()) {
  const { rows } = await pool.query(insert, [name, 1.25 * (i + 1), [name[0], "fruit"], { rank: i, ok: true }, Buffer.from(name), new Date(Date.UTC(2026, 0, i + 1))]);
  console.log("inserted", name, rows[0].id);
}

const { rows, fields } = await pool.query("SELECT * FROM pkg_pg_items ORDER BY id");
console.log("fields", fields.map((f) => f.name).join(","));
for (const r of rows) {
  console.log(r.id, r.name, r.price, JSON.stringify(r.tags), JSON.stringify(r.meta), r.data.toString("hex"), r.made.toISOString());
}

const named = { name: "by-price", text: "SELECT name FROM pkg_pg_items WHERE price > $1 ORDER BY price DESC", values: ["2"] };
console.log("named", (await pool.query(named)).rows.map((r) => r.name).join(","));
console.log("array mode", JSON.stringify((await pool.query({ text: "SELECT 1 + 1 AS two, 'x' AS x", rowMode: "array" })).rows));

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("UPDATE pkg_pg_items SET price = price * 10");
  await client.query("ROLLBACK");
} finally {
  client.release();
}
console.log("after rollback", (await pool.query("SELECT sum(price) AS total FROM pkg_pg_items")).rows[0].total);

try {
  await pool.query(insert, ["apple", 1, [], null, null, null]);
} catch (e) {
  console.log("duplicate", e.code, e.constraint);
}
try {
  await pool.query("SELEC 1");
} catch (e) {
  console.log("syntax", e.code, e.position);
}

const listener = new pg.Client({ connectionString: url });
await listener.connect();
const notified = new Promise((resolve) => listener.on("notification", (n) => resolve(n)));
await listener.query("LISTEN pkg_pg_channel");
await pool.query("SELECT pg_notify('pkg_pg_channel', 'hello')");
const n = await notified;
console.log("notify", n.channel, n.payload);
await listener.end();

const counts = await Promise.all([1, 2, 3, 4, 5, 6].map((k) => pool.query("SELECT $1::int * 2 AS v", [k])));
console.log("parallel", counts.map((r) => r.rows[0].v).join(","));

await pool.query("DROP TABLE pkg_pg_items");
await pool.end();
console.log("done");
