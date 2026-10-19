import { Buffer } from "node:buffer";
import mysql from "mysql2/promise";

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL || "mysql://app:app@localhost:53306/app",
  connectionLimit: 4,
  timezone: "Z",
  // mysql2 compiles its row parsers with new Function() unless told not to; visaljs has no eval.
  disableEval: true,
});

await pool.query("DROP TABLE IF EXISTS pkg_mysql2_orders");
await pool.query(`CREATE TABLE pkg_mysql2_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  qty INT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  meta JSON,
  blob_data BLOB,
  placed DATETIME NOT NULL
)`);

for (const [i, sku] of ["A-1", "B-2", "C-3"].entries()) {
  const [r] = await pool.execute("INSERT INTO pkg_mysql2_orders (sku, qty, price, meta, blob_data, placed) VALUES (?, ?, ?, ?, ?, ?)", [
    sku, i + 1, (9.99 * (i + 1)).toFixed(2), JSON.stringify({ gift: i % 2 === 0 }), Buffer.from(sku), new Date(Date.UTC(2026, 2, i + 1, 12)),
  ]);
  console.log("inserted", sku, r.insertId, r.affectedRows);
}

const [rows, fields] = await pool.query("SELECT * FROM pkg_mysql2_orders ORDER BY id");
console.log("fields", fields.map((f) => f.name).join(","));
for (const r of rows) {
  console.log(r.id, r.sku, r.qty, r.price, JSON.stringify(r.meta), r.blob_data.toString("hex"), r.placed.toISOString());
}

const [named] = await pool.query({ sql: "SELECT sku FROM pkg_mysql2_orders WHERE qty >= :min ORDER BY qty", namedPlaceholders: true }, { min: 2 });
console.log("named", named.map((r) => r.sku).join(","));
const [arrays] = await pool.query({ sql: "SELECT sku, qty FROM pkg_mysql2_orders ORDER BY id", rowsAsArray: true });
console.log("arrays", JSON.stringify(arrays));
console.log("escape", pool.escape("it's"), mysql.format("SELECT ?? FROM t WHERE x = ?", ["col", 5]));

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  await conn.query("UPDATE pkg_mysql2_orders SET qty = qty * 100");
  await conn.rollback();
  await conn.beginTransaction();
  await conn.query("UPDATE pkg_mysql2_orders SET qty = qty + 1 WHERE sku = ?", ["A-1"]);
  await conn.commit();
} finally {
  conn.release();
}
const [[{ total }]] = await pool.query("SELECT SUM(qty) AS total FROM pkg_mysql2_orders");
console.log("after transactions", total);

try {
  await pool.execute("INSERT INTO pkg_mysql2_orders (sku, qty, price, placed) VALUES (?, 1, 1, NOW())", ["A-1"]);
} catch (e) {
  console.log("duplicate", e.code, e.errno, e.sqlState);
}
try {
  await pool.query("SELEC 1");
} catch (e) {
  console.log("syntax", e.code, e.errno);
}

const results = await Promise.all([1, 2, 3, 4, 5, 6].map((k) => pool.execute("SELECT ? * 2 AS v", [k])));
console.log("parallel", results.map(([r]) => r[0].v).join(","));

await pool.query("DROP TABLE pkg_mysql2_orders");
await pool.end();
console.log("done");
