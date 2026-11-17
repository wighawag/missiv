---
title: sendMessage stores into any conversationID and recipient set the client names
slug: send-message-trusts-client-conversation-id
date: 2026-11-17
---

# The server never checks that a conversation's ID, members or keys belong together

Seen in the S3 review of origin/main 79fe3ab, and reproduced.

`RemoteSQLStorage.sendMessage` (`packages/server/src/storage/RemoteSQLStorage.ts:250-336`) takes `conversationID`, the recipients (`messages[].to`) and each `toPublicKey` straight from the body (`packages/server/src/types.ts:161-194`). Nothing checks that:

- the conversationID is the one the members define (`getConversationID` exists in `missiv-common` (`packages/common/src/index.ts:204-212`) but the server never calls it, and the tests send `'1'`: `test/client-server/test/setup.ts:102,159`);
- the sender is a member of the conversation it writes into (the upsert only bumps `lastMessage`, `:256-261`, and `members` is fixed by whoever wrote first);
- `toPublicKey` is the recipient's registered key (stored as given, `:310-316`; the client sends `'0xff'` for clear messages, `packages/client/src/lib/conversation/index.ts:316,321`).

Consequences, reproduced through `test/client-server`'s harness (port-free, 2026-11-17):

1. **Injection into another pair's thread**: with A and B in `getConversationID(A, B)`, C sent into that ID addressed to B; B's `getMessages` returned `[['C','injected by C'], ['A','from A']]`. The sender field is right, so a careful client can notice, but the thread is no longer A and B's.
2. **Rejection does nothing against a sender**: B rejected conversation `c1` from A; A's next message under `c2` arrived in B's unaccepted list (`['c2']`). Rejection is per free-form ID (`:243-248`), so it blocks nobody.

## Suggested direction (not yet decided)

Derive the conversationID on the server from the sorted member set including the sender (the client's `getConversationID` for two, a hash of the sorted addresses for groups), refuse a body whose ID disagrees, and make "reject" a per-(recipient, sender) block rather than a per-ID flag. Check `toPublicKey` against `DomainUsers` for encrypted messages.
