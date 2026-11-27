---
'@missiv/common': minor
'@missiv/server': minor
'@missiv/client': minor
'missiv': minor
'@missiv/bun': minor
---

Sessions (ADR-0004 decision 5, ADR-0006): `POST /api/session {domain}`, a request signed by the signing key of the caller's current key set in the domain, answers `{token, expiresAt, keyRef}`, an HMAC-SHA256 token (`SESSION_SECRET`) valid an hour. Every route but `register` and `sendMessage` now takes `Authorization: Bearer <token>` instead of a request signature (a signed request there is refused 401), and checks it without reading the database. Breaking.

- The server needs `SESSION_SECRET`: every route that authenticates its caller is refused (403 `forbidden`) while it is unset. `SESSION_SECRET_PREVIOUS` keeps tokens of a rotated-out secret valid until they expire.
- A replayed session request is refused (409), as a replayed registration or send.
- `@missiv/client`'s `API` opens a session per domain and signing key on its own, renews it five minutes before it expires and opens a new one once when a token is refused (`unauthenticated`); `openSession` opens one explicitly. Calls keep their signature (`{privateKey}`).
- CORS allows the `Authorization` header.
