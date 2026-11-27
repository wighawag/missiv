---
'@missiv/common': minor
'@missiv/client': minor
'@missiv/server': patch
---

The missiv message format (ADR-0004 decisions 2 and 3, ADR-0006 "The message"): one ciphertext per message, signed once. Not yet stored or sent by the server (that is the next release step); the per-copy format keeps working meanwhile.

- `@missiv/common`: the `Message` type and its zod schemas (`MessageToSendSchema`, `MessageSchema`), the signing payload (`messageSigningPayload`, `signMessage`, `verifyMessage`: Ed25519 over `missiv message` with the content's SHA-256), `pairwise-v1` (`pairwiseKeyID`, `encryptPairwise`, `decryptPairwise`: HKDF-SHA256 of the X25519 shared secret, AES-256-GCM), through WebCrypto when `crypto.subtle` exists and `@noble` otherwise, pinned by test vectors; `newULID`.
- `@missiv/client`: `composeMessage` (`pairwise-v1`), `composeIntroduction` (`clear`) and `openMessage`, which fetches the sender's key set by `senderKeyRef` through `getKeySet`. Breaking: the per-copy reader is renamed `openMessageCopy` (and `OpenedMessage` of a copy `OpenedMessageCopy`).
- `@missiv/server`: its ULIDs come from `@missiv/common`.
