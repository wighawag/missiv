---
title: The wallet, the origin key and the publication proof are one identity shared by missiv, push-notification-server and etherfold's triggers
slug: shared-identity-across-services
source: 'read on 2026-11-27: delegated-identity f92d373 (src/index.ts, README.md); push-notification-server abb96d4 (packages/server/src/api/index.ts, README.md); etherfold (packages/triggers/src/identity.ts, registration.ts); etherplay-connect e8dcfbf (packages/etherplay-connect-core/src/index.ts deriveOriginAccount, plans/signer-rotation-and-kill-switch.md); jolly-roger with/messaging 5221423c (web/src/lib/messaging/messaging.ts, web/src/lib/push/notifications.ts, web/notifier/serve.ts)'
---

# One identity, three services

- **The identity** is a triple: the wallet (the account), the ORIGIN key `@etherplay/connect-core`'s `deriveOriginAccount` derives per app origin (secp256k1, `originKey = keccak(sign(originKeyMessage(origin)))`, then a mnemonic, index 0), and the ownership proof: the account key's EIP-191 signature over `originPublicKeyPublicationMessage(origin, originPublicKey)`. connect pre-signs it at sign-in as `savedPublicKeyPublicationSignature` (hosted accounts can only ever return the saved one).
- **delegated-identity** owns the publication message (byte-identical to connect's, which imports it), the request envelope (`delegated-identity request v1`, secp256k1 delegate signature, 60 s window), `recoverRequestSigner` and `verifyRequest` (envelope + ownership proof → account).
- **push-notification-server** authenticates `/register` and `/unregister` with `verifyRequest`: the `SIGNATURE` header by the origin key plus `ownershipSignature` in the body. It never sees missiv's keys; missiv calls `/push` with the domain's bearer token.
- **etherfold's trigger service** (`@etherfold/triggers`, `delegatedIdentityVerifier`) authenticates registrations the same way.
- **jolly-roger `with/messaging`** hands missiv and the push client the same thing: connect's `signer` (origin key, with its private key in the app) and connect's `getSignatureForPublicKeyPublication`, so the wallet is asked at most once for messaging and notifications together.
- **The origin key is also an on-chain signer**: the account signs `delegationMessage({delegate: originAccount.address, contract, chainId, deadline})` so contracts accept the origin key acting for the account.
- **Not part of this identity** (checked 2026-11-27): fuzd (`packages/server/src/auth.ts`: EIP-191 over the raw JSON body, the account is the recovered Ethereum address, which is also its on-chain identity through `deriveForAddress`) and waxdb (SPEC.md: `owner` is the Ethereum address of whatever local key signs the labelled `waxdb` messages, writes and per-read tokens alike; no publication proof, no delegated-identity; not deployed yet). Neither imports delegated-identity, so a change there does not reach them. waxdb's roadmap lists "delegated writes" (a session key signing for an account, the proof in an unsigned header), which is where delegated-identity's derived-key layer would plug in.
- **The origin key cannot rotate today** (a pure function of account key and origin); connect's parked rotation plan would add versions of it.

## Consequences for missiv

1. Every service above verifies the same publication message, so changing the key it names changes all of them at once, from `delegated-identity`. Decided 2026-11-27 (ADR-0004): it is changed, as a breaking edit (no production app), to name an Ed25519 and an X25519 key; the order is delegated-identity, then connect and its popup, then the services, then the apps.
2. A hosted (popup) account signs only at sign-in, so a new publication message means every connected account signs in again; connect has to treat a stored account as signed out unless its saved publication signature verifies for the new message.
3. The origin key stays an on-chain signer whatever the publication names, so connect keeps deriving it.
4. Whatever compromises the origin key compromises keys derived from it; a future versioned origin key (connect's rotation plan) yields new derived keys and a new publication.
