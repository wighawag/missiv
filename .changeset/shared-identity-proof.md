---
'missiv-common': patch
'missiv-server': patch
---

The ownership proof (a wallet's signature authorizing a delegate key for an app origin) now lives in the new package missiv-identity (0.2.0; 0.1.0 was the extraction alone), shared with the other services that check it: missiv-common re-exports `originPublicKeyPublicationMessage` and `fromDomainToOrigin` from it (`fromDomainToOrigin` now keeps an `http://` origin as it is), and missiv-server's `/register` recovers the account through it, unchanged in behaviour. missiv's own raw-body request signature is unchanged; missiv-identity's request envelope replaces it in a later release.
