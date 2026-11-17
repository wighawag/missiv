---
title: The client takes recipients' public keys from the server unverified, and falls back to clear text when told the recipient is unregistered
slug: client-trusts-the-server-for-recipient-keys
date: 2026-11-17
---

# "Untrusted relay" does not hold for key distribution

Seen in the S3 review of origin/main 79fe3ab (from reading).

`CONTEXT.md` says the server is an untrusted relay, needed only for delivery. But the encryption key comes from that relay, unchecked:

- `openOneConversation` fetches the other user with `getCompleteUser` and takes `completeUser.publicKey` as is (`packages/client/src/lib/conversation/index.ts:144-158`), then derives the shared key from it (`:336`). The server returns the wallet's publication signature beside the key (`DomainUsers.signature`, `packages/server/src/schema/sql/01_users.sql:15`), so the client COULD check that `recoverMessageAddress(originPublicKeyPublicationMessage(origin, publicKey), signature)` is the other user's address; it never does. A malicious or compromised server can hand out its own key and read every DM.
- **Downgrade**: when the server answers "no such user", `sendMessage` sends the text IN CLEAR, silently, to both copies (`:307-334`). The server can therefore turn any DM into clear text by denying the recipient's registration. Nothing in the store tells the UI that a message is going out unencrypted.
- On read, `senderPublicKey` and `recipientPublicKey` come from the stored row (`:178-181`) and are equally unverified; the per-message signature that would bind them is all zeros (`:302`), already captured in `work/tasks/backlog/per-message-signature-over-ciphertext.md`.
- The ciphertext has no associated data: `xchacha20poly1305(sharedKey, nonce)` over the text only (`:339-342`), so a stored ciphertext can be moved between this pair's conversations or namespaces undetected. The shared key is `keccak_256(ECDH)` (`:74-75`), the same for every message between two keys (acceptable with random 24-byte nonces; no forward secrecy).
- `console.log(action)` prints the clear-text action (`:331`).

## Suggested direction (not yet decided)

Verify every public key against its publication signature on the client (the address, the origin and the key are all known) before encrypting to it or trusting a sender's key; make "send in clear" an explicit choice the store exposes, never a fallback; bind sender, recipient and conversation as AEAD associated data.
