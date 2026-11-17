---
'missiv-server': minor
'missiv-server-cf-worker': minor
---

A push on a new direct message, through push-notification-server (@push-notification/server). With `PUSH_SERVER_URL` set and a token for the domain in `PUSH_TOKENS` (`<domain>=<token>,...`, the tokens it issued, held as secrets), each registered recipient other than the sender, and other than one who blocked the sender, gets one `POST /api/push` with `Authorization: Bearer <token>` and `Idempotency-Key: missiv:<domain>:<messageID>:<recipient>`. The message is a Declarative Web Push naming the sender and the conversation, never the content. A failed send (502) or an unreachable server is retried with the same key, a busy key (409) later, each a bounded number of times; a refused token (401, 403) is logged and not retried; a domain without a token sends nothing and is logged once. The pushes run after the response (`ServerOptions.waitUntil`, cf-worker's `executionCtx.waitUntil`). `ServerOptions.getPushNotifier` replaces the notifier (a recording one in tests).
