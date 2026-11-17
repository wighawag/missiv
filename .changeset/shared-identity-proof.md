---
'missiv-common': patch
'missiv-server': patch
---

The ownership proof (a wallet's signature authorizing a delegate key for an app origin) now comes from delegated-identity (its own package and repo, github.com/wighawag/delegated-identity), shared with the other services that check it: missiv-common re-exports `originPublicKeyPublicationMessage` and `fromDomainToOrigin` from it (`fromDomainToOrigin` now keeps an `http://` origin as it is), and missiv-server's `/register` recovers the account through it, unchanged in behaviour. missiv's own raw-body request signature is unchanged; delegated-identity's request envelope replaces it in a later release.
