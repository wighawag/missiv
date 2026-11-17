---
title: Registering a second device's key answers 201 but keeps the first key, locking the new device out
slug: re-registering-a-new-key-keeps-the-old-one
date: 2026-11-17
---

# One delegate key per wallet per domain, forever, and the API does not say so

Seen in the S3 review of origin/main 79fe3ab, and reproduced.

`RemoteSQLStorage.register` upserts `DomainUsers` with `ON CONFLICT(user,domain) DO UPDATE SET domainUsername, domainDescription, added, lastPresence` and deliberately not `publicKey` (`packages/server/src/storage/RemoteSQLStorage.ts:122-130`, "currently not possible to update publicKey"). The route still answers `201 {"ok":true,"message":"Registered"}` (`packages/server/src/api/user/index.ts:52-59`).

So a wallet that registers from a second browser (a new local key, as jolly-roger's with/local-signer makes one per browser, and as `@etherplay/connect` derives one per origin and account index) gets a success, and every later request signed by the new key is refused with `no account authenticated` (`api/private/index.ts:26-28`). Reproduced (port-free, 2026-11-17): two registrations of one wallet with keys k1 then k2 both answered `{"ok":true,"message":"Registered"}`; the stored key was k1, and `getConversations` signed by k2 was refused.

Messages already stored for the old key stay readable only by the old key (they are encrypted to it), which is the real reason a key cannot simply be replaced; but silently keeping it is the worst of both.

## Suggested direction (not yet decided)

Either several keys per (wallet, domain) (a device table; a sender encrypts to each of the recipient's live keys, as ADR-0002 already anticipates for groups), or one key replaced on a newer publication signature with the old ciphertexts declared lost; in both cases a registration that does not take effect must not answer 201.
