---
title: Store ports, the SQLite ConversationStore and Inbox, and the 0.6 messaging API
slug: sqlite-conversation-store-and-api
spec: scalable-direct-messaging
blockedBy: [load-harness, sessions-and-tokens, one-ciphertext-message-format]
covers: [9, 10, 13, 14, 15, 16, 17, 18, 23, 25]
---

## What to build

In `@missiv/server`: the three ports of ADR-0005 (KeyDirectory, ConversationStore, Inbox; the Inbox's live side is `live-inbox-channel`) and one SQL implementation over `remote-sql` serving Node (libSQL), Bun (bun:sqlite) and, as an interim, Cloudflare (D1). Everything per ADR-0006: conversations keyed by `(domain, namespace, conversationID)`; messages by seq with unique messageID; inbox rows with `lastSeq` / `lastReadSeq` and the list index; key sets by `(domain, keyRef)`; domain-level blocks read in the send transaction. A send is one transaction (append with the next seq, block check, inbox rows of both members); `Inbox.update` is idempotent and monotonic.

The 0.6 API (zod in `@missiv/common`, ADR-0006 "API"): `messages/send` authorized by the token plus the message signature against the sender's current key set (the request signature and `refuseReplay` leave sends); the 10-minute messageID window (`stale` with the server's time); a duplicate messageID with the same signature answers the stored seq, with another signature `conflict`; two members only. `listMessages` (`after` / `before` by seq), `listConversations`, `accept`, `reject` (blocks the other member in the domain), `unblock`, `markRead {seq}`; `getDomainUser` and `getKeySet` kept. A blocked sender's message is acknowledged and stored hidden from the recipient. Per-recipient copies are removed; the replay set stays for `/session` and `register` only. Pushes use the recipients already loaded for the send. `@missiv/client`'s stores move to the new API with `after`-cursor fetching (polling stays until `live-inbox-channel`).

A store contract test suite, parameterized by implementation, run on libSQL and bun:sqlite (Cloudflare joins in `cloudflare-durable-object-stores`).

## Acceptance criteria

- [ ] A 1:1 send writes one message row and costs a bounded number of statements independent of history size (asserted)
- [ ] A forged signature, a wrong sender key and an out-of-window messageID are refused, nothing stored; a retried send (same messageID, same signature) answers the stored seq; the same messageID with another signature is `conflict`
- [ ] The same two members in two namespaces (and two domains) have separate conversations, sequences and statuses
- [ ] `listMessages` with `after` returns only newer messages in seq order; `before` pages back; conversation lists come from the index with stable cursors; unread is derived from `lastReadSeq`
- [ ] Reject blocks the other member across the domain, unblock lifts it, and a block is not revealed to the sender
- [ ] The contract suite (including a reordered and a repeated `Inbox.update`) passes on libSQL and bun:sqlite; the client-server tests pass on the new API
- [ ] The Node and Bun platforms boot and serve the new API (run them; the Bun platform went unrun before); the Bun platform declares Bun 1.3.13 or later
- [ ] The load harness has a 0.6 adapter; the send and read scenarios' numbers against the 0.5 baseline are in a finding next to it
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- load-harness
- sessions-and-tokens
- one-ciphertext-message-format

## Prompt

Implement ADR-0005's ports with the SQL implementation, to ADR-0006 (the contract) and spec `scalable-direct-messaging`. Today's storage is `RemoteSQLStorage` and the routes are the server's private and user APIs. See `work/notes/observations/bun-and-cf-worker-platforms-not-run-since-0-4.md`.

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code, `work/tasks/done/`, ADR-0003/0004/0005/0006 and the tasks it depends on? If a dependency landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record) and link them. Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim sqlite-conversation-store-and-api --arbiter <remote>
git fetch <remote> && git switch -c work/sqlite-conversation-store-and-api <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/sqlite-conversation-store-and-api.md work/tasks/done/sqlite-conversation-store-and-api.md
```

## Decisions

The builder recorded its in-scope decisions in a separate note; see:

- [2026-11-27-sqlite-conversation-store-and-api-decisions.md](../../notes/observations/2026-11-27-sqlite-conversation-store-and-api-decisions.md)
