---
title: A switchable inbox transport, socket or polling, with an inbox version that makes an empty poll cheap
slug: switchable-inbox-transport
blockedBy: [socket-heartbeat]
covers: []
---

## What to build

Let a deployment and a client choose how direct messages are delivered: the live inbox socket (today's, the default) or HTTP polling, with `auto` falling back from one to the other. Reasons and costs are in `work/notes/ideas/switchable-inbox-transport-and-socket-heartbeat.md`: sockets are cheaper on Cloudflare (a hibernated socket costs nothing idle, every poll is a Worker plus a Durable Object request); polling lets several Node instances run behind a plain load balancer without a message bus, and passes WebSocket-hostile proxies.

- **An inbox version**: a monotonic counter per (domain, user), incremented by every `Inbox.update` that changes a row (and by accept, reject, unblock, markRead); each inbox row records the version at which it last changed. Stored with the inbox rows (the SQL implementation; the Inbox Durable Object on Cloudflare). On Node/Bun a single process also keeps the current version per user in memory, so an unchanged poll touches no database; the SQL read stays correct for several instances.
- **`POST /inbox/changes {domain, since}`** (session token): answers `{version, unchanged: true}` when the user's version is not above `since`, otherwise `{version, conversations}`: the inbox rows changed after `since` (paged like `listConversations`). The client then fetches messages with `listMessages {after}` for the conversations it shows. A `since` of 0 means everything. The socket gains the version too: `conversation` frames carry it, so a client that switches transport keeps its position.
- **Client**: the inbox channel takes `transport: 'socket' | 'poll' | 'auto'` (default `auto`) and `pollIntervalMs` (default 5 s). `auto` uses the socket, switches to polling after the socket failed to open (or died) several times in a row, and tries the socket again periodically. Stores see the same `onMessage` / `onConversation` callbacks whatever the transport.
- **Server config**: which transports a deployment offers (`INBOX_TRANSPORTS=socket,poll` by default; `poll` alone for several Node instances without a bus); `/inbox/ws` answers 404 when `socket` is off, `/inbox/changes` when `poll` is off, and a client in `auto` adapts.
- **Load harness**: a `poll` scenario (N clients polling, M sends/s) reporting empty-poll throughput and delivery latency next to `live`, with the numbers in a finding.
- ADR-0006 gains the inbox version, `/inbox/changes` and the transport setting (an amendment section); ADR-0005 notes that polling is the multi-instance path until a bus exists.

## Acceptance criteria

- [ ] An unchanged poll answers `unchanged` without a database read on Node/Bun (asserted with a counting wrapper), and with only the Inbox object's own state on Cloudflare
- [ ] A changed poll returns exactly the rows changed after `since`, and the version never goes backwards (a reordered or repeated `Inbox.update` does not bump it)
- [ ] A client on `poll` receives a message sent to it within one interval; on `auto`, a socket that cannot open falls back to polling and returns to the socket when it can
- [ ] With `INBOX_TRANSPORTS=poll` the socket route is off and a client in `auto` works by polling
- [ ] The contract suite covers the version on libSQL, bun:sqlite and Cloudflare
- [ ] The load harness has a `poll` scenario; its numbers are in a finding
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- socket-heartbeat (the reconnection and failure counting `auto` relies on)

## Prompt

Build the switchable transport described above, to ADR-0005 and ADR-0006. The inbox ports are in `packages/server/src/stores/ports.ts` (`Inbox`, `LiveInbox`), the socket route and `answerSync` in `packages/server/src/api/inbox/index.ts`, the client channel in `packages/client/src/lib/inbox/index.ts`, the Cloudflare Inbox object in `platforms/cf-worker/src/stores/inbox.ts`, the harness under `test/`.

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code on main, `work/tasks/done/` and ADR-0005/0006? If not, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record). Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`. Stop every server or process you start.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim <slug> --arbiter <remote>
git fetch <remote> && git switch -c work/<slug> <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/<slug>.md work/tasks/done/<slug>.md
```

## Decisions

The builder recorded its in-scope decisions in a separate note; see:

- [2026-11-27-switchable-inbox-transport-decisions.md](../../notes/observations/2026-11-27-switchable-inbox-transport-decisions.md)
