---
status: proposed
---

# Conversations and inboxes behind store ports, built natively on every platform

missiv runs on Node.js, Bun and Cloudflare Workers so that it never depends on Cloudflare or its pricing (decided with the human, 2026-11-27). The throughput redesign (spec `scalable-direct-messaging`) therefore puts direct messaging behind three platform-agnostic ports in `@missiv/server`, and each platform implements them the way it scales best, rather than the core assuming one database:

- **KeyDirectory**: domain users, their key sets (Ed25519 and X25519 public keys) and the wallet's ownership signatures over them. Read-heavy, rarely written, cacheable.
- **ConversationStore**: per conversation (`(domain, namespace, conversationID)`), its members and their status (accepted, rejected), and its messages, appended with a per-conversation sequence number the store assigns. The one serialization point of a conversation.
- **Inbox**: per user, their conversation list (ordered by last message, filtered by status, with unread state) and their live connections, to which new messages and conversation updates are pushed.

Implementations:

- **Node.js and Bun**: one process with SQLite (libSQL / bun:sqlite) in WAL mode for all three, and live connections in an in-process registry. Local SQLite has no network round trip, so one process carries a large load; a send is one transaction. Running several Node instances later needs only a shared database and a fan-out bus behind the Inbox's live side (a seam, not built now). Until a bus exists, polling is the multi-instance path (amended 2026-11-27, ADR-0006 "Amendment: the inbox version and polling"): with `INBOX_TRANSPORTS=poll` every instance serves `POST /api/inbox/changes` from the shared database, the socket route is off, and clients in `auto` poll.
- **Cloudflare**: D1 for the KeyDirectory only; a Durable Object per conversation (SQLite storage) as the ConversationStore; a Durable Object per user (SQLite storage, hibernatable WebSockets) as the Inbox. Writes spread over many objects instead of one D1 writer.

The same contract test suite runs against every implementation, so a platform cannot drift silently (the bun and cf-worker platforms went unrun once before: `work/notes/observations/bun-and-cf-worker-platforms-not-run-since-0-4.md`).

## Considered options

- **One central SQL database for all platforms, sharded later**: simpler to share code, but D1 is one SQLite writer per database, so Cloudflare would need hand-rolled sharding to scale, and it gives nothing for live delivery.
- **Cloudflare-first with Node/Bun as a lesser copy**: rejected; the self-hosted platforms are the hedge against Cloudflare and must stay first-class.

## Consequences

- An Inbox update is a second write after the conversation append (on Cloudflare a call to another object). It must be retried (a Durable Object alarm on Cloudflare), and it is idempotent and monotonic (applied only when its sequence number is above the stored one, ADR-0006), and the client reconciles on reconnect from each conversation's sequence number, so a lost update delays the list, never loses a message.
