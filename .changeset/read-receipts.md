---
'@missiv/common': minor
'@missiv/server': minor
'@missiv/client': minor
---

Read receipts for direct messages: each inbox row carries `otherReadSeq`, how far the other member read the conversation, moved by their `markRead` while both share read receipts (shared by default, an opt-out per account and domain, reciprocal). ADR-0006 "Amendment: read receipts".

- `@missiv/common`: `Conversation.otherReadSeq`; `ActionGetSettings` / `ActionSetSettings` and `InboxSettings` (`readReceipts`).
- `@missiv/server`: `markRead` also raises the other member's `otherReadSeq` (at most their `lastSeq`, with their next inbox version) and pushes their row; `POST /api/private/getSettings` and `/setSettings`; the `Inbox` port gains `getSettings` and `setSettings`. Migration `0004_read_receipts` (the `otherReadSeq` column, the `InboxSettings` table): run it on Node.js and Bun at start as usual, and apply it to the cf-worker's D1 database with `wrangler d1 migrations apply`.
- `@missiv/client`: `openOneConversation`'s `Fetched` state has `otherReadSeq`, and with `markAsAcceptedAndRead` it marks read only while the thread is visible (`visibility`, by default the page's visibility, `documentVisibility`); `API.getSettings` and `API.setSettings`.
- cf-worker (a deployment): the Inbox Durable Object keeps the user's settings and sends each read receipt to the other member's Inbox object, retried by alarm until acknowledged.
