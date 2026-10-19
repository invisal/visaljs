import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL || "postgres://app:app@localhost:55432/app", { max: 4, onnotice: () => {} });

await sql`DROP TABLE IF EXISTS pkg_postgres_users`;
await sql`CREATE TABLE pkg_postgres_users (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL,
  age int NOT NULL,
  roles text[] NOT NULL,
  profile jsonb,
  joined timestamptz NOT NULL
)`;

const users = [
  { name: "ada", age: 36, roles: ["admin"], profile: sql.json({ lang: "en" }), joined: new Date(Date.UTC(2026, 1, 1)) },
  { name: "grace", age: 45, roles: ["dev", "ops"], profile: sql.json({ lang: "en", tz: "EST" }), joined: new Date(Date.UTC(2026, 1, 2)) },
  { name: "linus", age: 29, roles: [], profile: null, joined: new Date(Date.UTC(2026, 1, 3)) },
];
const inserted = await sql`INSERT INTO pkg_postgres_users ${sql(users)} RETURNING id, name`;
console.log("inserted", inserted.map((r) => `${r.id}:${r.name}`).join(","), inserted.count);

for (const u of await sql`SELECT * FROM pkg_postgres_users ORDER BY id`) {
  console.log(u.id, u.name, u.age, JSON.stringify(u.roles), JSON.stringify(u.profile), u.joined.toISOString());
}

const minAge = 30;
const columns = ["name", "age"];
console.log("dynamic", JSON.stringify(await sql`SELECT ${sql(columns)} FROM pkg_postgres_users WHERE age > ${minAge} ORDER BY age`));
console.log("in list", (await sql`SELECT name FROM pkg_postgres_users WHERE name IN ${sql(["ada", "linus"])} ORDER BY name`).map((r) => r.name).join(","));
await sql`UPDATE pkg_postgres_users SET ${sql({ age: 37 }, "age")} WHERE name = ${"ada"}`;

try {
  await sql.begin(async (tx) => {
    await tx`UPDATE pkg_postgres_users SET age = 0`;
    throw new Error("abort");
  });
} catch (e) {
  console.log("rolled back", e.message);
}
const result = await sql.begin(async (tx) => {
  const [{ count }] = await tx`SELECT count(*)::int AS count FROM pkg_postgres_users`;
  const undone = await tx.savepoint(async (sp) => {
    await sp`DELETE FROM pkg_postgres_users`;
    throw new Error("undo");
  }).catch((e) => e.message);
  return `${count} ${undone}`;
});
console.log("transaction", result, JSON.stringify(await sql`SELECT sum(age)::int AS total FROM pkg_postgres_users`));

try {
  await sql`INSERT INTO pkg_postgres_users (name, age, roles, joined) VALUES ('ada', 1, '{}', now())`;
} catch (e) {
  console.log("duplicate", e.code, e.constraint_name);
}

const seen = [];
await sql`SELECT generate_series(1, 10) AS n`.cursor(3, async (rows) => {
  seen.push(rows.map((r) => r.n).join("+"));
});
console.log("cursor", seen.join(" | "));

const unsafe = await sql.unsafe("SELECT $1::int + $2::int AS sum", [40, 2]);
console.log("unsafe", unsafe[0].sum);

const parallel = await Promise.all([1, 2, 3, 4, 5, 6].map((k) => sql`SELECT ${k}::int * 2 AS v`));
console.log("parallel", parallel.map((r) => r[0].v).join(","));

await sql`DROP TABLE pkg_postgres_users`;
await sql.end();
console.log("done");
