---
'missiv-common': patch
'missiv-server': patch
---

The ownership proof (a wallet's signature authorizing a delegate key for an origin) and the request signature (the delegate key's signature over a body) now live in the new package missiv-identity (0.1.0, its first release), so other services check the same proofs: missiv-common re-exports `originPublicKeyPublicationMessage` and `fromDomainToOrigin` from it, and missiv-server recovers both through it, unchanged in behaviour.
