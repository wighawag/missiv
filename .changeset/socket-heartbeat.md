---
'@missiv/common': minor
'@missiv/server': minor
'@missiv/client': minor
---

A heartbeat on every missiv socket (the live inbox channel and the rooms), so an idle socket that a proxy or a mobile network dropped silently is noticed and replaced.

- `@missiv/common`: the heartbeat's wire (`HEARTBEAT_PING`, `HEARTBEAT_PONG`, `HEARTBEAT_INTERVAL_MS` 30 s, `HEARTBEAT_TIMEOUT_MS` 10 s, `HEARTBEAT_IDLE_INTERVALS` 3, `HEARTBEAT_CLOSE_TIMEOUT` 4002 with `HEARTBEAT_TIMEOUT_REASON` `heartbeat-timeout`).
- `@missiv/client`: `openInboxChannel` and `openRoom` send the text frame `ping` every interval and, when no frame arrives within the timeout, close the socket `heartbeat-timeout` and reconnect with their backoff (then sync, or log in again). New options `heartbeatIntervalMs` and `heartbeatTimeoutMs`, also on `openConversationList` and `openOneConversation`.
- `@missiv/server`: the live inbox's sockets and the rooms answer `ping` with `pong` (ahead of a sync and of a room's rate limiter), and on Node.js and Bun a socket that sent nothing for three intervals (90 s) is closed `heartbeat-timeout`. A client from before this release sends no ping, so against an upgraded Node.js or Bun server its idle socket is closed every 90 s and reconnects: upgrade `@missiv/client` together with the server.
- cf-worker (a deployment): the Inbox and Room Durable Objects answer `ping` by WebSocket auto-response, which neither wakes the object nor bills its duration.
