# missiv

missiv on Node.js: `missiv --port 2000` with `DB` a libSQL URL (`:memory:` by default), the database migrated at start, rooms in process on `@hono/node-ws`. In process (a dev stack, an end-to-end test): `createNodeServer({db, env})` returns `{app, injectWebSocket}` (`app.request` needs no port). Configuration: `docs/architecture.md`.

```
pnpm install
pnpm build
pnpm dev
```
