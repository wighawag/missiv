---
'@missiv/common': minor
'@missiv/server': minor
'@missiv/client': minor
---

Room to grow the live inbox channel's wire, so later optional frames (typing, presence) cannot break a socket; and on Cloudflare a client that vanished no longer suppresses its pushes for up to an hour.

- `@missiv/common`: a server frame `{type: 'welcome', features}` (the optional client frames the server accepts; `INBOX_SERVER_FEATURES`, empty for now) and `readInboxClientFrame`, which reads a client frame as a `sync`, a frame of an unknown type (to ignore) or invalid.
- `@missiv/server`: every accepted inbox socket is sent `welcome` first, and a client frame that is a JSON object with a string `type` other than `sync` is ignored instead of closing the socket; anything else (not JSON, no `type`, a malformed sync) still closes it 1008. `inboxWelcomeFrame` is exported for platforms that hold their own sockets.
- `@missiv/client`: `InboxChannel.features`, what the current socket's welcome named, undefined while none is known (polling, before the welcome, or an older server). Older clients ignore the welcome, as they ignore any frame they do not know.
- cf-worker (a deployment): the Inbox Durable Object sends the welcome and ignores unknown frames the same way, and `isOnline` (used by `PUSH_SKIP_WHEN_ONLINE`) counts a socket only while it answered a ping, or was accepted, within the last 90 s (`getWebSocketAutoResponseTimestamp`, which wakes nothing). Before, any socket whose session had not expired counted, so a phone that dropped off the network without a close frame stopped its pushes until its token expired.
