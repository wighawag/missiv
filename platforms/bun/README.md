# @missiv/bun

missiv on Bun 1.3.13 or later: bun:sqlite (each batch a real transaction, so a send is one), migrated at start, rooms in process (`createBunServer` in `src/server.ts`, served by the CLI). Its `.env.default` sets no backdoor. Configuration: `docs/architecture.md`.

```
pnpm install
pnpm dev
pnpm test   # bun test: the store contract on bun:sqlite, and the platform booted and driven over HTTP
```

`pnpm test` needs bun on PATH (or `BUN=<path>`); without it the tests are skipped with a warning, and with `REQUIRE_BUN=1` that is a failure.
