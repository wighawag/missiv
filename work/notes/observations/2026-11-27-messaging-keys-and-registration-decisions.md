---
title: Decisions made while building messaging-keys-and-registration
date: 2026-11-27
source: task messaging-keys-and-registration (ADR-0004 decision 1, ADR-0006)
---

# Decisions made while building messaging-keys-and-registration

In-scope choices the task did not settle, one per entry, for the reviewer and the human to ratify or reverse.

1. **The 0.6 migration is a new file, `0001_v0_6.sql`, not an in-place edit of `0001_initial.sql`** (as 0.4 did). A 0.5 database has `0001_initial` recorded as applied, so an in-place edit would leave it silently on the 0.5 schema; under a new name its `CREATE TABLE` fails at start, loudly. Alternative: edit in place (silent wrong schema), or a migration that drops 0.5's tables (destroys data on its own). Touches cf-worker (`wrangler d1 migrations apply` sees a new file) and the next tasks that change the schema. Site: the file's header comment.
2. **A key set, and each of its two keys, belongs to one (user, domain)**: `KeySets` has `UNIQUE (signingKey)` and `UNIQUE (encryptionKey)`, and `register` pre-checks both, so the same key set registered by the same account in another domain is a 409 too, as is another account's key set or a key set reusing another account's encryption key. Alternative: unique per domain only. Site: `RemoteSQLStorage.register`'s JSDoc and the schema comment.
3. **Messages store `senderKeyRef` only and the read joins `KeySets`**, still returning the sender's key set and proof inline (`senderKeySet`, `senderOwnershipSignature`, `senderAppOrigin`) so the interim wire keeps 0.5's per-copy shape and a reader needs no `getKeySet` call yet. Alternative: copy the key set into each row (0.5's way). Touches `one-ciphertext-message-format` / `sqlite-conversation-store-and-api`, which replace the format. Site: the schema comment.
4. **The interim copy format bumps its labels**: the copy signature's purpose line is `missiv message copy v2` (Ed25519 over its UTF-8 bytes, no EIP-191), the AEAD's associated data `missiv encrypted v2` (binding the two X25519 keys); the cipher stays xchacha20poly1305 under keccak256 of the X25519 agreement, and the content hash stays keccak256, as the task says to keep today's cipher until the next format task. Site: `packages/common/src/message-signature.ts` and `packages/client/src/lib/messages.ts` headers.
5. **Wire names follow delegated-identity**: `register` takes `keySet` and `ownershipSignature` (was `signature`), `DomainUser` has `keySet`, `keyRef`, `ownershipSignature` (was `publicKey`, `signature`), `getKeySet` answers `{keySet: RegisteredKeySet | undefined}`. Kept for the interim: `toPublicKey` / `recipientPublicKey` (now the X25519 encryption key) and `APIOptions.privateKey` (now the Ed25519 signing private key), since the next format task replaces the message fields. Site: `packages/common/src/index.ts` JSDoc.
6. **`@missiv/client`'s account is `@etherplay/connect`'s signed-in account as is**: `{address, keySet, savedPublicKeyPublicationSignature?}` (connect's field names, so `OriginAccount` is assignable), `register(ownershipSignature?)` defaults to the saved signature, `OtherUser.publicKey` became `OtherUser.keySet`. Alternative: missiv's own names (`ownershipSignature`) and a mapping in every app. Site: `MissivAccount`'s JSDoc.
7. **New refusal: a registration whose request is not signed by the key set's own signing key is 403 `forbidden`** (an unsigned one stays 401). The other refusals keep 0.5's codes: a proof not recovering the account 403, a malformed proof 400, a key set of another (user, domain) 409, a replay 409. Site: the `register` route.
8. **`@missiv/common` re-exports nothing of delegated-identity but the `KeySet` / `PublicKeySet` types**; the server, the client and the tests import its helpers directly. Site: `packages/common/src/index.ts`.
9. **`verifyKeySet` (and so `verifyDomainUser`) also checks `keyRef === keySetRef(keySet)`**, so a server cannot file a proven key set under another key set's reference. Site: `verifyKeySet`'s JSDoc.
10. **The demo app's connection names Ethereum mainnet with a public RPC** (`ethereum-rpc.publicnode.com`), because `@etherplay/connect` 0.19's `createConnection` requires a `chainInfo`; the demo never transacts. Demo only. Site: `packages/client/src/app/flow/connection.ts`.

## Noticed, not changed

- Ed25519 signatures are deterministic, so two devices sending the byte-identical registration in the same millisecond produce the same `SIGNATURE` header, and the second is refused as a replay (409) although its state is already the right one. Real devices sign at different times; the test waits 2 ms. A fix, if wanted, is to answer a replay of an already-current key set as success.
- The load harness's `0.5` adapter now runs on Ed25519/X25519 keys, so a run today is not comparable with `load-baseline-0-5.md` (secp256k1); the README says so.
