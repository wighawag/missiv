---
title: Cloudflare: conversations and inboxes in Durable Objects, D1 for the key directory only
slug: cloudflare-durable-object-stores
spec: scalable-direct-messaging
blockedBy: [live-inbox-channel]
covers: [24, 25]
---

## What to build

ADR-0005's Cloudflare side, to ADR-0006: a Conversation Durable Object (SQLite storage) per `(domain, namespace, conversationID)`, its name derived from the triple; an Inbox Durable Object (SQLite storage, hibernatable WebSockets) per (domain, user) with its live side; D1 for the KeyDirectory only, with an in-isolate cache of short TTL for key lookups. The Worker verifies the token at upgrade and routes the socket to the user's Inbox. Send path: Worker (token, signature) → Conversation object (dedup, block check, seq) → Inbox objects of both members, retried by alarm until acknowledged, applied idempotently and monotonically → sockets / Web Push via `waitUntil`. Blocks: the blocker's Inbox owns its block list and propagates it to the Conversation objects it shares with the blocked member; a Conversation object created later reads the block state from both members' Inboxes before its first append. Wrangler migrations for the new classes. The store contract suite runs on the Workers runtime (`@cloudflare/vitest-pool-workers` or Miniflare).

## Acceptance criteria

- [ ] The contract suite passes on the Cloudflare implementation
- [ ] A failed Inbox update is retried by alarm, a repeated or reordered one changes nothing, and the client's `sync` heals the list meanwhile (tested by injecting a failure)
- [ ] A block set in one namespace stops the blocked member's sends in every namespace of the domain, including a conversation started after the block
- [ ] Inbox sockets survive hibernation (session data in the socket attachment)
- [ ] `wrangler dev` serves the full client-server flow; the load harness runs against it and the numbers are in a finding
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- live-inbox-channel

## Prompt

Port the ports of ADR-0005 to Durable Objects, to ADR-0006. Today's Cloudflare host is `platforms/cf-worker` (rooms and limiters already are Durable Objects with hibernation, prior art for attachments). Durable Object behaviour (SQLite storage, alarms, hibernation API) must be checked against Cloudflare's current docs, not memory; record anything surprising in `work/notes/findings/`.

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code, `work/tasks/done/`, ADR-0003/0004/0005/0006 and the tasks it depends on? If a dependency landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record) and link them. Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim cloudflare-durable-object-stores --arbiter <remote>
git fetch <remote> && git switch -c work/cloudflare-durable-object-stores <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/cloudflare-durable-object-stores.md work/tasks/done/cloudflare-durable-object-stores.md
```
