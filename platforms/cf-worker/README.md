# @missiv/cf-worker

missiv on Cloudflare Workers: D1 for the key directory (migrated with `pnpm init:db` locally, `pnpm migrate:remote` for the deployed one, from @missiv/server's migration files); a Conversation Durable Object per conversation and an Inbox Durable Object per (domain, user), with SQLite storage, the Inbox holding the user's live inbox sockets with hibernation (`src/stores/`, `docs/architecture.md` "Cloudflare's Durable Object stores"); Durable Objects with hibernation for rooms and rate limiters. Secrets: `SESSION_SECRET` (required: authenticated routes are refused without it; `pnpm dev` sets a dev-only one), `SESSION_SECRET_PREVIOUS` while rotating it, `ADMIN_TOKEN`, `PUSH_TOKENS`. Configuration: `docs/architecture.md`.

```
pnpm install
pnpm dev
```

```
pnpm test     # on the Workers runtime (@cloudflare/vitest-pool-workers): the store contract, alarms, blocks, sockets
pnpm deploy
```
