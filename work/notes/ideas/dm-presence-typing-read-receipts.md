---
title: Presence, "writing..." and read receipts for direct messages (asked for by Conquest's live mode)
slug: dm-presence-typing-read-receipts
date: 2026-11-28
---

# Raised by conquest-demo's game shell (branch ui/shell, 3ffe74b), the human asked for this note (2026-11-28)

Conquest's diplomacy panel (`conquest-demo` `web/src/lib/conquest-ui/comms/CommsPanel.svelte`) serves two delivery modes. In the turn-based one a message is an order and leaves with the turn, which needs nothing new from missiv. In the LIVE one (the real game's 24 h mode, where a message arrives as it is sent) the panel shows, per correspondent, whether they are online or away, that they are writing, and on your own messages delivered and read. The human asked whether missiv supports these for player-to-player DMs. Read in missiv at a69460a, it does not yet:

## What exists

- **Live delivery**: DMs reach the recipient over the live inbox channel (one WebSocket per client) or by polling, plus a web push (`docs/architecture.md`, `packages/server/src/delivery.ts`).
- **Online, server side only**: the server knows whether a user has the live inbox socket open in a domain (`live.isOnline`), and uses it only to skip a push (`PUSH_SKIP_WHEN_ONLINE`). Nothing publishes it to other users.
- **Last seen**: `DomainUser.lastPresence` (`packages/common/src/index.ts`) is stored per domain user and returned by `getDomainUser`. It is a timestamp, updated on registration and profile writes, not a live presence.
- **Read state, own only**: each member has `lastReadSeq` on its `Conversation` row, but the row is "as one member's inbox lists it": a member sees its own read state, never the other's.
- **Rooms** (public real-time chat) have a presence roster (join/leave frames). DMs do not.

## What the live mode would need

1. **Presence for DM correspondents**: online/away of the other member of a conversation, as a frame on the live inbox socket when it changes (and an initial snapshot per conversation), from the same `isOnline` the push skip uses. Privacy question to settle: whether presence is shown to anyone with a conversation, only to accepted conversations, or opt-in.
2. **Typing ("writing...")**: an ephemeral, unsaved, rate-limited frame sent by the writer and relayed to the other member's open sockets, expiring on its own (a few seconds) so a dropped "stopped" frame does not leave it stuck. Not stored, not pushed.
3. **Read receipts**: expose the OTHER member's `lastReadSeq` (or a "read up to" frame when it changes), so the sender can mark its messages read. Same privacy question as presence (many apps make it opt-out).
4. **Polling transport**: whether presence and typing exist at all under `INBOX_TRANSPORTS` polling (typing over polling is mostly noise; presence could come with the sync answer).

None of this is needed by the demo, which is turn-based. It becomes a requirement when the real game's 24 h mode ships diplomacy over missiv.

# Analysis (2026-11-28, missiv at 9b9512a)

Read against `CONTEXT.md`, `docs/architecture.md`, ADR-0003/0005/0006, `packages/server/src/{live,delivery,transports,heartbeat}.ts`, `packages/server/src/api/inbox/index.ts`, `platforms/cf-worker/src/stores/inbox.ts`, `packages/client/src/lib/conversation/index.ts`, and Conquest's `ThreadVM` (`view-models.ts` at 3ffe74b: `presence?: 'online' | 'away'`, `typing?: boolean`, message `status?: 'queued' | 'sent' | 'delivered' | 'read'`).

## Corrections and additions to the note above

- **Verified**: `lastPresence` is written only by `register` and `editUser` (`stores/sql/KeyDirectory.ts`), never by a session, socket or poll. It is returned by `getDomainUser`, a PUBLIC read, so it already tells anyone when an account last registered or edited its profile. Rooms do have join/leave roster frames (`Room.ts`). Read state is per member only. `isOnline` drives only the push skip.
- **`isOnline` is not a presence signal as it stands.** On Node.js and Bun it stays true up to 90 s after a client vanishes (the idle close). On Cloudflare it is true while ANY socket's token has not expired (`inbox.ts` `isOnline`: `claims.exp > now`), and Cloudflare closes no socket as idle, so a phone that drops off the network without a close frame counts as online for up to an hour (the token's life). Presence on Cloudflare needs a liveness test: `ctx.getWebSocketAutoResponseTimestamp(ws)` (present in `@cloudflare/workers-types`) gives the time of the last auto-answered `ping` without waking the object, so "a socket that answered a ping in the last 60 s" is cheap and exact. The same staleness already affects `PUSH_SKIP_WHEN_ONLINE` (observation `2026-11-28-cf-isonline-stale-up-to-token-expiry`).
- **A polling client is always offline** to `isOnline` (it holds no socket), so presence from `isOnline` would show every polling user as away.
- **Presence is per domain, not per namespace**: a socket covers the token's domain and every namespace. For Conquest that means "has the app open", not "is in this game".
- **"Read" today means "the thread's store was subscribed"**, not "a human saw it": `openOneConversation` with `markAsAcceptedAndRead` marks every newly opened message read (and accepts the conversation first), whether or not the tab is visible. A receipt built on it would lie on a background tab.
- **"Delivered" has no meaning in missiv yet, and must not mean "reached the recipient's device"**: a message from a blocked sender is acknowledged and stored hidden, and the sender must not learn the block (ADR-0006 "Sending"). A device-level delivery tick would stay missing for exactly the blocked sender. The honest mapping is `sent` = the server stored it (the send's answer with its seq) and `read` = the receipt; `delivered` should be dropped or made an alias of `sent`.
- **A new client frame breaks old servers**: today any client frame other than `sync` and `ping` closes the socket with 1008 (`api/inbox/index.ts`, `inbox.ts` `answer`). Typing and presence requests need the client to know the server accepts them (a feature list on `ready`, or a second protocol name such as `missiv-inbox-2` at the upgrade), and the server should ignore, not close on, an unknown frame type from then on.

## Read receipts (recommended first: the data exists, works on every transport)

- **Shape**: the reader-facing row gains the other member's read point, e.g. `Conversation.otherReadSeq` (hidden or 0 when the other member does not share receipts). It travels everywhere a row already does: `listConversations`, `conversation` frames and `POST /api/inbox/changes`, so polling and the socket get it for free.
- **Storage**: a column on the inbox row. When B marks read, A's row's `otherReadSeq` is raised (monotonic, `MAX`) and A's row takes the next inbox version, so a poll sees it. Node.js and Bun: one more UPDATE in `markRead`'s statement batch, and `deliverConversation` to A as well as to B. Cloudflare: B's Inbox object cannot write A's; it hands the read point to the Conversation object (one RPC), which queues it for A's Inbox object in its existing outbox (alarm-retried, idempotent because monotonic). About 2 extra DO requests and 2 to 3 row writes per markRead.
- **Rate**: markRead is per received message while a thread is open. Debounce on the client (one markRead per thread per 1 to 2 s, only while visible) rather than adding a server bucket; a server-side cap can reuse the token buckets if needed.
- **Blocks**: B's `lastReadSeq` is clamped to B's `lastSeq`, which excludes hidden messages, so a blocked sender simply never sees "read" (indistinguishable from not read). One edge: after an unblock, reading a newer seq covers the older hidden seqs too, so those show read though never seen. The sender cannot tell which of its messages were hidden, so this is accepted rather than fixed.
- **Truthful read**: gate `markRead` on the thread being open AND the document visible (`document.visibilityState`), a client change in `openOneConversation`.

## Presence

- **Meaning**: online = a live socket in the domain with a ping answered in the last ~60 s, or a poll in the last ~2 poll intervals; otherwise away, optionally with a coarse "active N min ago".
- **Pull, not fan-out**: pushing every connect and disconnect to every correspondent costs one DO call per conversation on Cloudflare, mostly to offline users, and is lost to hibernation unless stored. Instead the client asks for the peers it shows: a `{type: 'presence', conversations: [...]}` frame (bounded, e.g. 20) answered by `{type: 'presence', states: {...}}`, sent when a thread opens and every 30 to 60 s while it is open and visible; under polling the same request as `POST /api/inbox/presence`. Never piggybacked on `ping`, which must stay an auto-response that wakes nothing.
- **Who answers**: the PEER's side decides, because it holds the peer's row (status), block list and settings. Node.js and Bun: in process, the live map plus a last-active map. Cloudflare: the watcher's Inbox object calls each peer's Inbox object (one RPC each), which checks the conversation is one it accepted, that it does not block the asker, the peer's setting, and its sockets' auto-response timestamps.
- **Polling and several Node/Bun instances**: polling alone is the multi-instance mode (ADR-0005), so a poll's last-active time must be shared: a throttled write (at most once a minute per user) of a last-active timestamp, in SQL on Node/Bun (a column with `lastPresence`'s meaning, though `DomainUsers` is the public directory, so a separate private one is better) and in the Inbox object's storage on Cloudflare (never D1). Cost: one row write per active user per minute. Socket presence across several instances would need the bus that is not built; not needed while multi-instance means poll-only.
- **Cloudflare cost** (estimate from the published pricing: $0.15 per million requests, incoming WebSocket messages counted 20:1, $12.50 per million GB-s): one presence refresh per open thread per 30 s is about one DO RPC each, so ~120 requests per hour of an open thread, cents per thousand users per month.

## Typing ("writing...")

- **Wire**: client frame `{type: 'typing', conversation}` at most once per 3 s while the user types; relayed to the other member's sockets as `{type: 'typing', conversation, from}`; the receiver shows it for ~5 s after the last frame and clears it when a message from that member arrives. No "stopped" frame needed. Never stored, never pushed, never in a sync.
- **Checks** (silently dropped, so the writer learns nothing): the writer is a member, the peer has not blocked the writer, the peer accepted the conversation, both share typing (setting).
- **Rate limit**: drop, do not close, past a small bucket (e.g. burst 5, one per 2 s per account and domain). On Cloudflare the writer's Inbox object holds it in memory, which is exact (one object per user), unlike the per-isolate send bucket.
- **Transport**: socket only. Under polling typing does not exist (a 5 s poll makes it noise), and with several Node/Bun instances there is no bus; both simply show no typing.
- **Cloudflare cost** (estimate): per typing frame, 1/20 request for the incoming message, one RPC from the writer's Inbox object to the peer's (one request), two short wakes. 10 000 daily users typing 20 min a day at one frame per 3 s is ~4 M frames a day, ~130 M requests a month (~$20) plus a few dollars of duration. Node.js and Bun: in-memory relay, negligible.

## Privacy (one setting per account and domain covers all three, or one per feature)

- Shown only within a conversation the OBSERVED member accepted, never to a requester they have not accepted, never to someone they block; the asker gets the same "unknown/away" in all those cases and for an opt-out, so neither a block nor the setting is revealed.
- Reciprocal (as most apps): who hides their receipts or presence sees nobody's.
- Defaults are a product decision (see the questions to the human): receipts and typing are commonly on by default with an opt-out; presence varies.

## Recommendation

One ADR-0006 amendment for the wire (feature announcement, unknown frames ignored, the three frames or fields, the setting), then in order: read receipts (all transports, all platforms), typing (socket only), presence (pull, with the throttled last-active for polling). Conquest maps `sent` to the server's acknowledgement, `read` to `otherReadSeq`, and drops `delivered`.

## Decision so far (the human, 2026-11-28)

Read receipts first: they reuse stored state, need no new socket frame, and work on every transport and platform. Typing and presence are deferred: each adds a recurring per-user cost on Cloudflare (requests and wakes for every typing burst or presence refresh), polling and multi-instance support only in part, and a new client frame that needs the wire's feature announcement first. They stay described above for when Conquest's live mode needs them. Decided for receipts (the human, 2026-11-28): on by default with an opt-out, reciprocal (who hides theirs sees nobody's); no `delivered` state (a message is `sent`, then `read`); `markRead` only while the thread is visible. Because receipts add only a field to the inbox row, they need no client frame, so the feature announcement can wait for typing.
