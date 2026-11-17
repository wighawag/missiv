---
'missiv-common': major
'missiv-server': major
'missiv-client': major
'missiv-server-nodejs': major
'missiv-server-bun': major
'missiv-server-cf-worker': major
---

missiv 1.0.0: the protocol, the server and the client are stable (S3-15). What changed since 0.3, in one place: every request is signed with delegated-identity's envelope (server origin, route, timestamp, body hash) and a key acts only in the domain it is registered for; the `DEV`/`FAKE:` paths, the all-zero registration and `_initDB` are gone, the admin API needs `ADMIN_TOKEN`; the schema is numbered migrations (`migrate()`, or `wrangler d1 migrations apply`), and 1.0 starts from an empty database (a 0.x database is not migrated); profiles are per domain; conversation IDs are derived by the server, recipients' keys checked, lists and messages paged by cursor; rejecting blocks; a newer key replaces the older; rooms run on nodejs and bun in process and the gated room is enforced; a new direct message is pushed through push-notification-server (`PUSH_SERVER_URL`, `PUSH_TOKENS`); each copy carries its sender's signature, checked by the reading client with the sender's ownership proof; the client verifies every key, sends in clear only when asked, opens each copy on its own, and its stores share one lifecycle. Errors are `{error: {code, message}}` under their status. missiv-client now depends on missiv-common (it was a peer dependency), and the packages depend on each other with `^`, so an app installs `missiv-client@^1` alone. (The root has `prettier-plugin-svelte`, so `changeset version` can format missiv-client's changelog.) See each package's earlier entries for the detail.
