---
title: A switchable inbox transport (socket or polling) and a heartbeat on the inbox socket
slug: switchable-inbox-transport-and-socket-heartbeat
date: 2026-11-27
---

# Decided (the human, 2026-11-27): build both now

Raised after 0.6 landed: could direct-message delivery use polling with a cheap change check (a per-user inbox version, "unchanged since X") instead of the live inbox socket, and should a deployment be able to switch?

## What was concluded

- **The "cache" is a per-inbox version, not a CDN cache**: responses are per user and authenticated; Cloudflare's Cache API is per colo with non-instant purge, and KV is eventually consistent (up to about 60 s). The version lives with the inbox (process memory on Node/Bun, the Inbox Durable Object on Cloudflare).
- **Cloudflare: sockets are cheaper** (Durable Objects pricing page, read 2026-11-27): a socket costs one request to open, outgoing messages are free, incoming messages are billed 20:1, protocol pings are free, and a hibernated socket incurs no duration. Every poll is a Worker request plus a Durable Object request ($0.15/million beyond the included amount) whether or not anything changed: 10,000 users polling every 5 s is about 5.2 billion requests a month, about $780 in Durable Object requests alone.
- **Node/Bun: both are cheap; polling's real advantage is scaling**: several instances behind a plain load balancer with no message bus (ADR-0005's seam), WebSocket-hostile proxies, and no reconnect storm on restart. Its costs are a constant load of empty polls and the poll interval as latency (sockets measured 2 ms when lightly loaded, `work/notes/findings/load-live-inbox.md`).
- **Rooms stay on sockets on every platform**: a room is broadcast plus presence, and polling would bring back the read amplification 0.6 removed.

## Tasked as `socket-heartbeat` and `switchable-inbox-transport` (work/tasks/)

1. Server: `POST /inbox/sync {since}`, answering "unchanged" from the inbox version without a database read, otherwise what changed (reusing `answerSync`).
2. Client: a transport option on the inbox store, `'socket' | 'poll' | 'auto'` (`auto` falls back to polling when the socket keeps failing and returns when it recovers).
3. Server config: which transports a deployment offers (polling only, for several Node instances without a bus).
4. A load-harness scenario comparing the two.

## The heartbeat gap

Neither the inbox socket's server nor `@missiv/client`'s inbox store sends pings, so an idle socket can be dropped silently by a proxy or mobile network (commonly after 60 to 100 s idle) and nobody notices until the next reconnect. On Cloudflare, pings answered with `state.setWebSocketAutoResponse` are free and do not wake the Inbox object; on Node/Bun a periodic ping with a pong timeout. Seen in `platforms/cf-worker/src/stores/inbox.ts` (no auto-response set) and `packages/client/src/lib/inbox/index.ts` (no heartbeat), main 5edbd43.
