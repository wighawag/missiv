---
title: messageID generation can collide and fail the send batch
slug: messageid-collision-risk
date: 2026-07-24
---

# `messageID` = time*1000 + random(1000) can collide (primary-key failure)

In `RemoteSQLStorage.sendMessage` (`packages/server/src/storage/RemoteSQLStorage.ts`):

```ts
// TODO this is not full proof
const messageID = Date.now() * 1000 + Math.floor(Math.random() * 1000);
```

`messageID` is part of the Messages primary key `(domain, namespace, conversationID, messageID, recipient)`. Two `sendMessage` calls landing in the same millisecond have a ~1/1000 chance (per pair) of drawing the same random suffix; on collision the second `INSERT` violates the PK and the whole `db.batch` fails, so the send errors out. The author already flagged it with the `// TODO this is not full proof` comment.

Probability is low but the consequence is a hard failure, and it scales with send volume within a domain/conversation.

## Suggested direction (not yet decided)

Use a monotonic source instead of time+random: a per-object counter, a ULID/uuid, or `max(Date.now(), lastTimestamp+1)` style monotonic id (the Room path already uses that trick for message timestamps). Capture-only.
