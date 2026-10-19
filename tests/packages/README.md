# Packages

Popular npm packages compiled by visaljs, each with a small test of its own (`test.js`) against a
real server. Where [`tests/apps`](../apps) are programs built on packages, these check the packages
themselves: does it compile, how big is the binary, and does it work.

| Package | Server | What the test does |
|---|---|---|
| [`pg`](pg) | PostgreSQL | A pool, parameterized and named queries, arrays, `jsonb`, `bytea` and `timestamptz`, row mode, a rolled-back transaction, Postgres errors, `LISTEN`/`NOTIFY` |
| [`postgres`](postgres) | PostgreSQL | [postgres.js](https://github.com/porsager/postgres): tagged-template queries, bulk insert and dynamic columns, transactions and savepoints, a cursor, `sql.unsafe` |
| [`mysql2`](mysql2) | MySQL | A pool, prepared statements, named placeholders, rows as arrays, `JSON`, `BLOB` and `DATETIME`, transactions, MySQL errors |
| [`redis`](redis) | Redis | node-redis: strings, hashes, lists, sets, sorted sets, `MULTI`, type mapping to `Buffer`, pub/sub, `SCAN` |
| [`ioredis`](ioredis) | Redis | Strings, hashes, lists, sorted sets, pipelines, `MULTI`, a Lua command, pub/sub, `scanStream` |

[`check.ts`](check.ts) builds each package's test, records the build time and the binary's size, and
runs the test under Node and compiled: the exit status, stdout and stderr must match.

```sh
docker compose up -d --wait              # here: PostgreSQL, MySQL and Redis (compose.yaml)
node tests/packages/check.ts             # every package
node tests/packages/check.ts pg redis    # the packages named
node tests/packages/check.ts --json=packages.json
```

The servers listen on ports other than the apps' (55432, 53306, 56379), so both can run at once;
`VISALJS_POSTGRES_URL`, `VISALJS_MYSQL_URL` and `VISALJS_REDIS_URL` point the tests elsewhere. A
package whose server isn't reachable still builds, and its test is skipped (a failure with
`--require-services`, as in CI).

**Nightly** ([`nightly.yml`](../../.github/workflows/nightly.yml)) runs one job per package with only
its server, and merges their reports into `packages.json`, published to gh-pages:

```json
{
  "date": "2026-10-19",
  "node": "v24.21.0",
  "platform": "linux-x64",
  "commit": "7fa2e17…",
  "packages": [
    { "name": "pg", "version": "8.23.1", "service": "postgres", "build": "pass", "buildTime": 11.7, "size": 7549816, "test": "pass" }
  ]
}
```

`build` is `pass` or `fail`, `test` is `pass`, `fail` or `skip`; a failure has a `detail`. `size` is
in bytes (`null` when the build failed), `buildTime` in seconds.

A new package is a folder with a `package.json` (its `"main"` the test, the package pinned) and a
`package-lock.json`, and an entry in `PACKAGES` in [`check.ts`](check.ts) naming its server. Its
test cleans up what it creates (tables and keys named after the package), so the packages can share
a server, and prints only what's the same from run to run.
