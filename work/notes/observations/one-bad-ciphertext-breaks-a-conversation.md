---
title: One undecryptable message makes a conversation's polling throw forever; polling also outlives its subscribers
slug: one-bad-ciphertext-breaks-a-conversation
date: 2026-11-17
---

# The conversation store has no per-message failure path

Seen in the S3 review of origin/main 79fe3ab (from reading).

- `fetchMessages` decrypts every `encrypted` message in one loop (`packages/client/src/lib/conversation/index.ts:172-194`). `chacha.decrypt` throws on a bad tag, and `base64.decode` on bad input; nothing catches, so the whole fetch rejects, `fetchMessagesgainAndAgain` (`:132-135`) rejects before rescheduling, and the conversation never loads again. Since anyone can write an `encrypted` row with arbitrary content into a conversation addressed to anyone (`work/notes/observations/send-message-trusts-client-conversation-id.md`), one message breaks a victim's thread for good.
- `markAsAcceptedAndRead` re-sends `acceptConversation` on every poll, every 2 s by default (`:196-209`).
- Polling starts on registration change regardless of subscribers (`onRegistrationChanged`, `:249-260`), and `onStop` stops it only when the step is `Fetched` (`:274-279`): a conversation closed while `Fetching` polls forever. `running` and `fetching` are written but never decide anything.
- Each poll fetches the whole history (`getMessages` has no cursor or limit: `packages/server/src/storage/RemoteSQLStorage.ts:206-231`).
- `timeout: NodeJS.Timeout` in a browser library (`:131`).

## Suggested direction (not yet decided)

Decrypt per message into a result (`{ok, content} | {error}`) shown as "could not decrypt"; one polling loop owned by start/stop; a `since` cursor on `getMessages`.
