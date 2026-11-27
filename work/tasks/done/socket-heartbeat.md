---
title: A heartbeat on every missiv socket, so an idle one that died is noticed and replaced
slug: socket-heartbeat
blockedBy: []
covers: []
---

## What to build

Today no missiv socket carries a heartbeat: neither the inbox socket (ADR-0006 "Live channel") nor the room sockets send pings, on the server or in `@missiv/client`. A proxy or a mobile network commonly drops an idle connection after 60 to 100 s, silently, and nothing notices until the next reconnect, so a quiet inbox stops receiving pushes without either side knowing.

- **The client sends the heartbeat** (browsers cannot send protocol pings): an application frame `ping` every interval (default 30 s, configurable on the inbox channel and the room store), and when no `pong` (or any frame) arrives within a timeout (default 10 s), it closes the socket and reconnects through the existing backoff, then syncs as on any reconnection.
- **Cloudflare answers without waking anything**: the Inbox and Room Durable Objects set `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))` (the exact strings pinned in `@missiv/common`), so a heartbeat costs neither duration nor a request (Durable Objects pricing: auto-responses incur no wall-clock time; check the current docs).
- **Node and Bun answer `ping` with `pong`** in the in-process inbox and room handlers, and close a socket that sent nothing for three intervals, so dead clients do not accumulate.
- The frame strings and default intervals live in `@missiv/common`; ADR-0006 "Live channel" gains a sentence on the heartbeat.

## Acceptance criteria

- [ ] With a fake clock and fake sockets: an inbox channel whose `pong` never comes closes and reconnects after the timeout and syncs again; one that gets its `pong` stays open
- [ ] The same for the room store
- [ ] Node/Bun close a socket idle for three intervals; a socket that keeps pinging stays open
- [ ] The Cloudflare Inbox and Room objects register the auto-response (asserted in the Workers test pool, or by a unit test of the wiring if the pool cannot observe it)
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- None, can start immediately.

## Prompt

Add the heartbeat described above. Client sockets: `packages/client/src/lib/inbox/index.ts` (`openInboxChannel`) and the room store in `packages/client/src/lib/room/`. Server: the in-process inbox (`createInProcessLiveInbox`, the inbox API) and `Room`; Cloudflare: `platforms/cf-worker/src/stores/inbox.ts` and the Room object in `platforms/cf-worker/src/worker.ts`. Context: `work/notes/ideas/switchable-inbox-transport-and-socket-heartbeat.md` (why sockets stay the default and why the heartbeat matters).

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

These are in the module comment of `packages/common/src/heartbeat.ts` and in `work/notes/observations/2026-11-27-socket-heartbeat-decisions.md` (link it from the done record). The two most likely to need your call:
1. **Server idle limit is fixed**: it is 90 s and not configurable. A client configured with an interval above 90 s will be closed as idle by Node/Bun.
2. **One close code**: 4002 `heartbeat-timeout` is used whichever side closes, because browsers can only send 1000 or 3000-4999 and 4001 is already `session-expired`.

The others:
3. `ping`/`pong` are plain text rather than JSON, because the Cloudflare auto-response matches the exact text.
4. Any frame counts as the answer to a ping in both directions.
5. A socket the client gives up on is treated as lost at once.
6. Cloudflare closes no socket as idle, since a hibernated socket costs nothing.
7. The heartbeat options are also on `openConversationList` and `openOneConversation`.
8. The `inboxSocketEvents` refactor described above.
