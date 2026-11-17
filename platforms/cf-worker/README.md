# @missiv/cf-worker

missiv on Cloudflare Workers: D1 for the database (migrated with `pnpm init:db` locally, `pnpm migrate:remote` for the deployed one, from @missiv/server's migration files), Durable Objects with hibernation for rooms and rate limiters. Secrets: `ADMIN_TOKEN`, `PUSH_TOKENS`. Configuration: `docs/architecture.md`.

```
pnpm install
pnpm dev
```

```
pnpm deploy
```
