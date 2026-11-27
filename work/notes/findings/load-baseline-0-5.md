---
title: missiv 0.5 under load, the baseline before 0.6
slug: load-baseline-0-5
source: measured with the load harness (`test/load`, `pnpm load`, API adapter 0.5) on 2026-11-27, against @missiv/server 0.5.0, @missiv/common 0.5.0, @missiv/client 0.4.1 as built from this repo at 3d1b7b3 plus the harness
---

# missiv 0.5 under load

The numbers the 0.6 redesign (spec `scalable-direct-messaging`) is measured against. Every later API change reruns the same scenarios through its own adapter and records its numbers next to these.

## Machine and versions

- AMD Ryzen 9 9955HX (16 cores, 32 threads), 60 GB, Linux 6.18.49 (NixOS). A shared machine: other sessions ran during the measurements (load average 4 to 10 of 32), so treat differences under about 10% as noise.
- Node.js 24.19.0 (harness and Node target), Bun 1.3.13 (Bun target), wrangler 4.2.0 / Miniflare (`wrangler dev` with local D1, through `--target url`).
- Harness: one thread of simulated clients; its event loop utilization stayed between 22% and 54% in the HTTP runs, so the clients were not the limit.

## Parameters

Unless stated: `--clients 20 --conversations 20 --duration 10 --history 100 --size 200 --room-size 100 --rate 10` (the defaults), each command run on a fresh server. Sends are `encrypted` 1:1 messages (two copies, two copy signatures, one request signature), reads return a full page of 100 messages, each user's list has 2 conversations.

## Direct messages (closed loop, 20 concurrent clients)

| target | send /s | send p50 / p95 / p99 ms | read /s | read p50 / p95 / p99 ms | list /s | list p50 / p95 / p99 ms |
| --- | --- | --- | --- | --- | --- | --- |
| node | 446 | 41.7 / 80.7 / 87.3 | 387 | 48.7 / 94.6 / 99.6 | 560 | 33.6 / 65.5 / 69.0 |
| bun | 571 | 32.2 / 62.7 / 75.8 | 746 | 23.3 / 45.0 / 59.8 | 1032 | 17.7 / 35.1 / 37.1 |
| wrangler dev | 195 | 101 / 119 / 144 | 245 | 80.7 / 94.2 / 107 | 347 | 55.0 / 74.9 / 93.5 |

On node the server's thread was busy 100% of every HTTP scenario (`serverLoad`): these are the server's ceilings, and the latency is mostly queueing. A sweep of node `send` by concurrency: 2 clients 420/s at p50 4.5 ms (p99 7.1 ms), 5 clients 474/s at p50 11.8 ms, 50 clients 471/s at p50 103 ms (p99 207 ms). So one 0.5 send costs the Node server about 2.1 ms of its single thread, whatever the concurrency; a `list`, the cheapest call (a signature check, a domain-user lookup and one query), about 1.8 ms; a 100-message read about 2.6 ms.

## Room fan-out (open loop, one socket per loopback address)

| target | sockets | messages /s | join p50 / p99 ms | last delivery p50 / p95 / p99 ms | every delivery p50 / p99 ms | deliveries /s | server busy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| node | 100 | 10 | 39.0 / 55.4 | 2.0 / 2.3 / 2.4 | 1.5 / 2.2 | 1 010 | 7% |
| node | 500 | 50 | 63.8 / 105 | 4.4 / 5.8 / 6.5 | 2.7 / 5.6 | 25 051 | 42% |
| node | 1000 | 100 | 189 / 278 | 7.5 / 16.7 / 28.9 | 4.4 / 21.2 | 100 104 | 85% |
| bun | 100 | 10 | 22.0 / 41.9 | 1.9 / 4.0 / 6.2 | 1.3 / 5.6 | 1 010 | n/a |
| bun | 500 | 50 | 31.6 / 52.9 | 4.2 / 5.7 / 6.5 | 2.5 / 5.4 | 25 050 | n/a |
| bun | 1000 | 100 | 49.1 / 90.0 | 6.3 / 8.1 / 9.9 | 3.4 / 7.8 | 100 108 | n/a |

Every message reached every socket in every run (no `incomplete`, no `rate_limited`). At 1000 sockets and 100 messages/s the harness's own thread was 70% busy receiving 100 000 deliveries a second, so a larger room needs the clients split over several processes before its numbers mean the server. The node `server busy` covers the whole scenario, joins included.

`wrangler dev` has no room numbers: every room upgrade answers 500 there (observation `cf-worker-room-upgrade-500-on-wrangler-dev`).

## What the baseline says about the Problem Statement

- The send, read and list ceilings on node (about 450, 390 and 560 requests/s) are each one thread spending about 2 ms per request, of which the request-signature recovery measured in ADR-0004 (1.35 ms with `@noble/secp256k1`) is the larger part: even `list`, with one query, costs 1.8 ms. A session token (0.6) should move every one of these.
- A send costs only about 0.3 ms more than a list on node and bun's in-memory SQLite, where a database call has no round trip; on `wrangler dev`, where each of the 2N+6 calls goes to D1, a send's p50 is 101 ms at 20 clients against 55 ms for a list.
- A 0.5 read returns the whole newest page every time; the baseline read is a full page of 100, so the 0.6 `after` cursor is measured against 100 messages a poll.
- Rooms are not the bottleneck at these sizes: delivery stays under 10 ms p99 on bun up to 1000 sockets; node's join slows down past 500 sockets (each join is broadcast to every socket, so joining N sockets sends about N squared messages).

The raw results (`--json`) were not kept; each line above is one run of `pnpm load <scenario> --target <target> [--room-size N --rate M]`.
