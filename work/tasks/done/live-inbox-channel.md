---
title: A live inbox WebSocket per client: pushed messages and conversation updates, catch-up by sequence, no polling
slug: live-inbox-channel
spec: scalable-direct-messaging
blockedBy: [sqlite-conversation-store-and-api]
covers: [19, 20, 21, 22]
---

## What to build

`GET /inbox/ws` per ADR-0006 "Live channel": the session token presented at upgrade (`Sec-WebSocket-Protocol`, or a one-shot ticket from an HTTP call), verified before the socket is accepted; `message` and `conversation` frames for every send that reaches the user (both members, the sender's other devices included); `sync` with the last seq per conversation the client holds, answered with what it missed, then `ready`; at the token's expiry the server closes with a `session-expired` code and the client reconnects with a renewed token. Node/Bun: an in-process registry of connections per user, behind an interface a multi-instance bus could implement later (not built). Web Push stays for recipients; a server option skips it when the recipient has a live connection. `@missiv/client`'s conversation and conversation-list stores drop polling and run on the socket, reconnecting with backoff.

## Acceptance criteria

- [ ] A message sent by A reaches B's open socket without any request from B
- [ ] After a disconnect, `sync` delivers exactly the missed messages, no duplicates in the store
- [ ] An upgrade with a bad or expired token is refused; an open socket is closed with `session-expired` at the token's expiry and the client resumes with a renewed one
- [ ] With the option set, an online recipient gets no Web Push; offline still gets one with the unchanged `MissivPushData` / hand-off
- [ ] The client library contains no polling loop for messages or conversations
- [ ] The load harness has a live fan-out scenario; its numbers are in a finding
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- sqlite-conversation-store-and-api

## Prompt

Build the Inbox's live side (ADR-0005, ADR-0006) on Node and Bun and switch the client stores to it (spec `scalable-direct-messaging`, stories 19-22). Prior art for in-process sockets: the room wiring in the server's public API and `@hono/node-ws` in the Node platform. The push contract is `work/tasks/done/push-data-contract-and-hash-handoff.md`.

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code, `work/tasks/done/`, ADR-0003/0004/0005/0006 and the tasks it depends on? If a dependency landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record) and link them. Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim live-inbox-channel --arbiter <remote>
git fetch <remote> && git switch -c work/live-inbox-channel <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/live-inbox-channel.md work/tasks/done/live-inbox-channel.md
```

## Decisions

The builder recorded its in-scope decisions in a separate note; see:

- [2026-11-27-live-inbox-channel-decisions.md](../../notes/observations/2026-11-27-live-inbox-channel-decisions.md)
