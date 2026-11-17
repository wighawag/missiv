---
title: The conversation list polls once and counts accepted as unaccepted; the room store leaks listeners and reuses a stale challenge
slug: client-stores-polling-and-room-bugs
date: 2026-11-17
---

# Bugs in missiv-client's stores, found by reading

Seen in the S3 review of origin/main 79fe3ab (from reading; the client's only test is `1 + 2`, `packages/client/src/demo.spec.ts`).

**`openConversationList`** (`packages/client/src/lib/conversationList/index.ts`):

- it never polls a second time: `fetchConversationsAgainAndAgain` reschedules only `if (timeout)` (`:64-69`), and `timeout` is undefined until it has been scheduled once, so the list is fetched once and never refreshed;
- the counters are inverted: `if (conversation.accepted) numUnaccepted++` (`:91-92`), and an unaccepted conversation is counted as unread instead (`:93-95`);
- on start it fetches only when already `Fetched` (`:52-57`), relying on a registration change to begin.

**`openRoom`** (`packages/client/src/lib/room/index.ts`):

- `onStop` removes the `open` listener but ADDS `close` and `message` again (`:346-355`), so every stop doubles the handlers on a closing socket and the close handler then writes into a store nobody holds;
- `savedSession` (the challenge) survives across sockets (`:76`, `:148`), and a resubscription logs in with the previous socket's challenge (`:116-121`), which the server refuses as `Invalid signature`;
- no reconnect (`:137-141`), and every `{error}` from the server is dropped (`:261-277`; the send side is the backlog task `frontend-send-message-error-handling.md`);
- room messages are sent with `signature: '0x'` (`:388`) and the server stores whatever signature it gets without checking it (`packages/server/src/Room.ts:395`), so a room message is attributable only by trusting the server;
- a pending message is matched to its echo by text equality (`:168`).

**All stores**: each re-implements the same start/stop and registration-change plumbing (`derivedWithStartStopNotifier`, a copy of Svelte's `derived` internals, `packages/client/src/lib/utils/store.ts`), with `running`/`fetching` flags that decide nothing; `registration`'s `fetchAgain` and `setError` are unused (`packages/client/src/lib/registration/index.ts:66-72,158-167`). The library keeps its logic in `.ts` stores on `svelte/store`, as the template tree's Svelte rules ask.

## Suggested direction (not yet decided)

One small polling/socket lifecycle helper the stores share, each store a pure reducer over events that a unit test can drive without a server, and the client-server harness extended to the stores themselves.
