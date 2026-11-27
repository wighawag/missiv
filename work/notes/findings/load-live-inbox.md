---
title: missiv 0.6's live inbox channel under load: fan-out to both members' sockets
slug: load-live-inbox
source: measured with the load harness (`test/load`, `pnpm load live` and `pnpm load send`, API adapter 0.6) on 2026-11-27, against this repo at c11b94e plus task `live-inbox-channel` (the live inbox channel on Node.js and Bun)
---

# missiv 0.6's live inbox channel under load

The `live` scenario (`test/load/README.md`): every simulated user holds its live inbox socket (`GET /api/inbox/ws`, the session token at the upgrade), then the `send` loop runs, and each message is timed from the start of its send to its arrival on the recipient's socket (`live`) and on the sender's own socket (`live-own`, its other devices); `live-send` is the send's HTTP answer with the sockets open. The `send` scenario, run just before on a fresh server, is the same loop with no socket open.

## Machine and versions

AMD Ryzen 9 9955HX (16 cores, 32 threads), 60 GB, Linux (NixOS), shared (load average about 0.5 of 32). Node.js 24.19.0 (harness and Node target), Bun 1.3.13 (Bun target, from nixpkgs). Each line is one 10 s run on a fresh in-memory server; treat differences under about 10% as noise.

## Sends with and without the sockets (20 clients, 20 conversations, 200-character messages)

| target | `send`, no socket: /s, p50 / p99 ms | `live-send`, 20 sockets: /s, p50 / p99 ms | `live` (to the recipient): p50 / p99 ms | `live-own`: p50 / p99 ms |
| --- | --- | --- | --- | --- |
| node | 1 998, 9.0 / 21.4 | 1 634, 10.9 / 24.7 | 10.9 / 24.6 | 10.9 / 24.6 |
| bun | 3 703, 4.7 / 10.9 | 3 109, 5.6 / 12.2 | 5.6 / 11.9 | 5.6 / 11.9 |

Every message reached both sockets (`incomplete=0` in every run). On node the server's thread was busy 100% in both runs, so the send's server time went from about 0.50 ms to about 0.61 ms with both members online: the two inbox rows read for the `conversation` frames (a member with no socket costs no read) and four frames serialized and written. Bun shows the same step (about 16% fewer sends per second).

## Latency at low load and with many sockets

| target | 2 clients, 1 conversation: `live` p50 / p99 ms | 200 clients, 200 conversations, 200 sockets: /s, `live` p50 / p99 ms |
| --- | --- | --- |
| node | 2.0 / 7.7 (899 sends/s, server 72% busy) | 1 684/s, 117 / 144 |
| bun | 2.3 / 3.6 (854 sends/s) | 2 943/s, 66 / 132 |

A message reaches the recipient's socket at about the time its sender gets the HTTP answer (the frames are written right after the append, alongside the response), so delivery adds nothing visible to the send's own latency. With 200 clients the latency is queueing on a saturated server (a closed loop of 200 concurrent senders), not fan-out cost: throughput stays at the 20-client plateau while 200 sockets are open.

## What the numbers say

- No client polls any more: an open conversation and a conversation list each cost one fetch when the socket opens, then only what is pushed. The 0.6 SQL finding (`load-0-6-sql-stores.md`) measured the poll this replaces at about 0.15 ms of node server time per open conversation every 2 s and per list every 20 s; a live message costs about 0.06 ms per online member, paid only when there is something new.
- The sockets are cheap to hold: 200 open sockets did not lower the send plateau.

Commands: `pnpm load send --target <node|bun> [--bun <bun 1.3.13>]`, `pnpm load live --target <node|bun> [--clients 2 --conversations 1 | --clients 200 --conversations 200]`. The raw results (`--json`) were not kept.
