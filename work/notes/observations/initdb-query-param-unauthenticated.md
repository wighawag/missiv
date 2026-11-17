---
title: _initDB=true query param triggers schema setup on any unauthenticated request
slug: initdb-query-param-unauthenticated
date: 2026-07-24
---

# `_initDB=true` runs `storage.setup()` on any request, unauthenticated

In `packages/server/src/setup.ts` the auth middleware ends with:

```ts
if (c.req.query('_initDB') == 'true') {
	await storage.setup();
}
```

This runs on EVERY route the `setup` middleware is mounted on (user / private / admin), before any account check, so an unauthenticated caller can trigger schema creation by appending `?_initDB=true` to any request. `storage.setup()` is idempotent (`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`), so the blast radius is small: no data loss, no auth bypass. But it is (1) an unauthenticated side-effect trigger and (2) a mild DoS lever, since it runs the full DDL batch per request whenever the attacker sets the flag.

## Suggested direction (not yet decided)

Gate it behind `env.DEV` (like `FAKE:` auth and `db-reset`), or move it to an explicit admin/init path, rather than honouring it on any public route. Low severity; capture-only for now.

## Update (2026-11-17, the S3 review of origin/main 79fe3ab)

The bun platform's own bootstrap depends on it: an in-memory bun database is created by POSTing `getUser?_initDB=true` (`platforms/bun/src/cli.ts:388-402`), so closing the parameter needs a replacement bootstrap at the same time (the nodejs platform's bootstrap targets a route that does not exist, see `nodejs-platform-cannot-start.md`). With no migrations (`schema-has-no-migrations-and-misaimed-indexes.md`), `setup()` is also the only way a deployed database gets new tables.
