---
title: Direct messaging built for a massive number of messages and high throughput
slug: scalable-direct-messaging
humanOnly: true
---

> Launch snapshot, records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/` tasks. Decisions: `docs/adr/0004-messaging-keys-one-ciphertext-server-checked-signatures.md`, `docs/adr/0005-conversation-and-inbox-stores-on-every-platform.md`, `docs/adr/0006-the-0-6-direct-messaging-wire-and-store-contract.md`.

## Problem Statement

missiv 0.5's direct messaging (`@missiv/server` and `@missiv/common` 0.5.0, `@missiv/client` 0.4.1) does not scale. From a code read on 2026-11-27 (no benchmark existed):

- A send to N members costs about 2N+6 database calls: the signer's lookup, N sequential key lookups (`publicKeysOf`), an unindexed `Blocks` scan (`blockersOf` filters on `blocked`, which the primary key does not lead with), two writes for the replay table (`RequestSignatures` DELETE + INSERT), 1+2N writes for the message, and N more sequential lookups for pushes (`domainUsersOf`). On Cloudflare every call is a round trip to D1, a single SQLite writer.
- Every message is stored once per member (up to 16 KB each), including the sender's own copy.
- Clients poll: an open conversation fetches the newest page of up to 100 messages every 2 s (`getMessages` has no `after` cursor) and decrypts and verifies all of them again; the conversation list polls every 20 s and its query sorts all of the user's conversations by a column of another table.
- Every request is signed with secp256k1 and the server recovers the key (1.35 ms measured, Node 24, `@noble/secp256k1`) and looks the signer up in the database.
- Node/Bun: `createInProcessRooms`' rate-limiter map is never evicted.

## Solution

A breaking redesign (missiv 0.6, empty database) of 1:1 direct messaging, shaped so that group messaging with sender keys (Signal/MLS style) can be added later without changing the message format:

- **Ed25519/X25519 keys named in the wallet's publication**: an Ed25519 signing key and an X25519 encryption key, derived deterministically from the origin key by `delegated-identity` and authorized directly by the wallet's signature at sign-in (a breaking change of the publication message, shared with `@etherplay/connect`, push-notification-server and etherfold's triggers; every connected account signs it once more) (ADR-0004).
- **Sessions**: one `delegated-identity` signed request (Ed25519) opens a session; requests and sockets carry an HMAC token after that.
- **One ciphertext per message**, carrying `scheme` and `keyID`, signed once by the sender's Ed25519 key over a client-chosen messageID; the server verifies the signature (it is also the send's authorization and replay guard) and the client still verifies everything (ADR-0003).
- **Per-conversation sequence numbers** and an `after` cursor: a client only ever fetches what is new.
- **Live delivery**: one WebSocket per signed-in client to its inbox, receiving new messages and conversation updates; catch-up by sequence on reconnect; Web Push for offline recipients.
- **Store ports** (KeyDirectory, ConversationStore, Inbox) with native implementations: SQLite in process on Node/Bun, D1 + per-conversation and per-user Durable Objects on Cloudflare; one contract test suite for all (ADR-0005).
- **A load harness** that measures sends, catch-up reads and live fan-out, run before and after, so every claim here becomes a number.

## User Stories

1. As an operator, I want a repeatable load test against the Node platform (and Bun, and `wrangler dev`), so that I know the throughput and latency of sends, reads and live delivery before and after each change.
2. As a user, I want my wallet to authorize my app keys once per app at sign-in through `@etherplay/connect`, and to be asked once more only because this change replaces the authorized keys, so that messaging needs no prompt after that.
3. As a user on several devices, I want each device to derive the same messaging keys, so that every device reads every message.
4. As a server operator, I want messages and sessions verified with Ed25519, so that the server's CPU per request drops by an order of magnitude.
5. As a client, I want to open a session once and send a token afterwards, so that reads cost no signature and no directory lookup.
6. As a server, I want to refuse an expired or forged token, so that sessions are as safe as the signed requests they replace.
7. As a sender, I want one ciphertext stored per message, readable by both members of the conversation, so that a message costs one write of its content.
8. As a sender, I want my message's signature to authorize the send, so that I sign once per message.
9. As a server, I want to refuse a message whose signature does not verify against the sender's registered key, so that nothing forged is ever stored.
10. As a server, I want a duplicate `(domain, namespace, conversationID, messageID)` answered as the retry it may be (same signature: the stored sequence number) and refused `conflict` otherwise, and a messageID whose time is outside the accepted window refused `stale`, so that replay needs no extra table or write and a retry after a lost response is not reported as a failure.
11. As a reader, I want each message to reference its sender's key set and ownership proof, so that I still verify it myself after the sender replaced their keys.
12. As a reader, I want a message I cannot verify or decrypt shown as `unverified` / `undecryptable`, the rest of the thread unaffected, as today.
13. As a client, I want messages ordered by a per-conversation sequence number, and to fetch only those after the last one I have, so that reading costs what is new.
14. As a client, I want to page backwards through history by sequence, so that long conversations load on demand.
15. As a user, I want my conversation list ordered by last message, filtered by accepted / unaccepted, from an index, so that it stays fast with many conversations.
16. As a user, I want unread state (last read sequence) per conversation, so that the list shows what is new.
17. As a user, I want to accept, reject (and so block the other member in the domain) and unblock, as today, so that unwanted senders cannot reach me.
18. As a sender who has been blocked, I want my send to look accepted, as today, so that a block is not revealed; the recipient never sees it.
19. As a signed-in client, I want one WebSocket that pushes my new messages and conversation updates, so that I never poll.
20. As a client that reconnects, I want to catch up from each conversation's last sequence, so that nothing pushed while I was away is lost.
21. As an offline recipient, I want a Web Push notification as today (same `MissivPushData` / hand-off contract), so that I learn of new messages.
22. As an online recipient, I want the push to be skippable while I have a live connection (a server option), so that I am not notified twice.
23. As a self-hoster, I want Node and Bun to run everything in one process on SQLite, with no Cloudflare dependency, so that I can host missiv myself.
24. As a Cloudflare operator, I want conversations and inboxes in Durable Objects and only the key directory in D1, so that writes are not bounded by one D1 writer.
25. As a maintainer, I want one contract test suite run against every store implementation, so that platforms cannot drift.
26. As a future group-messaging implementer, I want `scheme`, `keyID` and a reserved key-envelope model, so that sender keys are a new scheme, not a new format.
27. As an operator, I want per-account rate limits on sends (a token bucket), so that one abusive account cannot saturate a conversation or the server, and shared IPs are not punished.

### Autonomy notes

- `humanOnly: true` on this spec: it carries cryptographic and protocol decisions (ADR-0004) a human should drive the tasking of; it was tasked in place with the human on 2026-11-27. The tasks themselves are agent-buildable except where flagged.
- No open questions remain at launch; the decisions are in ADR-0004 and ADR-0005.

## Implementation and testing detail

Tasked on 2026-11-27 (every story is covered by a task in `work/tasks/`). The implementation and testing detail moved into those tasks and into ADR-0004 (keys and crypto), ADR-0005 (store ports per platform) and ADR-0006 (the 0.6 wire and store contract).

## Out of Scope

- Group messaging and the `sender-key-v1` / `mls-v1` schemes (the format reserves them; nothing more).
- Several Node instances behind a load balancer (the Inbox live side keeps a bus seam; no bus is built).
- Migrating 0.5 data.
- Rooms: their own spec, `scalable-rooms`.
- Forward secrecy for 1:1 (would come with a ratcheting or sender-key scheme).

## Further Notes

- Baseline evidence: the Problem Statement above (a code read, 2026-11-27); measured signature costs are in ADR-0004. The load harness replaces both with measurements.
- The publication message is shared with `@etherplay/connect`, push-notification-server and etherfold's triggers (findings `publication-message-shared-with-etherplay-connect`, `shared-identity-across-services`): it changes for all of them at once, from `delegated-identity`, and this spec's key-dependent tasks wait for that release and for connect's.
