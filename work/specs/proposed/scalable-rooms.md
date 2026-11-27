---
title: Real-time rooms that hold many users and a high message rate
slug: scalable-rooms
taskedAfter: [scalable-direct-messaging]
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` + the code.

## Problem Statement

From a code read on 2026-11-27 of the `Room` class and its hosts:

- The rate limit is one global bucket per IP across all rooms (1 message per 5 s after a burst), so users behind one NAT share it, and `RateLimiterClient.checkLimit` refuses any message sent while the previous limiter call is in flight (`work/notes/observations/room-rate-limiter-refuses-back-to-back-messages.md`). Each message also costs a call to a limiter object.
- A join is quadratic: the newcomer is sent one `joined` frame per connected user, and the login broadcasts it to everyone.
- On Cloudflare a room's history in Durable Object storage is never pruned (the in-memory host keeps 200).
- Every login reads the directory (from the room's Durable Object, often cross-region), and in a contract-gated room makes an uncached `eth_call`.
- Login signs the socket's challenge as a request (secp256k1 in 0.5; the task `messaging-keys-and-registration` of spec `scalable-direct-messaging` moves it to Ed25519 as an interim, before this spec replaces it with the session token).

## Solution

- Rate limits as local token buckets: per account per room in the room itself (no remote call per message), plus a coarse per-IP bucket on connection and login; burst and refill configurable; a refusal tells the client when to retry.
- Login with the session token from `scalable-direct-messaging` (ADR-0006; no signature, no directory read), presented at upgrade like the inbox socket, keeping the challenge-signature login only if a room must be joinable without a session.
- One `roster` frame to a newcomer instead of N `joined` frames; `joined` / `quit` broadcasts unchanged.
- History bounded on every platform (the last 200 by default), pruned on write.
- Contract-gate results cached per (room, account) for a configurable time.
- The room's broadcast measured by the load harness (connections per room, messages per second, fan-out latency).

## User Stories

1. As a room user behind a shared IP, I want my own send budget, so that others on my network do not silence me.
2. As a room user, I want a quick burst of messages accepted, so that the limiter does what it documents.
3. As a room, I want to rate-limit without a remote call per message, so that a message costs only its broadcast.
4. As a newcomer, I want the roster in one frame, so that joining a busy room is cheap for everyone.
5. As an operator, I want room history bounded on Cloudflare as on Node/Bun, so that storage does not grow forever.
6. As a signed-in user, I want to join a room with my session token, so that login costs no signature check and no directory read.
7. As a contract-gated room, I want admission results cached for a while, so that reconnect storms do not hammer the chain RPC.
8. As an operator, I want the load harness to report room fan-out numbers, so that I know a room's capacity on each platform.

### Autonomy notes

- Neither flag is set: no open questions, and the decisions are ordinary engineering. It waits on `scalable-direct-messaging` being tasked (`taskedAfter`) because it reuses that spec's session tokens.

## Implementation Decisions

- The bucket lives in the room (Durable Object or in-process room); the per-IP connection bucket lives where connections are accepted (Worker-level limiter object on Cloudflare, in-process map with eviction on Node/Bun).
- `roster` frame: `{roster: [{address, publicKey, id}]}`; clients accept it in place of the `joined` series.
- History pruning: delete beyond the bound on each write (Durable Object storage `list` + `delete`, or a sequence-keyed table in the DO's SQLite).

## Testing Decisions

- Room behaviour through fake sockets wired to an in-process room (prior art: `test/client-server/test/room.test.ts`), including a burst within the grace and the roster frame.

## Out of Scope

- Sharding a single huge room across several objects or processes.
- Encrypted or signed room messages (ADR-0002).
