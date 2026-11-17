---
status: accepted
---

# The client verifies every key and message; the server only relays

missiv's server is an untrusted relay for content and authorship: the client trusts no key it has not checked against the wallet's own ownership proof, and no message it has not checked against its sender's signature. This was chosen over the server as the key directory of record (where a compromised server hands out its own key and reads every direct message, and turns any message into clear text by denying a registration), because the proofs were already there to check: a wallet authorizes a delegate key for an app origin once (delegated-identity's publication message, byte-identical to `@etherplay/connect-core`'s), and that key signs everything else.

What is built (missiv 0.4, S3-6, S3-10 and S3-12 of jolly-roger's plan):

- **Requests**: every API request is signed by the caller's delegate key over delegated-identity's envelope (`delegated-identity request v1`, the server's origin, the route, a timestamp, the body's keccak256), refused 60 s off either way; `sendMessage` and `register` also refuse a signature already accepted in that window. The server derives the caller from the key, and a key acts only in the domain it is registered for. This is the server's own check: who may write.
- **Keys**: one key per wallet and domain, with its ownership proof (the wallet's signature and the app origin it names, whose host must be the domain). Registering a newer key replaces the old one. The client accepts a key only when the proof recovers the wallet's address for an origin of the domain (`verifyDomainUser`); it encrypts to no other, and its own registration is `Registered` only when the server's record is its own key, so proven.
- **Messages**: each copy is signed by the sender's delegate key over `missiv message v1` (domain, namespace, conversation, type, sender, recipient, the key it is encrypted to, the content's keccak256), and stored with the sender's ownership proof as it was when sent. The server checks neither; the reader checks both (`openMessage`): a copy moved to another recipient, conversation, namespace or domain, a changed content, or a sender key its wallet did not authorize, is shown as `unverified`. Encrypted content is XChaCha20-Poly1305 under keccak256 of the two keys' ECDH secret, with the scope and both keys as associated data; a copy that does not decrypt is shown as `undecryptable`, and the rest of the thread is shown as usual.
- **Clear text** is sent only when asked (`sendIntroduction`), never as a fallback for a recipient with no key.

**Known limits**, accepted for 0.4:

- One key per wallet and domain assumes the key is derived the same on every device: `@etherplay/connect-core`'s `deriveOriginAccount` derives it from a deterministic signature (the hosted account's, or an RFC 6979 wallet's). A wallet that does not sign deterministically (some smart-contract or passkey wallets) derives a key per device; then the newest registration wins and the other devices' messages become unreadable there. A key per device (a device table, each message encrypted once per device) is the way out if that bites.
- No forward secrecy: one shared key per pair of keys, for every message between them (random 24-byte nonces).
- The server can still withhold, delay or reorder copies, replay a stored copy as a duplicate, and see metadata (who talks to whom, when, how much); and it knows which domain users are registered.
- Rooms are unencrypted and relayed (ADR-0002), and a room message carries no signature: the server attributes it to the session that sent it, so a room message is only as authentic as the server.

## Considered options

- **The server as key directory** (the 0.x client): rejected above.
- **A per-message signature inside delegated-identity's request envelope**: rejected for a missiv message of its own, because a message is not a request (no server origin or route to name, and it outlives the 60 s window) and its own purpose line keeps the two kinds of signature apart for one key.
- **The sender's current key fetched at read time** instead of the proof stored with each copy: rejected, because a sender who replaced their key would make every older message unverifiable.
