// A small task tracker: projects own tasks, kept in PostgreSQL. Express routes, the pg pool,
// parameterized queries, a transaction, validation and Postgres errors mapped to HTTP statuses.
const express = require("express");
const { Pool, types } = require("pg");

/* a date column stays "YYYY-MM-DD", not a Date at local midnight */
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://app:app@localhost:5432/app",
  max: 10,
});

/* the schema, created on startup if it is not there yet */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id         serial PRIMARY KEY,
    name       text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id         serial PRIMARY KEY,
    project_id integer NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title      text NOT NULL,
    done       boolean NOT NULL DEFAULT false,
    due        date,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS tasks_project_id ON tasks (project_id);
`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* validation: a request body's fields, or a 400 */
function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${field} must be a non-empty string`);
  return value.trim();
}
function optionalDate(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  return value;
}
function id(value) {
  if (!/^\d+$/.test(value)) throw new HttpError(404, "not found");
  return Number(value);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json());

/* a log line per request, with its time */
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () =>
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`));
  next();
});

app.get("/health", async (req, res) => {
  const { rows } = await pool.query("SELECT version() AS version, now() AS now");
  res.json({ ok: true, database: rows[0].version.split(" ").slice(0, 2).join(" "), now: rows[0].now });
});

/* projects, each with its task counts */
app.get("/projects", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.created_at,
           count(t.id)::int AS tasks,
           count(t.id) FILTER (WHERE t.done)::int AS done
      FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
     GROUP BY p.id
     ORDER BY p.id`);
  res.json(rows);
});

/* a project and its first tasks, all or nothing: one transaction on one pooled client */
app.post("/projects", async (req, res) => {
  const name = text(req.body?.name, "name");
  const titles = (req.body.tasks ?? []).map((title, i) => text(title, `tasks[${i}]`));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [project] } = await client.query(
      "INSERT INTO projects (name) VALUES ($1) RETURNING id, name, created_at", [name]);
    const { rows: tasks } = await client.query(
      `INSERT INTO tasks (project_id, title)
       SELECT $1, title FROM unnest($2::text[]) WITH ORDINALITY AS t (title, n) ORDER BY n
       RETURNING id, title, done, due`, [project.id, titles]);
    await client.query("COMMIT");
    res.status(201).location(`/projects/${project.id}`).json({ ...project, tasks });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

app.get("/projects/:id", async (req, res) => {
  const { rows: [project] } = await pool.query(
    "SELECT id, name, created_at FROM projects WHERE id = $1", [id(req.params.id)]);
  if (!project) throw new HttpError(404, "not found");
  const { rows: tasks } = await pool.query(
    "SELECT id, title, done, due FROM tasks WHERE project_id = $1 ORDER BY id", [project.id]);
  res.json({ ...project, tasks });
});

app.delete("/projects/:id", async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM projects WHERE id = $1", [id(req.params.id)]);
  if (rowCount === 0) throw new HttpError(404, "not found");
  res.sendStatus(204);
});

/* tasks: filtered by ?done= and ?project=, paged by ?limit= and ?offset= */
app.get("/tasks", async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.done !== undefined) {
    params.push(req.query.done === "true");
    where.push(`done = $${params.length}`);
  }
  if (req.query.project !== undefined) {
    params.push(id(req.query.project));
    where.push(`project_id = $${params.length}`);
  }
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT id, project_id, title, done, due FROM tasks
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY due NULLS LAST, id
     LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ limit, offset, tasks: rows });
});

app.post("/projects/:id/tasks", async (req, res) => {
  const { rows: [task] } = await pool.query(
    "INSERT INTO tasks (project_id, title, due) VALUES ($1, $2, $3) RETURNING id, project_id, title, done, due",
    [id(req.params.id), text(req.body?.title, "title"), optionalDate(req.body.due, "due")]);
  res.status(201).location(`/tasks/${task.id}`).json(task);
});

/* a partial update: only the fields the body names change */
app.patch("/tasks/:id", async (req, res) => {
  const body = req.body ?? {};
  if (body.done !== undefined && typeof body.done !== "boolean") throw new HttpError(400, "done must be a boolean");
  const { rows: [task] } = await pool.query(
    `UPDATE tasks
        SET title = coalesce($2, title),
            done  = coalesce($3, done),
            due   = CASE WHEN $4 THEN $5::date ELSE due END
      WHERE id = $1
      RETURNING id, project_id, title, done, due`,
    [id(req.params.id), body.title === undefined ? null : text(body.title, "title"), body.done ?? null,
     "due" in body, optionalDate(body.due, "due")]);
  if (!task) throw new HttpError(404, "not found");
  res.json(task);
});

app.delete("/tasks/:id", async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM tasks WHERE id = $1", [id(req.params.id)]);
  if (rowCount === 0) throw new HttpError(404, "not found");
  res.sendStatus(204);
});

app.use((req, res) => res.status(404).json({ error: "not found" }));

/* errors: ours carry a status; Postgres's carry a SQLSTATE code */
const PG_STATUS = {
  "23505": [409, "already exists"],              // unique_violation
  "23503": [404, "referenced row not found"],    // foreign_key_violation
  "22P02": [400, "invalid input"],               // invalid_text_representation
  "22008": [400, "date out of range"],           // datetime_field_overflow
};
app.use((err, req, res, _next) => {
  const known = err instanceof HttpError ? [err.status, err.message] : PG_STATUS[err.code];
  if (known) return res.status(known[0]).json({ error: known[1] });
  if (err.status) return res.status(err.status).json({ error: err.message });  // e.g. malformed JSON
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = Number(process.env.PORT || 3000);
pool.query(SCHEMA).then(() => {
  app.listen(port, () => console.log(`listening on http://localhost:${port}`));
}, (err) => {
  console.error(`cannot reach the database: ${err.message || err.code}`);  // ECONNREFUSED from every address has no message
  process.exitCode = 1;
  return pool.end();
});
