---
'missiv-common': minor
'missiv-server': minor
'missiv-client': minor
---

The client trusts no key it has not verified (S3-12). Each copy of a message now carries its own `signature`, the sender's delegate key over a `missiv message v1` EIP-191 message naming its domain, namespace, conversation, type, sender, recipient, key and content hash (`signMessageCopy`, `recoverMessageCopySigner` in missiv-common); the top-level `signature` of `sendMessage` is gone. The server stores each copy's signature and the sender's ownership proof of its key (`senderOwnershipSignature`, `senderAppOrigin`) with it, and checks neither: the reader does. missiv-client checks every key against its wallet's ownership proof (`verifyDomainUser`, `verifyOwnership`), refuses to encrypt to a key that fails, never sends in clear unless asked (`sendIntroduction`), binds the scope and both keys as the ciphertext's associated data, and opens each copy on its own (`openMessage`), into its text or an `unverified` or `undecryptable` error, so one bad copy no longer stops a thread. The registration store is `Registered` only when the server's record is this signer's key, proven by this wallet; otherwise it is `Unregistered` with `otherKey`.
