---
title: The Cloudflare room accepts hibernatable sockets and also adds event listeners that pass the client end
slug: cloudflare-room-wires-two-websocket-dispatch-paths
date: 2026-11-17
---

# Two ways of receiving the same socket's events, one of them with the wrong socket

Seen in the S3 review of origin/main 79fe3ab (from reading; workerd was not run, the review had no port budget for it).

`platforms/cf-worker/src/worker.ts:140` calls `this.state.acceptWebSocket(server)`, the Hibernation API, whose events the runtime delivers to the Durable Object's `webSocketMessage` and `webSocketClose` methods (which `Room` defines). Then `:144-163` also adds `message` and `close` listeners on `server` that call `this.webSocketMessage(client, ...)` and `this.webSocketClose(client, ...)` with the CLIENT end, which is not a key of `this.sessions` (the session is stored under `server`, `webSocketOpen(server, ...)` at `:168`). Cloudflare's documented pattern for hibernation is the handler methods only (developers.cloudflare.com/durable-objects/best-practices/websockets, retrieved 2026-11-17). Whichever path fires, the listener path would answer "WebSocket message received for unknown client" and close (`packages/server/src/Room.ts:224-229`).

After hibernation, `this.identifier` and `this.lastTimestamp` are not restored (`Room.ts:35-41`, only per-socket attachments are), and the rate limiter's `nextAllowedTime` lives in memory (`packages/server/src/RateLimiter.ts:15-22`).

`handleErrors` returns `err.stack` to the client (`worker.ts:77,81,196,200`), and `Room.webSocketMessage` sends `cause` and `stack` on any exception (`Room.ts:404-408`), in production too.

## Suggested direction (not yet decided)

Keep only the hibernation handlers; persist the room identifier in storage; stop sending stacks outside an explicit dev flag. Verify in `wrangler dev` (or miniflare) once, since this was read, not run.
