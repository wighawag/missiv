---
title: The key publication message is also @etherplay/connect's, which pre-signs it for hosted accounts
slug: publication-message-shared-with-etherplay-connect
source: 'read from wighawag/etherplay-connect origin/HEAD on 2026-11-17: packages/etherplay-connect-core/src/index.ts (originPublicKeyPublicationMessage, deriveOriginAccount) and packages/etherplay-connect/README.md (getSignatureForPublicKeyPublication); jolly-roger origin/with/local-signer web/package.json pins @etherplay/connect ^0.17.0'
---

# missiv's publication message is a protocol shared with @etherplay/connect

`@etherplay/connect-core` defines `originPublicKeyPublicationMessage(orig, publicKey)` with a body byte-identical to `@missiv/common`'s (`packages/common/src/index.ts:214-216` here): `Origin: <orig>`, the warning, "This authorizes the following Public Key to represent your account", the key, and the line about encrypted messages.

What connect does with it:

- `deriveOriginAccount(origin, ...)` derives the ORIGIN account (a per-origin Ethereum key pair from the account's mnemonic) and, at sign-in, signs this message for that account's public key with the account key, returning it as `savedPublicKeyPublicationSignature`.
- `getSignatureForPublicKeyPublication()`: for a wallet it signs the message live; for the popup mechanisms (email, OAuth, mnemonic) it can ONLY return the saved signature ("There is currently no way to sign it after the fact for these mechanisms", its README).
- The same origin key is the session signer that also signs on-chain delegations (`delegationMessage`, from `@etherplay/delegation`), i.e. it is an Ethereum account used beyond missiv.
- `orig` is the app's window origin as connect sees it (scheme, host and port), not a bare domain.

## Consequences for missiv (and for any service verifying the same proof)

1. The message's text is frozen by connect's saved signatures: changing it in missiv alone (to SIWE, or to add a chain or an expiry) makes every hosted account unable to register, since those accounts cannot sign again. A change has to land in connect first, or be a second accepted message beside this one.
2. Two copies of a protocol string in two repos: the jolly-roger plan's S1-3 (one package for the ownership proof, extracted from @missiv/common) should make ONE of them import the other, or both import the package.
3. missiv reconstructs the origin from a domain (`fromDomainToOrigin`, `packages/common/src/index.ts:230-238`): `localhost[:port]` becomes `http://`, anything else `https://`. An app served over plain http on another host (jolly-roger's LAN dev stack, `http://<lan-ip>:<port>`) signs `Origin: http://...` through connect, and missiv verifies against `https://...`, so registration fails with "no matching address". A `domain` given as `http://...` becomes `https://http://...`. The verifier should receive the origin, not rebuild it.
4. Because the key signs things other than missiv requests, missiv's raw-keccak signatures with it need domain separation (`work/notes/observations/signed-requests-are-replayable-and-undomained.md`).
