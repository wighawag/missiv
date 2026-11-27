---
title: /api/admin/db-reset on cf-worker clears D1 only, not the Durable Objects
slug: 2026-11-27-cf-admin-db-reset-leaves-durable-objects
date: 2026-11-27
---

Seen while building `cloudflare-durable-object-stores`: `packages/server/src/api/admin/index.ts`'s `db-reset` runs `resetDatabase(getDB(env))`, which on cf-worker now empties only the key directory (D1). Conversations and inboxes live in Durable Objects, which it does not reach (nor can it list them), so after a reset their messages and rows survive while the users they name are gone.
