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
