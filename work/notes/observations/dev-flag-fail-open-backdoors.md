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
