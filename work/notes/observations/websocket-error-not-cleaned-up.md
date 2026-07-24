---
title: WebSocket error events never clean up the session (ghost participants)
slug: websocket-error-not-cleaned-up
date: 2026-07-24
---

# A socket `error` (not `close`) leaves a ghost session in the Room

`Room.ts` has a `webSocketClose` handler that calls `closeOrErrorHandler` (marks the session quit, removes it from `this.sessions`, broadcasts `{quit}`). But the `webSocketError` handler is commented out:

```ts
// async webSocketError(ws: WebSocket, error: any) {
// 	this.closeOrErrorHandler(ws);
// }
```

Separately, the platform adapters only wire the `message`/`close`/`open` events, NOT an `error` event, to the Room:

- `platforms/cf-worker/src/worker.ts` adds listeners for `message` and `close` only.
- `platforms/bun/src/cli.ts` calls `webSocketClose` on close only.

So if a connection errors without a clean `close`, the session is never removed from `this.sessions` and no `{quit}` is broadcast; peers keep seeing the participant in their roster until a later broadcast send to that dead socket throws and prunes it via the `broadcast()` quitter path. Minor resource/roster leak, not a correctness or security issue.

Fixing this is NOT a one-line uncomment: the handler must be re-enabled AND each platform must dispatch its runtime `error` event to it (cf-worker `server.addEventListener('error', ...)`, bun's error callback). That runtime wiring is why this is captured rather than fixed inline.

## Suggested direction (not yet decided)

Re-enable `webSocketError` in `Room.ts` and wire the `error` event in both platform adapters so error'd sockets get the same `closeOrErrorHandler` cleanup as closed ones.
