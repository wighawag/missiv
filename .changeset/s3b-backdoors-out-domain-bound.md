---
'missiv-common': minor
'missiv-server': minor
'missiv-client': minor
'missiv-server-nodejs': minor
'missiv-server-bun': minor
'missiv-server-cf-worker': minor
---

No backdoors, a key bound to its domain, and migrations.

- The `DEV` flag is gone, and with it `FAKE:` request authentication and the all-zero registration signature. `/api/admin/db-reset` needs `Authorization: Bearer <ADMIN_TOKEN>` and refuses every request when `ADMIN_TOKEN` is unset. `?_initDB=true` is gone. An internal error's cause and stack reach the caller only with `EXPOSE_ERRORS=true`. The bun platform's default env no longer sets `DEV=true`.
- A key acts only in the domain it is registered for: an action naming another domain is a 403.
- The profile is per domain (`name`, `description` on the domain user); the global `Users` table, `/user/getUser` and `/user/getCompleteUser` are replaced by `/user/getDomainUser` (`{domainUser}`); `domainUsername` and `domainDescription` are gone.
- The schema is numbered migration files (`packages/server/src/schema/migrations`), applied by `migrate(db)` (exported) at every platform's start, and on cf-worker by `wrangler d1 migrations apply` from the same files. Message fields are columns, message IDs are ULIDs (strings). 1.0 starts from an empty database: a 0.x database is not migrated.
- missiv-client's `API` signs every request with a delegate key (`{privateKey}`); `clear()` became `adminReset(token)`.
