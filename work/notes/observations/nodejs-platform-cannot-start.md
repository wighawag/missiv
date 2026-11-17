---
title: The nodejs platform throws while constructing the app, so it has never served a request
slug: nodejs-platform-cannot-start
date: 2026-11-17
---

# platforms/nodejs is not "HTTP only": it does not start

Seen in the S3 review of origin/main 79fe3ab, and reproduced.

`platforms/nodejs/src/cli.ts:63-65` passes `upgradeWebSocket: () => { throw ... }`. But `createServer` calls `upgradeWebSocket(...)` while BUILDING the routes, for the leftover `/api/public/ws` echo route (`packages/server/src/api/public/index.ts:32-42`), not when a socket connects. So `createServer` throws before `serve()` is reached. Reproduced (2026-11-17, Node 24, the built `missiv-server` imported with the nodejs platform's options, no port): `THROWS at construction: upgradeWebSocket not implemented for nodejs`. The tests never see it because their `upgradeWebSocket` returns a function (`test/client-server/test/setup.ts:63-66`, `packages/server/src/index.test.ts:180-183`).

Also in the platform:

- the `:memory:` bootstrap fetches `/admin/setup` with a Basic auth header (`cli.ts:68-77`): no such route exists (the admin route is `/api/admin/db-reset`, and nothing reads `TOKEN_ADMIN`), so a fresh in-memory database has no tables;
- `platforms/nodejs/migrate.ts` imports `drizzle-orm` (not a dependency) and a `getDB` that `cli.ts` does not export: dead;
- `package.json` `files` lists `"stc"` (also in `platforms/bun/package.json`), a typo for `src`;
- `getRoom` and `getRateLimiter` throw (`cli.ts:55-60`): no rooms.

## Suggested direction (not yet decided)

Drop the echo route (or build it lazily), give nodejs real rooms on `@hono/node-ws` (the bun room is the model, and the in-memory `SimpleObjectStorage` in `platforms/bun/src/cli.ts:120-189` is runtime-agnostic and can move to `missiv-server`), bootstrap the schema through the same path as the other platforms, and test the platform's app through `app.request` in CI.
