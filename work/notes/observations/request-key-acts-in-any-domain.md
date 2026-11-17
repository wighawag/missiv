---
title: A delegate key registered for one domain authenticates actions in every domain
slug: request-key-acts-in-any-domain
date: 2026-11-17
---

# The domain a wallet consented to is not checked when the key is used

Seen in the S3 review of origin/main 79fe3ab, and reproduced.

Registration binds a delegate key to `(wallet, domain)`: the wallet signs `originPublicKeyPublicationMessage(fromDomainToOrigin(domain), publicKey)` (`packages/server/src/api/user/index.ts:38-49`), and the row is `DomainUsers(user, domain, ..., publicKey UNIQUE)` (`packages/server/src/schema/sql/01_users.sql:9-22`). But the request middleware resolves the caller only by the key (`packages/server/src/setup.ts:63-75`: `getDomainUserByPublicKey(publicKey)` then `account = domainUser.user`), and the check that the action's `domain` is the key's domain is commented out as a TODO (`:65-71`). Every route then trusts `action.domain` from the body.

So a key the wallet authorised for `evil.example` can, as that wallet, call `getConversations`, `getMessages`, `sendMessage`, `acceptConversation`, `rejectConversation`, `markAsRead` and `editUser` with `domain: "good.example"`. The DM contents of `good.example` stay encrypted to that domain's key, but its clear introductory messages, its conversation list and metadata, and the power to send, accept and reject as the user there do not. The "Origin:" line the wallet signed carries no weight at the time of use.

## Reproduction (port-free, 2026-11-17)

Through `test/client-server`'s harness: USER_A and USER_B registered on `test.com` (real transport signatures), USER_A sent a message with `domain: "other.com"` and USER_B read it back from `other.com`: `[ [ 'other.com', 'cross' ] ]`. Neither had registered on `other.com`.

## A related cross-domain leak

`Users(name, description)` is global across domains (`01_users.sql:1-7`), and both `register` (`packages/server/src/storage/RemoteSQLStorage.ts:116-121`) and `editUser` (`:148-151`) overwrite it from whichever domain's key calls: one site the user registered on rewrites the name every other site shows.

## Suggested direction (not yet decided)

Load the domain user by `(publicKey)` and refuse any action whose `domain` differs from it (or drop `domain` from the body and take it from the key); make the global profile either per-domain only or editable only through a wallet signature.
