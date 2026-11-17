---
title: Delegate-key signatures bind no time, route or purpose, so they replay and can be confused across protocols
slug: signed-requests-are-replayable-and-undomained
date: 2026-11-17
---

# What the delegate key signs is raw keccak of bytes, with nothing that scopes it

Seen in the S3 review of origin/main 79fe3ab; the replay is reproduced, the cross-protocol risk is argued, not exploited.

- **HTTP requests**: the client signs `keccak_256(body)` with the delegate key (`packages/client/src/lib/API.ts:62-63`) and the server recovers the key from the `SIGNATURE` header over the raw body (`packages/server/src/setup.ts:60`, `utils/signature.ts:5-11`). No timestamp, nonce, route or server origin is in the preimage, so anyone who sees a request (a proxy, a log, the server itself) can resend it forever, and a body valid for one route is valid for any route whose schema it also satisfies. Reproduced (port-free, 2026-11-17): the same signed `sendMessage` body sent twice stored 2 messages.
- **Room login**: the client signs `keccak_256(challenge)` for whatever challenge string the server sent (`packages/client/src/lib/room/index.ts:438`), verified at `packages/server/src/Room.ts:285`. The challenge is fresh per socket, which is replay protection for the room, but the key signs server-chosen bytes verbatim.
- **No domain separation**: neither preimage carries a prefix naming missiv or the purpose. The delegate key is not a missiv-only key: with `@etherplay/connect` it is the origin account's key (`etherplay-connect-core` `deriveOriginAccount`, see `work/notes/findings/publication-message-shared-with-etherplay-connect.md`), an Ethereum account that also signs delegations and, in jolly-roger's with/local-signer, the app's own transactions. A signer that signs raw keccak of attacker-chosen bytes is one bad preimage away from signing something else. This matters more once push-notification-server and the trigger service verify signatures by the same key (the jolly-roger plan's S1-2 and S1-3).

## Suggested direction (not yet decided)

One envelope for every delegate signature: an EIP-191-style personal message (or EIP-712) over `missiv:<purpose>` plus the server origin, the route, a timestamp with a short validity window, and the body hash; the server refuses stale or repeated (timestamp, signature) pairs where a write is not idempotent. Shared with S1-3's package so the push server and the trigger service verify the same envelope.
