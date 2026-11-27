---
'@missiv/common': minor
'@missiv/server': minor
'@missiv/client': minor
'missiv': minor
'@missiv/bun': minor
---

The live inbox channel (ADR-0006 "Live channel"): one WebSocket per signed-in client, and no more polling.

- `@missiv/server`: `GET /api/inbox/ws` where the platform holds the sockets (`ServerOptions.liveInbox`, `createInProcessLiveInbox()`), the session token offered at the upgrade as `Sec-WebSocket-Protocol: missiv-inbox, <token>` and refused 401 before any socket otherwise. Every new message is pushed to both members' open sockets (the sender's other devices included, never to a member who blocked the sender) with each member's inbox row; `accept`, `reject` and `markRead` push the changed row to the user's own sockets; a `sync` is answered with what the client missed, then `ready`; at the token's expiry the socket is closed with 4001 `session-expired`. `PUSH_SKIP_WHEN_ONLINE=true` sends no Web Push to a recipient with the channel open (off by default; the push itself is unchanged). New port method `Inbox.getConversation`, new `LiveInbox` port.
- `missiv` (Node.js) and `@missiv/bun`: serve the live inbox channel.
- `@missiv/common`: the channel's wire (`INBOX_WS_PATH`, `INBOX_WS_PROTOCOL`, `INBOX_CLOSE_SESSION_EXPIRED`, `InboxSyncSchema`, `InboxServerFrame`, `inboxConversationKey`).
- `@missiv/client`: `openConversationList` and `openOneConversation` run on one shared socket (`openInboxChannel`) and no longer poll; breaking: their `pollingInterval` is removed (`retryDelayMs` and `createWebSocket` are new). `API.getSession`. On cf-worker, which has no live channel yet, the stores update only when opened again.
