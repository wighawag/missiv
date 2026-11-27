---
'@missiv/common': minor
'@missiv/server': minor
'@missiv/client': minor
'missiv': minor
'@missiv/bun': minor
---

Direct messaging on the 0.6 API and store ports (ADR-0005, ADR-0006). Breaking: 0.5's messaging routes, actions and the per-copy format are removed, and `0002_v0_6_conversations` replaces the message tables.

- `@missiv/server`: the store ports `KeyDirectory`, `ConversationStore` and `Inbox` (`Stores`, `services.getStores`), and one SQL implementation over `remote-sql` (`createSQLStores`) for libSQL, bun:sqlite and D1: one row per message under a per-conversation seq, one inbox row per member with `lastSeq` / `lastReadSeq`. `POST /api/messages/send` stores a message authorized by the session token and its own Ed25519 signature against the sender's current key set (no request signature, no replay set), its messageID within 10 minutes of the server's clock (else `stale`, with the server's time); a retry answers the stored seq, another signature under the same messageID is `conflict`. A send is one transaction of five statements whatever the history. `/api/private/listMessages` (`after` / `before` by seq), `listConversations` (by status, from the inbox index), `accept`, `reject` (blocks the other member in the domain; their messages are acknowledged and stored hidden from you), `unblock`, `markRead {seq}`. `RemoteSQLStorage` and the `Storage` type are gone.
- `@missiv/common`: the 0.6 actions and responses (`ActionSendMessage` with a `MessageToSend`, `ActionListMessages`, `ActionListConversations`, `ActionAccept`, `ActionReject`, `ActionMarkRead`), `Conversation` with `status`, `lastSeq`, `lastReadSeq`, `lastMessageAt`, `isUnread`, `membersOfConversationID`, `MESSAGE_ID_WINDOW_MS`, the `stale` error code, `ulidTime`, `ulidAt`. Removed: the copy signature (`signMessageCopy`, `verifyMessageCopy`, `messageCopyMessage`) and 0.5's conversation actions.
- `@missiv/client`: the `API`'s `sendMessage` (on the session), `listMessages`, `listConversations`, `accept`, `reject`, `unblock`, `markRead`; the conversation store fetches only what is after the last seq it has and sends `pairwise-v1` messages, composing a `stale` one again under the server's time; the list counts unread from `lastReadSeq`. Removed: `encryptedCopies`, `clearCopies`, `openMessageCopy`.
- `@missiv/bun`: declares Bun 1.3.13 or later; `createBunServer`; its tests (the store contract on bun:sqlite, the platform's boot) run under `bun test`.
