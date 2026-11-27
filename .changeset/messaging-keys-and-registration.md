---
'@missiv/common': minor
'@missiv/server': minor
'@missiv/client': minor
'missiv': minor
'@missiv/bun': minor
---

missiv on delegated-identity 0.2's key sets (ADR-0004 decision 1): an account registers, per domain, a key set (an Ed25519 signing key and an X25519 encryption key, derived from `@etherplay/connect`'s origin key, so every device of the account has the same) with the wallet's ownership signature of it. Breaking, and the database starts empty (the 0.6 schema, `0001_v0_6`; a 0.5 database fails to migrate).

- `register` takes `keySet` and `ownershipSignature` (was `signature`, over a secp256k1 key) and must be signed by the key set's signing key; a key set or key registered for another account or domain is refused (409), a replayed registration too.
- `DomainUser` carries `keySet`, `keyRef` and `ownershipSignature` (was `publicKey` and `signature`); `getKeySet {domain, keyRef}` returns any registered key set, current or replaced.
- Every request, the room login included, is signed with delegated-identity's Ed25519 envelope by the signing key; `@missiv/common` no longer re-exports delegated-identity's helpers (import them from `delegated-identity`).
- Messages keep 0.5's per-copy format: each copy signed with the sender's Ed25519 key (`signMessageCopy`, `verifyMessageCopy`, replacing `recoverMessageCopySigner`) and encrypted under the X25519 agreement of the two key sets. A message names its sender's `senderKeyRef` and carries `senderKeySet` (was `senderPublicKey`).
- `@missiv/client`: the account is `{address, keySet, savedPublicKeyPublicationSignature?}` (`@etherplay/connect`'s signed-in account), `register(ownershipSignature?)` defaults to the saved signature, `otherUser.keySet` replaces `otherUser.publicKey`, `verifyKeySet` checks a key set against its wallet.
