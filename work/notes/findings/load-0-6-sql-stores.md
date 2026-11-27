---
title: missiv 0.6 on the SQL stores under load, against the 0.5 baseline
slug: load-0-6-sql-stores
source: measured with the load harness (`test/load`, `pnpm load`) on 2026-11-27, API adapters 0.6 and 0.6-page against this repo at 9951240 plus task `sqlite-conversation-store-and-api` (the store ports, the SQL ConversationStore and Inbox, the 0.6 messaging API); the "0.5 on 0.6 keys" column against 9951240 itself, with the 0.5 adapter, measured the same day on the same machine just before the change
---

# missiv 0.6 on the SQL stores under load

The send and read scenarios of `load-baseline-0-5.md` (next to this file), rerun through the 0.6 adapter after `sqlite-conversation-store-and-api`. Three columns per target:

- **0.5 baseline**: `load-baseline-0-5.md`'s numbers (0.5 as released: secp256k1 request signatures recovered on every request, one copy per member).
- **0.5 on 0.6 keys**: the same 0.5 API at 9951240, after `messaging-keys-and-registration` and `sessions-and-tokens` (Ed25519 signatures, session tokens on reads, still one copy per member, a signed and replay-checked send). Measured here just before the change, so the effect of THIS task is the step from this column to the next; the step from the first is mostly the earlier tasks' Ed25519 and tokens.
- **0.6**: this task: one message row per send, authorized by the token and the message's own Ed25519 signature (one directory read, then one transaction of five statements), reads by seq.

## Machine and versions

- The baseline's machine: AMD Ryzen 9 9955HX (16 cores, 32 threads), 60 GB, Linux (NixOS), shared (load average 0.6 to 1.6 of 32 during these runs, quieter than the baseline's 4 to 10, so treat differences under about 10% as noise).
- Node.js 24.19.0 (harness and Node target), Bun 1.3.13 (Bun target, from nixpkgs). No `wrangler dev` run: wrangler is not installed here, and Cloudflare moves to its own stores in `cloudflare-durable-object-stores`.

## Parameters

The defaults, as the baseline: `--clients 20 --conversations 20 --duration 10 --history 100 --size 200`, each command on a fresh server. 0.6 sends are `clear` messages of 200 characters (the server's work is that of any scheme: the schema, the content's SHA-256, one Ed25519 verification, one row); the baseline's were `encrypted` copies with placeholder content, so in both the client's encryption is out of the numbers.

## Sends (closed loop, 20 concurrent clients)

| target | 0.5 baseline: /s, p50 / p99 ms | 0.5 on 0.6 keys: /s, p50 / p99 ms | 0.6: /s, p50 / p99 ms |
| --- | --- | --- | --- |
| node | 446, 41.7 / 87.3 | 1 793, 9.8 / 25.7 | 1 981, 9.0 / 22.8 |
| bun | 571, 32.2 / 75.8 | 3 103, 6.0 / 10.8 (harness saturated) | 3 774, 4.7 / 10.4 |

On node the server's thread was busy 100% in every send run, so these are its ceilings: about 0.50 ms of server thread per 0.6 send (at 2 clients in one conversation: 777/s at p50 2.5 ms, the server 55% busy). The "0.5 on 0.6 keys" bun run saturated the harness's own thread (100% event loop utilization), so its 3 103/s bounds the client, not the server; the 0.6 bun run did not (62%).

## Reads (closed loop, 20 concurrent clients, 100 messages of history per conversation)

| target | 0.5 baseline: newest page | 0.5 on 0.6 keys: newest page | 0.6-page: newest page | 0.6: catch-up by seq |
| --- | --- | --- | --- | --- |
| node | 387/s, 48.7 / 99.6 ms | 955/s, 18.2 / 38.7 ms | 1 202/s, 14.2 / 31.1 ms | 6 824/s, 2.0 / 11.1 ms |
| bun | 746/s, 23.3 / 59.8 ms | 3 129/s, 5.3 / 12.0 ms | 4 681/s, 3.7 / 8.3 ms | 13 417/s, 1.2 / 6.8 ms |

Every newest-page read returned 100 messages; the 0.6 catch-up returned 0.1 per read on average (only each conversation's first read per user is a full page; after it, nothing is new, which is what an open conversation's poll sees between messages). The catch-up's throughput is that of the cheapest call: the conversation list ran at 6 276/s on node and 13 569/s on bun in the same session.

## Rooms

Unchanged by this task, and rerun only as a smoke test of both platforms' sockets: 100 sockets at 10 messages/s delivered every message to every socket on node (last delivery p50 2.0 ms, p99 2.6 ms) and on bun (p50 1.8 ms, p99 2.6 ms), as in the baseline.

## What the numbers say

- A send on node costs about 0.5 ms of server time against about 2.1 ms in the 0.5 baseline. Most of that came with Ed25519 and tokens (the second column); this task's own step is about 10% on node and over 20% on bun, from one row per message instead of one per member, no replay-set writes, no recipient key lookups, and the dedup, the seq, the block check and both inbox rows in one transaction.
- The send's statement count no longer grows with anything: the contract suite asserts one transaction of at most five statements, the same after 300 messages as after one, each a key lookup in its query plan (no scan, no sort).
- A read by `after` cursor is what makes polling cheap: the poll of an open conversation costs as much as a list (about 0.15 ms on node), instead of a 100-message page (about 0.8 ms on node now, 2.6 ms at the baseline), before the live channel (`live-inbox-channel`) removes the poll altogether.
- The newest page itself got cheaper (955 to 1 202/s on node, 3 129 to 4 681/s on bun): one row per message, and the sender's key set is no longer joined into every row (the reader fetches it once by `senderKeyRef`).

The raw results (`--json`) were not kept; each line above is one run of `pnpm load <send|read|list|room> --target <node|bun> [--api 0.6-page] --bun <bun 1.3.13>`.
