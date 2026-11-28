# Cloudflare's Inbox object counts a vanished client as online until its token expires

2026-11-28, spotted while analysing presence for DMs (`work/notes/ideas/dm-presence-typing-read-receipts.md`). Not verified by a test.

`platforms/cf-worker/src/stores/inbox.ts` `isOnline` answers true while any accepted socket's session claims have `exp > now`. Cloudflare closes no socket as idle (architecture.md "Live inbox channel"), and a client that drops off the network without a close frame (a phone going into a tunnel, a killed app) leaves its hibernated socket in `getWebSockets()` until the runtime notices, possibly until the alarm closes it at the token's `exp`, up to an hour. With `PUSH_SKIP_WHEN_ONLINE=true` that user then gets no push for new messages during that time. Node.js and Bun bound the same gap to 90 s (`watchIdle`).

A likely fix: also require a recent heartbeat, `ctx.getWebSocketAutoResponseTimestamp(ws)` (in `@cloudflare/workers-types`) within e.g. two heartbeat intervals, which reads the time of the last auto-answered `ping` without waking or billing anything. To confirm on the Workers runtime that a silently dropped socket stays in `getWebSockets()`.

2026-11-28, later: addressed in the same session. `isOnline` now also requires a ping auto-answered (or the acceptance) within 90 s (`isLiveSocket`, `LIVENESS_MS` in `platforms/cf-worker/src/stores/inbox.ts`), tested on the Workers runtime with a shortened window. Whether a silently dropped socket really stays in `getWebSockets()` in production was not confirmed; the fix holds either way.
