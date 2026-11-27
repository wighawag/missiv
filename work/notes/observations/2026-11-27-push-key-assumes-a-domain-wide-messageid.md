---
title: pushKey assumes a messageID unique in the domain, which a client-chosen messageID no longer is
date: 2026-11-27
source: noticed while building sqlite-conversation-store-and-api
---

`pushKey` (`packages/server/src/push.ts`) keys a push's idempotency by `missiv:<domain>:<messageID>:<recipient>`. Since 0.6 the messageID is the sender's ULID, unique only within `(domain, namespace, conversationID)`, so a sender reusing one of its messageIDs in another namespace to the same recipient gets the second push dropped by push-notification-server as a repeat (a sender can only silence its own pushes, but a buggy client would too). Not changed: the key is part of the push contract shared with push-notification-server; adding the namespace and conversation is a contract change for its own task.
