---
title: missiv 0.6 on Cloudflare's Durable Object stores under wrangler dev, and what Durable Objects do that we built around
slug: load-cloudflare-durable-objects
source: measured with the load harness (`test/load`, API adapter 0.6, `--target url`) on 2026-11-27 against `platforms/cf-worker` under `wrangler dev` (wrangler 4.2.0, workerd 2025-03-17, local D1 migrated), this repo at 997b433 plus task `cloudflare-durable-object-stores`; the Durable Object behaviour checked on 2026-11-27 against developers.cloudflare.com (Durable Objects "Alarms", "Use WebSockets", "Durable Object State", "Durable Object Base Class", "SQLite-backed Durable Object Storage", Workers "Vitest integration: Known issues") and on the Workers runtime by `platforms/cf-worker/test/`
---

# missiv 0.6 on Cloudflare's Durable Object stores

The cf-worker now keeps conversations in Conversation Durable Objects and inboxes (rows, blocks, live sockets) in Inbox Durable Objects, with D1 for the key directory only (`docs/architecture.md`, "Cloudflare's Durable Object stores"). `wrangler dev` serves the whole flow: register, session, `pairwise-v1` and `clear` sends, accept, markRead, reject (a later message, in the same and in another namespace, hidden from the blocker), unblock, `getKeySet`, and the live inbox socket with its frames and a `sync` (a scripted run over `test/client-server/test/setup.ts`'s `createRemoteActions`, not kept). The load harness runs against it with no error and no incomplete delivery.

## Machine and versions

AMD Ryzen 9 9955HX (16 cores, 32 threads), 60 GB, Linux (NixOS), load average about 1.2 of 32. Node.js 24.19.0 for the harness. `wrangler dev --port 34003` with `RATE_LIMIT_SEND_BURST` and `RATE_LIMIT_IP_BURST` at 1e9 (as the harness sets them for node and bun). Each line is one 10 s run, 20 clients and 20 conversations unless said, 200-character messages.

## Numbers

| scenario | wrangler dev (Durable Objects): /s, p50 / p99 ms | node, same machine, same session: /s, p50 / p99 ms |
| --- | --- | --- |
| `send` | 500, 38.9 / 55.1 | 1 981, 9.1 / 21.7 |
| `live-send` (20 sockets) | 495, 39.0 / 56.0 | 1 573, 11.2 / 25.7 |
| `live` (to the recipient's socket) | 31.7 / 50.5 | 11.2 / 25.6 |
| `live-own` | 31.1 / 49.7 | 11.1 / 25.6 |
| `read` (catch-up by seq, 100 messages of history each) | 2 497, 6.1 / 37.9 | not rerun (`load-0-6-sql-stores.md`) |
| `read`, `--api 0.6-page` (the newest 100) | 1 033, 17.7 / 48.7 | not rerun |
| `list` | 2 477, 6.1 / 36.8 | not rerun |
| `live`, 2 clients, 1 conversation | 420 sends/s; `live-send` 4.4 / 15.2, `live` 3.5 / 12.4 | 2.0 / 7.7 (`load-live-inbox.md`) |

Every message reached both sockets (`incomplete=0`), no request failed.

## What the numbers say, and what they do not

- `wrangler dev` is one local workerd process simulating every object, D1 and the Worker, so these are not production numbers: on Cloudflare the objects spread over machines and a call between objects is a network hop. What the run shows is that the flow is correct under concurrency and that the shape of the latency is as designed.
- A live frame arrives BEFORE the send's HTTP answer (`live` p50 31.7 ms against `live-send` 39.0 ms): the Inbox object pushes when its row is updated, which the Conversation object awaits before it answers the Worker. On Node it arrives with the answer.
- A send is the Worker, one Conversation object and the two members' Inbox objects in parallel, plus a cached directory read; a read or a list is one object. With 2 clients a send takes 4.4 ms at p50 locally; with 20 the latency is queueing in the one local process (the harness was at 15 to 33% of its event loop).

## Durable Object behaviour this code is built around (docs, 2026-11-27)

- **Alarms**: one alarm per object (`setAlarm` replaces the previous one), at-least-once, and the runtime retries an `alarm()` that THROWS only 6 times, with exponential backoff from 2 s. So both objects keep their pending work in tables, set the alarm at the soonest attempt, never throw from `alarm()`, and reschedule themselves (1 s, doubling, at most 5 min, without end). `getAlarm()` inside a running alarm answers null unless `setAlarm` was called since.
- **Hibernation**: an evicted object's sockets stay connected; the next event runs the constructor again and then the handler, so in-memory state is gone. Per-socket state goes in `serializeAttachment` (structured clone, at most 16 384 bytes; ours is the session's claims, about 200). On compatibility dates before 2026-04-07, `webSocketClose` must call `ws.close(code, reason)` itself to complete the closing handshake (else the client sees 1006); `getWebSockets()` still returns a socket that is CLOSING. A timer does not survive hibernation: the session expiry is the Inbox object's alarm.
- **Concurrency**: an object runs one event at a time only between `await`s; awaiting a call to another object lets other events in. So the append's dedup, block check and seq run in one synchronous step after the only `await` (the first append's read of the members' block states). `blockConcurrencyWhile` would serialize that read, but "if the callback throws, the object will be terminated and reset", so a shared promise is used instead.
- **SQL API**: `ctx.storage.sql.exec` is synchronous; a cursor must be consumed (`toArray`, `one`) before the next `await`; no `BEGIN`/`SAVEPOINT` (`transactionSync` instead); SQLite storage is chosen per class at creation (`new_sqlite_classes` in a wrangler migration), never for an existing class, so the new stores are new classes (migration `v3`).
- **RPC** to Durable Object methods needs compatibility date 2024-04-03 or later: the cf-worker's moved from 2023-08-14 to 2025-03-10 (the newest workerd 2025-03-17 accepts with margin).
- **Testing** (`@cloudflare/vitest-pool-workers`, renamed `@cloudflare/vitest-plugin` since; 0.8.2 is the release pinned to wrangler 4.2.0 and vitest 3.0): Durable Objects holding WebSockets are not supported with per-file storage isolation, so the tests run on one runtime with shared storage, each test on fresh addresses. `runDurableObjectAlarm` runs the alarm at once, whatever its time: the alarms therefore retry every pending row, not only those due.
