# Apps

Real programs on popular npm packages, compiled by visaljs unchanged. They check that the compiler
works on code people actually ship: the HTTP differential tests run the servers under Node and
compiled, the benchmarks time them, and `bench:size` measures their binaries.

Each is its own npm package, not a workspace: its dependencies and `package-lock.json` stay in its
folder, so adding an app doesn't touch the root lockfile. Its `build` script runs the repository's
CLI by path:

```sh
npm install                       # once, at the repository root: the compiler
cd tests/apps/http-hello
npm install                       # the app's own dependencies
npm run build                     # compile to a native binary
npm run start                     # or run it under Node, to compare
```

`npm run apps:install` (at the root) installs every app. A new app needs a
`package.json` whose `"main"` is its entry file, with a `build` script like the others', and a
check in [`check.ts`](check.ts) (`APP_CHECKS`): the script refuses to run without one.

**Checks.** [`check.ts`](check.ts) compiles apps and runs each against Node. A server must answer
the same requests with the same bytes; a command-line program must print the same output, write the
same files and exit with the same status. There are two tiers:

| Tier | Apps | CI |
|---|---|---|
| `fast` | `http-hello`, `express`, `hono`, `zod` | The cross-platform check: every pull request that can change a binary, on Linux, macOS and Windows (Windows with Zig, not yet required to pass) |
| `full` | Every app | Nightly ([`nightly.yml`](../../.github/workflows/nightly.yml)) |

```sh
node tests/apps/check.ts                 # the fast tier
node tests/apps/check.ts --tier=full     # every app
node tests/apps/check.ts typescript      # the apps named
```

`express-postgres` and `mysql` run against the database from their `compose.yaml` (`npm run db` in
the app), or `VISALJS_POSTGRES_URL` / `VISALJS_MYSQL_URL`. The check drops their tables before each
side runs. Without a database they're skipped; with `--require-databases` (as in CI), that's a failure.

**Binary sizes.** `npm run bench:size` builds every app (or those named:
`npm run bench:size -- hono express`) with visaljs, as Node's single executable application and
with `bun build --compile`, and writes [`sizes.json`](sizes.json): a JSON array of sizes in bytes (`null` where a build
failed, or for Bun without `bun` on the PATH):

```json
[
  { "example": "express", "visaljs": 6486360, "node": 125701312, "bun": 95692928 },
  { "example": "hono", "visaljs": 2459992, "node": 124849344, "bun": 94681216 }
]
```

| App | What |
|---|---|
| [`http-hello`](http-hello) | A bare `node:http` server |
| [`markdown`](markdown) | Markdown to HTML with the [`marked`](https://www.npmjs.com/package/marked) npm package: `./md2html sample.md` |
| [`zod`](zod) | Validating JSON with [Zod](https://zod.dev) 4: objects, enums, discriminated unions, regexes, defaults, transforms and `z.prettifyError`: `./validate orders.json`, `./validate invalid.json` |
| [`hono`](hono) | A [Hono](https://hono.dev) app on `@hono/node-server`: routing, JSON, middleware, cookies, streaming and SSE |
| [`express`](express) | An [Express](https://expressjs.com) 5 app (CommonJS): routing, routers, body parsing, cookies, content negotiation and error handlers |
| [`express-postgres`](express-postgres) | A small task tracker: Express 5 and [PostgreSQL](https://www.postgresql.org) through [`pg`](https://node-postgres.com): a connection pool, parameterized queries, a transaction, validation, and Postgres errors as HTTP statuses |
| [`mysql`](mysql) | A command-line to-do list in [MySQL](https://www.mysql.com) through [`mysql2`](https://sidorares.github.io/node-mysql2/docs): a pool, `?` placeholders and a transaction: `./todo add "Buy milk" --due 2026-12-24`, `./todo list`, `./todo done 1` |
| [`typescript`](typescript) | TypeScript's own compiler, [`tsc`](https://www.typescriptlang.org) 6 (5.4 MB of JavaScript), unchanged: `./tsc -p sample` type-checks the sample project and emits its JavaScript and declarations, with the same diagnostics and output as `npx tsc`. It reads TypeScript's `lib.*.d.ts` from `node_modules/typescript/lib`, where it was built (`__filename` is the original file's path at build time) |
| [`react-ssr`](react-ssr) | [React](https://react.dev) 19 server rendering on `node:http`: a store page streamed with `renderToPipeableStream` (`/?n=50` for 50 products). `render.js` renders it to a string in a loop and times it: `npm run bench:react-ssr` (at the root) compares that against Node |
| [`vinext`](vinext) | A Next.js App Router app on [vinext](https://github.com/cloudflare/vinext) (Next.js on Vite), unchanged: a static page, a page rendered per request, and a route handler. `npm run build` is `visaljs build`, which runs `vite build` and compiles vinext's own production server with the app (`./vinext`, run from this folder: it serves `./dist`). Its `bench:size` row has only visaljs's size: Node and Bun need an entry file |

`express-postgres` and `mysql` need a database: `npm run db` (in the app) starts one in
Docker (`compose.yaml`), or point `DATABASE_URL` at your own. They create their tables on startup.

```sh
curl -X POST localhost:3000/projects -H 'Content-Type: application/json' -d '{"name":"Website","tasks":["Design","Build"]}'
curl -X POST localhost:3000/projects/1/tasks -H 'Content-Type: application/json' -d '{"title":"Ship","due":"2026-12-24"}'
curl -X PATCH localhost:3000/tasks/1 -H 'Content-Type: application/json' -d '{"done":true}'
curl 'localhost:3000/tasks?done=false'
curl localhost:3000/projects
```

The servers listen on `$PORT` (3000 by default). The HTTP differential tests
(`tests/differential/http.test.ts`) run them under Node and compiled, and compare their responses
byte for byte; all but `express-postgres`, which needs a database the tests don't have.
