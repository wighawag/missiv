---
'missiv-common': minor
'missiv-server': minor
'missiv-client': minor
---

Conversations the server keeps honest, reject as block, and key replacement.

- A send's members are its recipients, the sender's own copy included; its `conversationID` must be `conversationIDOf(members)` (exported by missiv-common: the pair's ID for two, keccak256 of the sorted addresses otherwise), or it is a 400. An encrypted copy for a recipient must name that recipient's registered key (else 409); a clear copy names no key (`toPublicKey` is optional there, and stored as null).
- Rejecting a conversation of two blocks its other member in the domain: nothing they send reaches you, in any conversation, until `/private/unblock`.
- `getMessages` and the conversation lists take `limit` (at most 100) and `before`, and answer a `cursor` when there are older items; messages come newest first.
- Registering a new key for the same wallet and domain replaces the old one (which stops authenticating; messages encrypted to it stay readable only by it); a key registered for another account or domain is a 409.
