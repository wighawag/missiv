---
title: A load harness that measures sends, catch-up reads, live fan-out and rooms
slug: load-harness
spec: scalable-direct-messaging
blockedBy: []
covers: [1]
---

## What to build

A workspace package under `test/` (not run by `pnpm test`; its own script, e.g. `pnpm load`) that drives a missiv server over real HTTP and WebSockets with many simulated clients (real keys, registered as the tests do) and reports throughput and latency percentiles (p50/p95/p99) for: 1:1 sends, reading a conversation (today: `getMessages` polling; later: catch-up by sequence), the conversation list, and room fan-out (N sockets in one room, M messages/s, time to last delivery). Targets: the Node platform (started in process on a port), Bun, and a URL (for `wrangler dev` or a deployment). Parameters on the command line (clients, duration, conversation count, room size). It works against today's 0.5 API first, behind a small client adapter so later APIs are further adapters, not a rewrite.

Record the 0.5 baseline (machine, versions, parameters, numbers) as `work/notes/findings/load-baseline-0-5.md`. This task comes first: every later task that changes the API is blocked on it, so the baseline is measured while 0.5 still runs.

## Acceptance criteria

- [ ] One command runs a named scenario against Node and prints throughput and p50/p95/p99 latencies
- [ ] The same scenarios run against Bun and against a given URL
- [ ] Room fan-out is measured (connections, rate, delivery latency)
- [ ] The 0.5 baseline is recorded in `work/notes/findings/load-baseline-0-5.md`
- [ ] The API is reached through an adapter so later adapters can be added
- [ ] Every server or process the harness starts is stopped when it ends (no process left behind)

## Blocked by

- None, can start immediately.

## Prompt

Build missiv's load harness (spec `scalable-direct-messaging`, story 1; the spec's Problem Statement lists the suspected costs, the harness turns them into numbers). Reuse the registration and request-signing helpers the client-server tests use (`test/client-server/test/setup.ts`, `@missiv/client`'s `API`). Keep it out of `pnpm test`.

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code, `work/tasks/done/`, ADR-0003/0004/0005/0006 and the tasks it depends on? If a dependency landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record) and link them. Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim load-harness --arbiter <remote>
git fetch <remote> && git switch -c work/load-harness <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/load-harness.md work/tasks/done/load-harness.md
```
