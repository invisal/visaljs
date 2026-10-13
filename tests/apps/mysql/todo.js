// A to-do list kept in MySQL, from the command line: the mysql2 pool, placeholders, a
// transaction, and MySQL's errors.
//
//   ./todo add "Buy milk" [--due 2026-12-24]   ./todo list [--all]   ./todo done 3
//   ./todo rm 3                                ./todo clear          (removes the done ones)
import mysql from "mysql2/promise";

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL || "mysql://app:app@localhost:3306/app",
  connectionLimit: 4,
  /* row parsers built from static code, not generated with new Function */
  disableEval: true,
  /* a DATE column stays "YYYY-MM-DD", not a Date at local midnight */
  dateStrings: ["DATE"],
});

/* created on first use */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS todos (
    id         int AUTO_INCREMENT PRIMARY KEY,
    title      varchar(500) NOT NULL,
    done       boolean NOT NULL DEFAULT false,
    due        date,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;

class UsageError extends Error {}

function idOf(arg) {
  if (!/^\d+$/.test(arg ?? "")) throw new UsageError(`not an id: ${arg ?? "(none)"}`);
  return Number(arg);
}

const commands = {
  async add(args) {
    const due = args.indexOf("--due");
    const date = due === -1 ? null : args.splice(due, 2)[1];
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new UsageError("--due takes YYYY-MM-DD");
    const title = args.join(" ").trim();
    if (!title) throw new UsageError("add needs a title");
    const [{ insertId }] = await pool.execute("INSERT INTO todos (title, due) VALUES (?, ?)", [title, date]);
    console.log(`added #${insertId}`);
  },

  async list(args) {
    const [rows] = await pool.query(
      `SELECT id, title, done, due FROM todos ${args.includes("--all") ? "" : "WHERE NOT done"}
        ORDER BY due IS NULL, due, id`);
    if (rows.length === 0) return console.log("nothing to do");
    for (const { id, title, done, due } of rows) {
      console.log(`${done ? "[x]" : "[ ]"} ${String(id).padStart(3)}  ${title}${due ? `  (due ${due})` : ""}`);
    }
  },

  async done([arg]) {
    const [{ affectedRows }] = await pool.execute("UPDATE todos SET done = true WHERE id = ?", [idOf(arg)]);
    console.log(affectedRows ? `done #${arg}` : `no #${arg}`);
  },

  async rm([arg]) {
    const [{ affectedRows }] = await pool.execute("DELETE FROM todos WHERE id = ?", [idOf(arg)]);
    console.log(affectedRows ? `removed #${arg}` : `no #${arg}`);
  },

  /* the done ones, counted and removed together: one transaction on one pooled connection */
  async clear() {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[{ n }]] = await conn.query("SELECT count(*) AS n FROM todos WHERE done FOR UPDATE");
      await conn.query("DELETE FROM todos WHERE done");
      await conn.commit();
      console.log(`cleared ${n}`);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
};

const [name = "list", ...args] = process.argv.slice(2);
try {
  if (!Object.hasOwn(commands, name)) throw new UsageError(`unknown command: ${name} (add, list, done, rm, clear)`);
  await pool.query(SCHEMA);
  await commands[name](args);
} catch (err) {
  if (err instanceof UsageError) console.error(err.message);
  else if (err.code === "ECONNREFUSED" || err.code === "ER_ACCESS_DENIED_ERROR") console.error(`cannot reach the database: ${err.message || err.code}`);
  else console.error(`${err.code ?? "error"}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
