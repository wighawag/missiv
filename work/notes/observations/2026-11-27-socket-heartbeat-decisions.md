---
title: Decisions made while building socket-heartbeat
date: 2026-11-27
source: task socket-heartbeat (ADR-0006 "Live channel", note switchable-inbox-transport-and-socket-heartbeat)
---

# Decisions made while building socket-heartbeat

In-scope choices the task left open, one per entry, for the reviewer and the human to ratify or reverse. The wire ones (1 to 3) are what clients are built against; their JSDoc is `packages/common/src/heartbeat.ts`.

1. **`ping` and `pong` are bare text frames, not JSON** (`HEARTBEAT_PING`, `HEARTBEAT_PONG`): Cloudflare's `setWebSocketAutoResponse` matches a frame's exact text, and the same strings serve Node.js and Bun. Alternative: `{type: 'ping'}` JSON frames (consistent with the inbox's `sync`, but then the auto-response must match one exact serialization, and a room's protocol has no `type` field). Touches `switchable-inbox-transport` (its polling transport has no socket, so no heartbeat). Site: `packages/common/src/heartbeat.ts`.
2. **One close code, 4002 `heartbeat-timeout`, for "the other side went silent"**, used by the client when it gives a socket up and by Node.js/Bun when they close an idle one (4001 is the inbox's `session-expired`). The client handles it like any lost socket: reconnect with backoff, then sync. Alternatives: 1000/1001 (a browser may only send 1000 or 3000-4999, and 1000 reads as a clean close), or two codes, one per side. Site: `heartbeat.ts`, `packages/client/src/lib/inbox/index.ts`, `packages/client/src/lib/room/index.ts`.
3. **Any frame counts as the answer to a ping, both ways**: the client clears its timeout on any frame (a `ready`, a pushed message, a room's challenge), and the server restarts its idle time on any frame (a `sync` too). The client still pings every interval while traffic flows (simpler; on Cloudflare a ping costs nothing). Site: `packages/client/src/lib/utils/heartbeat.ts`, `packages/server/src/heartbeat.ts`.
4. **The given-up socket is treated as lost at once**, without waiting for its `close` event, which on a dead network may come only after the closing handshake times out; its later close is ignored. Site: `openInboxChannel`'s `lost`, `openRoom`'s heartbeat `onTimeout`; `InMemoryRoom` likewise ends the session of a socket it closes as idle at once.
5. **The server's idle limit is fixed at three DEFAULT intervals (90 s), not configurable**, and does not follow a client's configured interval: a client configured with `heartbeatIntervalMs` above 90 s is closed as idle by Node.js and Bun. Alternative: a `ServerOptions` field or env var (no caller needs it yet). Site: `packages/server/src/heartbeat.ts` (`HEARTBEAT_IDLE_MS`).
6. **Cloudflare closes no socket as idle**: the task asks it only of Node.js and Bun, and a hibernated socket costs nothing. If dead sockets ever accumulate there, the Inbox object's alarm could close those whose `getWebSocketAutoResponseTimestamp` is old. Site: `platforms/cf-worker/src/stores/inbox.ts` header.
7. **The heartbeat options are also on `openConversationList` and `openOneConversation`** (`heartbeatIntervalMs`, `heartbeatTimeoutMs`), passed to the shared channel as `retryDelayMs` is; as for that option, the store that opens the account's channel first sets them. Site: the two stores' params.
8. **The in-process inbox socket's events were extracted as `inboxSocketEvents`** (`packages/server/src/api/inbox/index.ts`, not exported from the package) so the heartbeat can be tested on a fake clock without a platform. Ping is answered at once, outside the sync queue.

Noticed, not fixed: the Cloudflare test opens its room socket on the Room object's own `fetch`, as a room upgrade through the Worker still answers 500 (observation `cf-worker-room-upgrade-500-on-wrangler-dev`).
