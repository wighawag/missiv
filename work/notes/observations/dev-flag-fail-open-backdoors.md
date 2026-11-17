---
title: DEV-only backdoors all hinge on env.DEV being falsy in prod (fail-open shape)
slug: dev-flag-fail-open-backdoors
date: 2026-07-24
---

# The DEV backdoors are correct by design but fail-OPEN if env.DEV leaks truthy

Three privileged shortcuts are gated solely by `env.DEV`:

- `FAKE:<publicKey>` transport auth in `setup.ts` (skips signature recovery).
- The all-zero registration signature bypass in `api/user/index.ts` `/register` (`signature === '0x0000…0000'` ⇒ trust `action.address` as-is).
- `db-reset` in `api/admin/index.ts` (drops + recreates all tables).

Each is guarded like `if (!env.DEV) throw ...`, i.e. the SAFE path requires `env.DEV` to be falsy. This is the intended design (dev ergonomics), but the failure mode is fail-open: if any deployed platform adapter (`platforms/cf-worker`, `platforms/bun`, `platforms/nodejs`) ever sets `DEV` to a truthy value (e.g. the string `"true"`, or a stray `DEV=1`), all three backdoors activate at once, including full DB reset by an unauthenticated caller.

Note `env.DEV` is read as a truthy/`== 'true'` value in different spots; a non-empty string like `"false"` is truthy in JS, so a misconfigured `DEV=false`-as-string would still be dangerous depending on the check used. Worth auditing that every check uses the same, strict interpretation.

## Suggested direction (not yet decided)

Centralise a single `isDev(env)` helper with one strict rule, default to prod (fail-closed) on anything ambiguous, and confirm no deploy config sets `DEV`. Capture-only; no evidence any current adapter sets it.

## Update (2026-11-17, the S3 review of origin/main 79fe3ab)

The fail-open case is not hypothetical for one platform: `platforms/bun/.env.default` is `DB=":memory:"` and `DEV=true`, it is listed in the published `files` of `missiv-server-bun` (`platforms/bun/package.json`), and `cli.ts` loads it as the default env (`platforms/bun/src/cli.ts:25-27`). So the published bun server runs with `FAKE:` auth, the zero registration signature and an unauthenticated `db-reset` unless its operator thinks to set `DEV` to an empty value. The nodejs `.env.default` is empty; `wrangler.toml` sets no `DEV`.

Every check is a JS truthiness test (`setup.ts:47`, `api/user/index.ts:33`, `api/admin/index.ts:25`, `index.ts:75-76`), so `DEV=false` and `DEV=0` (strings) also open all three. With DEV truthy the error handler also returns `cause` and `stack` to the caller.

There is no admin token anywhere in the server: `platforms/nodejs/src/cli.ts:45` reads `TOKEN_ADMIN` only to send it to a route that does not exist (`nodejs-platform-cannot-start.md`), so "behind the admin token" (the jolly-roger plan's S3-1) has nothing to stand on yet.
