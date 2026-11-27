---
title: Every room WebSocket upgrade answers 500 on the cf-worker platform under wrangler dev
slug: cf-worker-room-upgrade-500-on-wrangler-dev
date: 2026-11-27
---

# cf-worker rooms do not open under wrangler dev

Seen while recording the load baseline (`work/notes/findings/load-baseline-0-5.md`): with `platforms/cf-worker` under `wrangler dev` (wrangler 4.2.0, local D1 migrated), the HTTP API works but every `GET /api/public/room/@test.com/ws` answers 500, and wrangler logs `RangeError: Responses may only be constructed with status codes in the range 200 to 599` from hono's `context.js` `set res`, reached through the `cors` middleware (`hono@4.7.5`). The Durable Object's 101 response seems to be re-wrapped by a middleware on its way out. Not checked on a deployment.

## Suggested direction (not yet decided)

Let the room route return the Durable Object's upgrade response untouched (no cors re-wrap on `/room/:name/ws`), then rerun `pnpm load room --target url --url http://127.0.0.1:34003`.
