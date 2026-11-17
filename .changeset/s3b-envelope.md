---
'missiv-common': minor
'missiv-server': minor
'missiv-client': minor
---

Every signature is delegated-identity's request envelope. A request's `SIGNATURE` header is `signRequest`'s (`<timestamp>:<signature>:<recovery>`, over the server's origin, the method and path, the timestamp and the body's hash, EIP-191-hashed) and the server refuses one outside 60 s or for another server, route or body (`SERVER_ORIGIN` sets the origin the server expects behind a rewriting proxy). A signed `sendMessage` or `register` is refused if replayed within its window. The room login signs the same envelope around its challenge (`GET`, the room's path). Registration names the app's origin (`appOrigin`, whose host is the domain), which the ownership signature is checked against and which the domain user keeps, so a client can verify the proof itself; missiv-client's registration store takes it as `appOrigin` (the page's origin by default). missiv-server's own raw-body recovery (`utils/signature.ts`) is gone.
