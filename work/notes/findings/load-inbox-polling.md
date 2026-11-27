---
title: The live inbox's polling transport under load, next to the socket
slug: load-inbox-polling
source: measured with the load harness (`test/load`, `pnpm load poll`, `pnpm load live`, `pnpm load list`, API adapter 0.6) on 2026-11-27, against this repo at 16bb293 plus task `switchable-inbox-transport` (the inbox version, `POST /api/inbox/changes`, `INBOX_TRANSPORTS`)
---

# The live inbox's polling transport under load

The `poll` scenario (`test/load/README.md`) runs in two phases on the same users and conversations as `send`, `list` and `live`. `poll-empty`: every user polls `POST /api/inbox/changes` back to back from its current inbox version while nothing changes, so every poll is answered `unchanged`; its throughput is how many empty polls the server sustains. `poll`: every user polls once a second (from a random point of the interval) while 20 messages a second go out from random senders; each message is timed from the start of its send until its recipient's poll has read it (`listMessages {after}` for the changed row), and `poll-request` is every poll of that phase. `serverLoad` is the share of the phase's time the Node.js server's thread was busy.

## Machine and versions

AMD Ryzen 9 9955HX (16 cores, 32 threads), 60 GB, Linux (NixOS), shared (load average about 1.5 of 32). Node.js 24.19.0 (harness and Node.js target, in-memory libSQL), Bun 1.3.13 (Bun target, bun:sqlite in memory, from nixpkgs; the harness reads no server load from it). Each line is one 10 s phase on a fresh server; treat differences under about 10% as noise.

## Empty polls

| server | clients | `poll-empty`: /s, p50 / p99 ms | server busy | server time per empty poll |
| --- | --- | --- | --- | --- |
| node, `socket,poll` (version in memory) | 20 | 9 520, 2.0 / 8.2 | 60% | about 0.063 ms |
| node, `socket,poll` (version in memory) | 200 | 12 584, 14.0 / 36.5 | 84% | about 0.067 ms |
| node, `INBOX_TRANSPORTS=poll` (version read from SQL) | 20 | 9 811, 1.9 / 7.9 | 94% | about 0.096 ms |
| node, `INBOX_TRANSPORTS=poll` (version read from SQL) | 200 | 10 161, 18.1 / 41.3 | 100% | about 0.098 ms |
| bun, `socket,poll` (version in memory) | 20 | 10 352, 1.9 / 7.3 | not measured | |
| bun, `INBOX_TRANSPORTS=poll` (version read from SQL) | 20 | 10 163, 1.9 / 7.7 | not measured | |

For comparison on the same server: `list` (`listConversations`, what a client polled before the live channel) sustained 6 100/s at 97% busy, about 0.16 ms each; `live` sustained 1 410 sends/s with 20 sockets open (100% busy), every message on both members' sockets at p50 12.7 ms (that is the saturated send loop's queueing; lightly loaded it is about 2 ms, `load-live-inbox.md`).

An empty poll answered from memory costs about 0.065 ms of server time, mostly the HTTP request, the JSON body's validation and the session token's HMAC: no database statement runs. Read from SQL (the multi-instance setting), it costs about 0.097 ms: one indexed `MAX(version)` lookup. Both are well under a `listConversations` poll.

## Delivery latency

| server | clients | interval | `poll` (send to recipient's read): p50 / p95 / max ms | `poll-request` p50 / p99 ms | server busy |
| --- | --- | --- | --- | --- | --- |
| node, `socket,poll` | 20 | 1 s | 531 / 971 / 994 | 5.8 / 11.0 | 7% |
| node, `socket,poll` | 200 | 1 s | 488 / 900 / 995 | 1.5 / 4.7 | 8% |
| node, `INBOX_TRANSPORTS=poll` | 20 | 1 s | 509 / 957 / 998 | 3.8 / 6.4 | 4% |
| node, `INBOX_TRANSPORTS=poll` | 200 | 1 s | 512 / 964 / 999 | 1.6 / 4.4 | 9% |
| bun, `socket,poll` | 20 | 1 s | 455 / 915 / 991 | 3.1 / 5.7 | not measured |
| bun, `INBOX_TRANSPORTS=poll` | 20 | 1 s | 418 / 921 / 986 | 3.2 / 5.8 | not measured |

Every message was read by its recipient within the interval (`incomplete=0`, max under 1 s in every run). The latency is the interval's: about half of it on average, never more than one interval plus a few ms of reads. A changed poll (`poll-request` with `changed`) costs the version read, the changed rows, and one `listMessages` per changed conversation.

## What the numbers say

- On Node.js and Bun both transports are cheap; the socket delivers in milliseconds, polling in half an interval on average (2.5 s at the client's default of 5 s). 200 clients polling every second cost the server about 8% of one thread with 20 messages a second; an idle client polling every 5 s costs about 0.013 ms of server time a second from memory.
- The multi-instance setting (`INBOX_TRANSPORTS=poll`, no memory) costs about 50% more per empty poll than the single process's memory, still about 0.1 ms.
- On Cloudflare every poll is a Worker request and a Durable Object request whatever it finds (`work/notes/ideas/switchable-inbox-transport-and-socket-heartbeat.md`), while a hibernated socket costs nothing: the socket stays the cheaper transport there. Polling was not measured under `wrangler dev`.

At 20 clients the closed loop is bound by the round trip (about 2 ms each), not by the server, on both targets: Bun's plateau was not reached here.

Commands: `pnpm load poll [--clients 200 --conversations 200] [--target bun --bun <bun 1.3.13>]`, the same with `INBOX_TRANSPORTS=poll` in the harness's env (the Node.js target passes it to its server), `pnpm load live`, `pnpm load list`. The raw results (`--json`) were not kept.
