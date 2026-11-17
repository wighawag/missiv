---
title: A contract-gated room accepts and stores messages from a session whose authorization failed
slug: gated-room-accepts-writes-without-authorization
date: 2026-11-17
---

# A failed room authorization still leaves the session logged in, so it can write

Seen in the S3 review of origin/main 79fe3ab (jolly-roger plan `docs/plans/template-tree-features.md`, step S3), and reproduced.

In `packages/server/src/Room.ts`, the login branch of `webSocketMessage` sets `session.address` and `session.publicKey` (`:294-304`) BEFORE it runs the room's `eth_call` authorization (`:306-343`). Every failure of that check (`:316-319` unsupported chain, `:329-335` RPC failure, `:337-340` wrong result) sends an error and `return`s, but leaves `session.address` set and `session.authorized` false. The send path then only checks `session.address` (`:371`), never `session.authorized`, so the session's next `{message}` is timestamped, broadcast to every session and stored (`:391-403`).

So for a semi-private room (`@<domain>!<authorization>`, `docs/adr/0001-contract-gated-room-authorization.md`), READING is gated (`pendingSessionSend` buffers for an unauthorized session, `:128-133`) but WRITING is not: any account registered on the domain can post into a room the contract refuses it.

## Reproduction (port-free, 2026-11-17)

A `Room` subclass on in-memory libSQL and fake sockets, a user registered on `test.com`, a room named `@test.com!1:0x1111...:0x:0x01` with no `CHAIN_1` configured: the login answered `{"error":"do not support chain with id 1"}`, the session had `authorized: false` and an address, and the next `{"message":"not allowed here"}` was stored as `{"timestamp":...,"message":"not allowed here","from":"0xaaaa...","signature":"0x"}`. The probe was a throwaway test in `test/client-server`, not committed.

## Also in the same branch

- The `eth_call` error text and the received value are echoed to the client (`:332`, `:338`).
- `response.value != expectedResult` compares hex strings case-sensitively.
- A login attempt that fails the authorization has already broadcast nothing, but a SECOND login with another address on the same socket broadcasts `quit` for the first (`:301`) before checking the second's authorization.

## Suggested direction (not yet decided)

Compute the identity and the authorization into locals and commit them to the session only when both pass; check `authorized` (or "no authorization required") on every send. A test that drives a refused session's send is the regression guard.
