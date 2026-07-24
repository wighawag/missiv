---
title: Handle send-message errors in the frontend (rate-limit, etc.)
slug: frontend-send-message-error-handling
blockedBy: []
covers: []
---

## What to build

When a user sends a message in the client and the server rejects or fails it, surface that failure to the user instead of silently dropping it. The server already returns error conditions on the send paths — a rate-limit rejection ("Your IP is being rate-limited, please try again later."), a "Not Logged In!" state, an "Expected message field" / "Message too long." validation error, and generic connection errors — but the frontend does not currently present these back to the sender. Wire the client's send flow so a failed send is caught and shown (and, where it makes sense, lets the user retry), covering at least the rate-limit case explicitly.

Keep it a thin end-to-end path: client send action → detect the server error/`error` message → surface it in the UI → test the rate-limited and generic-failure cases.

## Acceptance criteria

- [ ] A send that the server rejects (rate-limit) shows a clear, user-visible error in the client rather than failing silently.
- [ ] Other server-side send failures (not-logged-in, message-too-long, generic connection error) are surfaced too, not swallowed.
- [ ] The user can recover (e.g. retry or correct) after a surfaced error where applicable.
- [ ] Tests cover the new behaviour (mirror the repo's existing client test style, e.g. `demo.spec.ts` / the `test/client-server` harness), asserting the error surfaces for at least the rate-limit path.

## Blocked by

- None — can start immediately.

## Prompt

> Handle send-message errors in the missiv client. Today the server (`packages/server/src/Room.ts` for the real-time room path, and the action/response send path defined in `missiv-common`) returns error signals when a send is rejected — notably rate-limiting ("Your IP is being rate-limited…"), not-logged-in, message-too-long, and generic connection failures (delivered as `{error: …}` server messages / non-success responses). The client (`packages/client`) does not surface these to the user, so a rejected send currently looks like it succeeded.
>
> Goal: make the client detect a failed/rejected send and present it to the user (with retry/correction where it makes sense), with the rate-limit case handled explicitly. Look in the client's send/message-submit flow and wherever it consumes server `{error}` messages / send responses; add the user-facing surfacing there. Test at the client-server seam (see `test/client-server` and the client's existing spec style) — assert the error surfaces for the rate-limit path and at least one other failure. Domain vocabulary is in `CONTEXT.md`; the room protocol is in `docs/architecture.md` and `work/notes/findings/room-authorization-wire-format.md`.
>
> Follow the repo convention: add a changeset (`pnpm changeset`) with your change. RECORD any non-obvious in-scope decision durably and link it from the done record; if it meets the ADR bar (see `work/protocol/ADR-FORMAT.md`), write it as an ADR in `docs/adr/`.

---

### Claiming this task

```sh
dorfl claim frontend-send-message-error-handling --arbiter origin
git fetch origin && git switch -c work/frontend-send-message-error-handling origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/frontend-send-message-error-handling.md work/tasks/done/frontend-send-message-error-handling.md
```
