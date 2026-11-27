---
title: openMessageCopy's cache key ignores the content
date: 2026-11-27
source: noticed while building one-ciphertext-message-format
---

`@missiv/client`'s interim `openMessageCopy` (was `openMessage`, `packages/client/src/lib/messages.ts`) caches its verdict by `id:recipient:signature:readerKey`, so a copy whose content (or sender, scope) changes under the same id and signature gets the earlier verdict without being checked again. Not fixed: the per-copy path goes away in `sqlite-conversation-store-and-api`; the new `openMessage` keys its cache on every signed field.
