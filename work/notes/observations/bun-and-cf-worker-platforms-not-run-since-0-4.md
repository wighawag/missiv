---
title: The bun and cf-worker platforms have not been run since the 0.4 rework, only typechecked
slug: bun-and-cf-worker-platforms-not-run-since-0-4
date: 2026-11-17
---

# Two platforms are unexercised

Seen in S3b and S3c (jolly-roger's template-tree plan, steps S3b and S3c, missiv `tf-S3/main`): the machine had neither `bun` nor `wrangler`, so `platforms/bun` and `platforms/cf-worker` were built and typechecked (`tsc --noEmit --skipLibCheck`; cf-worker's `tsc` without `--skipLibCheck` fails in hono's and diary's own declarations), never started. What they share with nodejs (the routes, `migrate`, the Room, `createInProcessRooms` for bun) ran through nodejs and the in-process tests; what is theirs did not: bun's `batch` as one bun:sqlite transaction, bun's `hono/bun` socket wiring, cf-worker's D1 migrations through `wrangler d1 migrations apply` from `packages/server/src/schema/migrations`, its Durable Object hibernation handlers, and its `executionCtx.waitUntil` for the push.

## Suggested direction (not yet decided)

Run each once where bun and wrangler exist: start it, register two users, send a direct message, join a room and send in it (the nodejs smoke of S3b), and for cf-worker apply the migrations to a local D1 first. A platform contract suite through `app.request` (as `platforms/nodejs/test/platform.test.ts`) would make it repeatable.
