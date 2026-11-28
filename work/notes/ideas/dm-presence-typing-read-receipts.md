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
