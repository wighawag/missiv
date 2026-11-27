---
title: Per-account token-bucket limits on sends and per-IP limits on sessions and registration
slug: account-rate-limits
spec: scalable-direct-messaging
blockedBy: [sqlite-conversation-store-and-api]
covers: [27]
---

## What to build

A token bucket per account for sends (in process on Node/Bun with idle eviction; in the Inbox Durable Object once `cloudflare-durable-object-stores` lands, an in-isolate approximation before), and a coarse per-IP bucket on `/session` and `register`. Burst and refill configurable through env. A refusal is `rate_limited` with a retry-after. Fix the existing leak: `createInProcessRooms`' limiter map is never evicted.

## Acceptance criteria

- [ ] A burst within the bucket is accepted; beyond it `rate_limited` with retry-after; refill restores sending
- [ ] Two accounts behind one IP have independent send budgets
- [ ] In-process limiter state is evicted when idle (tested with a fake clock)
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- sqlite-conversation-store-and-api

## Prompt

Spec `scalable-direct-messaging` story 27. Today's limiter is `RateLimiter` / `RateLimiterClient` (rooms only), with the defect in `work/notes/observations/room-rate-limiter-refuses-back-to-back-messages.md`; rooms themselves are spec `scalable-rooms`, not this task.

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code, `work/tasks/done/`, ADR-0003/0004/0005/0006 and the tasks it depends on? If a dependency landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record) and link them. Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim account-rate-limits --arbiter <remote>
git fetch <remote> && git switch -c work/account-rate-limits <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/account-rate-limits.md work/tasks/done/account-rate-limits.md
```

## Decisions

The builder recorded its in-scope decisions in a separate note; see:

- [2026-11-27-account-rate-limits-decisions.md](../../notes/observations/2026-11-27-account-rate-limits-decisions.md)
