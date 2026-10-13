const express = require("express");

const app = express();
app.disable("x-powered-by");

/* middleware: a response header on every route */
app.use((req, res, next) => {
  res.set("X-Powered-By", "visaljs");
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.send("Hello, Express!"));
app.get("/json", (req, res) => res.json({ ok: true, message: "hi", list: [1, 2, 3] }));
app.get("/users/:id", (req, res) => res.json({ id: req.params.id, q: req.query.q ?? null, tags: req.query.tag ?? [] }));
app.post("/echo", (req, res) => res.json({ received: req.body, type: req.get("content-type") }));
app.post("/form", (req, res) => res.json(req.body));
app.get("/html", (req, res) => res.type("html").send("<h1>Hi</h1>"));
app.get("/redirect", (req, res) => res.redirect("/json"));
app.get("/status", (req, res) => res.status(201).set("X-Custom", "yes").send("created"));
app.get("/no-content", (req, res) => res.sendStatus(204));
app.get("/cookie", (req, res) => {
  res.cookie("a", "1");
  res.cookie("b", "2", { httpOnly: true, path: "/x" });
  res.send("cookies");
});
app.get("/download", (req, res) => res.attachment("report.csv").send("a,b\n1,2\n"));
app.get("/negotiate", (req, res) =>
  res.format({
    "text/plain": () => res.send("plain"),
    "application/json": () => res.json({ format: "json" }),
    default: () => res.status(406).send("Not Acceptable"),
  }));

/* a router, mounted with its own middleware */
const api = express.Router();
api.use((req, res, next) => {
  res.set("X-Api", "v1");
  next();
});
api.get("/items", (req, res) => res.json([{ id: 1 }, { id: 2 }]));
api.get("/items/:id", (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();  // Express 5 routes have no regex params
  res.json({ id: Number(req.params.id) });
});
app.use("/api", api);

app.get("/error", () => {
  throw new Error("boom");
});
app.get("/async-error", async () => {
  throw new Error("async boom");
});
app.use((req, res) => res.status(404).send("nothing here"));
/* errors: thrown, rejected, or from middleware (a malformed JSON body is a 400) */
app.use((err, req, res, _next) =>  // four parameters: Express's mark of an error handler
  res.status(err.status ?? 500).json({ error: err.message }));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`listening on http://localhost:${port}`));
