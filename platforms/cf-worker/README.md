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

## Deploying

Run every command from `platforms/cf-worker`, after `pnpm install` and `pnpm build` at the repo root (the worker bundles `@missiv/server` from the workspace). `pnpm wrangler login` once, if wrangler is not logged in to the Cloudflare account.

### 1. The D1 database (once for 0.6)

0.6 starts from an empty database (ADR-0004). Its first migration, `0001_v0_6.sql`, is named apart from 0.5's `0001_initial.sql` on purpose, so on a database 0.5 already migrated it fails (its tables exist) instead of running on the wrong schema. A database made by 0.5 is therefore replaced, not migrated (there is no production data to keep):

```sh
pnpm wrangler d1 delete missiv-db       # only if a 0.5 database exists; asks to confirm
pnpm wrangler d1 create missiv-db       # prints the new database_id
```

Put the printed `database_id` in `wrangler.toml` (`[[d1_databases]]`), then apply the migrations:

```sh
pnpm migrate:remote                     # wrangler d1 migrations apply missiv-db --remote
```

Later releases only need `pnpm migrate:remote` before `pnpm deploy`.

### 2. Secrets

Set once (each command prompts for the value; it is stored encrypted and survives deploys):

```sh
openssl rand -hex 32 | pnpm wrangler secret put SESSION_SECRET   # required: every authenticated route is refused without it
pnpm wrangler secret put ADMIN_TOKEN                             # optional: the bearer token of /api/admin (db-reset); unset, admin is refused
pnpm wrangler secret put PUSH_TOKENS                             # optional: `<domain>=<token>,...`, the tokens push-notification-server issued
```

To rotate `SESSION_SECRET`: put the current value as `SESSION_SECRET_PREVIOUS`, then a new `SESSION_SECRET`; delete `SESSION_SECRET_PREVIOUS` an hour later (tokens live an hour).

### 3. Variables

Non-secret settings go in `wrangler.toml` under `[vars]`, which `pnpm deploy` applies (it also replaces variables set in the dashboard, so keep them here):

```toml
[vars]
SERVER_ORIGIN = "https://missiv.example.com"         # the origin clients use; set it, since request signatures name it
PUSH_SERVER_URL = "https://push.example.com"         # push-notification-server (0.3.0 or later); unset, no Web Push
# PUSH_SKIP_WHEN_ONLINE = "true"                     # no Web Push to a recipient whose inbox socket is open
# INBOX_TRANSPORTS = "socket,poll"                   # the default; on Cloudflare the socket is the cheaper one
# CHAIN_<chainId> = "https://rpc.example"            # a chain's JSON-RPC, for contract-gated rooms
# RATE_LIMIT_SEND_BURST = "20"                       # per-account sends: burst, and refill per second (1)
# RATE_LIMIT_IP_BURST = "30"                         # per-IP /session + register: burst, and refill per second (0.5)
```

Every variable is described in `packages/server/src/env.ts`.

### 4. Deploy

```sh
pnpm deploy
```

The first 0.6 deploy also applies the Durable Object migration `v3` (`wrangler.toml`), which creates the SQLite-backed `ServerObjectConversation` and `ServerObjectInbox` classes; rooms and rate limiters keep their objects.

### 5. Check it

```sh
curl https://<your worker>/                      # answers `missiv`
pnpm wrangler tail                               # live logs while a client registers, opens a session and sends
```

Then point a 0.6 client at it (`@missiv/client` 0.5.0 or later, with `@etherplay/connect` 0.19.0's key set): register, send a direct message both ways, and see it arrive on the other side's open inbox. A client from before 0.6 cannot talk to it: the keys, the API and the message format all changed.
