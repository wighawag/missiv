# @missiv/bun

## 0.5.1

### Patch Changes

- Updated dependencies [b7cb5fb]
  - @missiv/common@0.7.0
  - @missiv/server@0.7.0

## 0.5.0

### Minor Changes

- 5ea6e6c: Rate limits on direct messaging (spec `scalable-direct-messaging`, story 27): a token bucket per account (and domain) on `messages/send`, and one per client IP on `/api/session` and `register` together, refused `rate_limited` (429) with `details.retryAfterMs` and a `Retry-After` header.

  - `@missiv/server`: `createTokenBuckets`, `createInProcessTokenBuckets`, `tokenBucketConfigsFromEnv`, `DEFAULT_TOKEN_BUCKETS`, `limitPerIP`, `charge`; the env `RATE_LIMIT_SEND_BURST` / `RATE_LIMIT_SEND_REFILL_PER_SECOND` (default 20, 1 a second) and `RATE_LIMIT_IP_BURST` / `RATE_LIMIT_IP_REFILL_PER_SECOND` (default 30, 0.5 a second); `ServerOptions.getTokenBuckets` (by default in process, idle buckets evicted). Breaking: `ServerOptions.inProcessRooms.getIP` moved to `ServerOptions.getIP`, which the per-IP limit and the rooms both use. `createInProcessRooms` evicts an idle room rate limiter (its map grew forever) and exposes `rateLimiterCount()`.
  - `@missiv/common`: `RateLimitedDetails`.
  - `missiv`, `@missiv/bun`: pass the client's IP as `getIP`. The cf-worker passes `CF-Connecting-IP`; its buckets are per isolate until the Inbox Durable Object holds them.

- 3def73c: The live inbox channel (ADR-0006 "Live channel"): one WebSocket per signed-in client, and no more polling.

  - `@missiv/server`: `GET /api/inbox/ws` where the platform holds the sockets (`ServerOptions.liveInbox`, `createInProcessLiveInbox()`), the session token offered at the upgrade as `Sec-WebSocket-Protocol: missiv-inbox, <token>` and refused 401 before any socket otherwise. Every new message is pushed to both members' open sockets (the sender's other devices included, never to a member who blocked the sender) with each member's inbox row; `accept`, `reject` and `markRead` push the changed row to the user's own sockets; a `sync` is answered with what the client missed, then `ready`; at the token's expiry the socket is closed with 4001 `session-expired`. `PUSH_SKIP_WHEN_ONLINE=true` sends no Web Push to a recipient with the channel open (off by default; the push itself is unchanged). New port method `Inbox.getConversation`, new `LiveInbox` port.
  - `missiv` (Node.js) and `@missiv/bun`: serve the live inbox channel.
  - `@missiv/common`: the channel's wire (`INBOX_WS_PATH`, `INBOX_WS_PROTOCOL`, `INBOX_CLOSE_SESSION_EXPIRED`, `InboxSyncSchema`, `InboxServerFrame`, `inboxConversationKey`).
  - `@missiv/client`: `openConversationList` and `openOneConversation` run on one shared socket (`openInboxChannel`) and no longer poll; breaking: their `pollingInterval` is removed (`retryDelayMs` and `createWebSocket` are new). `API.getSession`. On cf-worker, which has no live channel yet, the stores update only when opened again.

- ab69a57: missiv on delegated-identity 0.2's key sets (ADR-0004 decision 1): an account registers, per domain, a key set (an Ed25519 signing key and an X25519 encryption key, derived from `@etherplay/connect`'s origin key, so every device of the account has the same) with the wallet's ownership signature of it. Breaking, and the database starts empty (the 0.6 schema, `0001_v0_6`; a 0.5 database fails to migrate).

  - `register` takes `keySet` and `ownershipSignature` (was `signature`, over a secp256k1 key) and must be signed by the key set's signing key; a key set or key registered for another account or domain is refused (409), a replayed registration too.
  - `DomainUser` carries `keySet`, `keyRef` and `ownershipSignature` (was `publicKey` and `signature`); `getKeySet {domain, keyRef}` returns any registered key set, current or replaced.
  - Every request, the room login included, is signed with delegated-identity's Ed25519 envelope by the signing key; `@missiv/common` no longer re-exports delegated-identity's helpers (import them from `delegated-identity`).
  - Messages keep 0.5's per-copy format: each copy signed with the sender's Ed25519 key (`signMessageCopy`, `verifyMessageCopy`, replacing `recoverMessageCopySigner`) and encrypted under the X25519 agreement of the two key sets. A message names its sender's `senderKeyRef` and carries `senderKeySet` (was `senderPublicKey`).
  - `@missiv/client`: the account is `{address, keySet, savedPublicKeyPublicationSignature?}` (`@etherplay/connect`'s signed-in account), `register(ownershipSignature?)` defaults to the saved signature, `otherUser.keySet` replaces `otherUser.publicKey`, `verifyKeySet` checks a key set against its wallet.

- 57b5d26: Sessions (ADR-0004 decision 5, ADR-0006): `POST /api/session {domain}`, a request signed by the signing key of the caller's current key set in the domain, answers `{token, expiresAt, keyRef}`, an HMAC-SHA256 token (`SESSION_SECRET`) valid an hour. Every route but `register` and `sendMessage` now takes `Authorization: Bearer <token>` instead of a request signature (a signed request there is refused 401), and checks it without reading the database. Breaking.

  - The server needs `SESSION_SECRET`: every route that authenticates its caller is refused (403 `forbidden`) while it is unset. `SESSION_SECRET_PREVIOUS` keeps tokens of a rotated-out secret valid until they expire.
  - A replayed session request is refused (409), as a replayed registration or send.
  - `@missiv/client`'s `API` opens a session per domain and signing key on its own, renews it five minutes before it expires and opens a new one once when a token is refused (`unauthenticated`); `openSession` opens one explicitly. Calls keep their signature (`{privateKey}`).
  - CORS allows the `Authorization` header.

- 72dd105: Direct messaging on the 0.6 API and store ports (ADR-0005, ADR-0006). Breaking: 0.5's messaging routes, actions and the per-copy format are removed, and `0002_v0_6_conversations` replaces the message tables.

  - `@missiv/server`: the store ports `KeyDirectory`, `ConversationStore` and `Inbox` (`Stores`, `services.getStores`), and one SQL implementation over `remote-sql` (`createSQLStores`) for libSQL, bun:sqlite and D1: one row per message under a per-conversation seq, one inbox row per member with `lastSeq` / `lastReadSeq`. `POST /api/messages/send` stores a message authorized by the session token and its own Ed25519 signature against the sender's current key set (no request signature, no replay set), its messageID within 10 minutes of the server's clock (else `stale`, with the server's time); a retry answers the stored seq, another signature under the same messageID is `conflict`. A send is one transaction of five statements whatever the history. `/api/private/listMessages` (`after` / `before` by seq), `listConversations` (by status, from the inbox index), `accept`, `reject` (blocks the other member in the domain; their messages are acknowledged and stored hidden from you), `unblock`, `markRead {seq}`. `RemoteSQLStorage` and the `Storage` type are gone.
  - `@missiv/common`: the 0.6 actions and responses (`ActionSendMessage` with a `MessageToSend`, `ActionListMessages`, `ActionListConversations`, `ActionAccept`, `ActionReject`, `ActionMarkRead`), `Conversation` with `status`, `lastSeq`, `lastReadSeq`, `lastMessageAt`, `isUnread`, `membersOfConversationID`, `MESSAGE_ID_WINDOW_MS`, the `stale` error code, `ulidTime`, `ulidAt`. Removed: the copy signature (`signMessageCopy`, `verifyMessageCopy`, `messageCopyMessage`) and 0.5's conversation actions.
  - `@missiv/client`: the `API`'s `sendMessage` (on the session), `listMessages`, `listConversations`, `accept`, `reject`, `unblock`, `markRead`; the conversation store fetches only what is after the last seq it has and sends `pairwise-v1` messages, composing a `stale` one again under the server's time; the list counts unread from `lastReadSeq`. Removed: `encryptedCopies`, `clearCopies`, `openMessageCopy`.
  - `@missiv/bun`: declares Bun 1.3.13 or later; `createBunServer`; its tests (the store contract on bun:sqlite, the platform's boot) run under `bun test`.

### Patch Changes

- Updated dependencies [5ea6e6c]
- Updated dependencies [acfc339]
- Updated dependencies [3def73c]
- Updated dependencies [ab69a57]
- Updated dependencies [f7e0ee5]
- Updated dependencies [f7e2d57]
- Updated dependencies [57b5d26]
- Updated dependencies [eeff070]
- Updated dependencies [72dd105]
- Updated dependencies [197bb22]
  - @missiv/common@0.6.0
  - @missiv/server@0.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [43d28cb]
  - @missiv/common@0.5.0
  - @missiv/server@0.5.0

## 0.4.0

Published as `@missiv/bun` from 0.4.0 (formerly `missiv-server-bun`, which stops at 0.3.x and is deprecated). Its command is `missiv-bun`.

### Minor Changes

- f048b28: missiv 0.4.0: the reworked protocol, server and client (S3-15; a 0.x minor, not yet 1.0, by the user's choice). What changed since 0.3, in one place: every request is signed with delegated-identity's envelope (server origin, route, timestamp, body hash) and a key acts only in the domain it is registered for; the `DEV`/`FAKE:` paths, the all-zero registration and `_initDB` are gone, the admin API needs `ADMIN_TOKEN`; the schema is numbered migrations (`migrate()`, or `wrangler d1 migrations apply`), and 0.4 starts from an empty database (a database of 0.3 or earlier is not migrated); profiles are per domain; conversation IDs are derived by the server, recipients' keys checked, lists and messages paged by cursor; rejecting blocks; a newer key replaces the older; rooms run on nodejs and bun in process and the gated room is enforced; a new direct message is pushed through push-notification-server (`PUSH_SERVER_URL`, `PUSH_TOKENS`); each copy carries its sender's signature, checked by the reading client with the sender's ownership proof; the client verifies every key, sends in clear only when asked, opens each copy on its own, and its stores share one lifecycle. Errors are `{error: {code, message}}` under their status. missiv-client now depends on missiv-common (it was a peer dependency), and the packages depend on each other with `^`, so an app installs `missiv-client@^0.4` alone. (The root has `prettier-plugin-svelte`, so `changeset version` can format missiv-client's changelog.) See each package's earlier entries for the detail.
- 02bece9: No backdoors, a key bound to its domain, and migrations.

  - The `DEV` flag is gone, and with it `FAKE:` request authentication and the all-zero registration signature. `/api/admin/db-reset` needs `Authorization: Bearer <ADMIN_TOKEN>` and refuses every request when `ADMIN_TOKEN` is unset. `?_initDB=true` is gone. An internal error's cause and stack reach the caller only with `EXPOSE_ERRORS=true`. The bun platform's default env no longer sets `DEV=true`.
  - A key acts only in the domain it is registered for: an action naming another domain is a 403.
  - The profile is per domain (`name`, `description` on the domain user); the global `Users` table, `/user/getUser` and `/user/getCompleteUser` are replaced by `/user/getDomainUser` (`{domainUser}`); `domainUsername` and `domainDescription` are gone.
  - The schema is numbered migration files (`packages/server/src/schema/migrations`), applied by `migrate(db)` (exported) at every platform's start, and on cf-worker by `wrangler d1 migrations apply` from the same files. Message fields are columns, message IDs are ULIDs (strings). 0.4 starts from an empty database: a database of 0.3 or earlier is not migrated.
  - missiv-client's `API` signs every request with a delegate key (`{privateKey}`); `clear()` became `adminReset(token)`.

- 2b97f84: Rooms: the gated room enforced, rooms held in process shared by nodejs and bun, and the nodejs platform serving them.

  - A login changes the session only when both the signature and, in a contract-gated room, the contract's `eth_call` pass; a session the contract did not admit cannot write. The `eth_call`'s detail goes to the log, not to the client, and the result is compared case-insensitively.
  - missiv-server exports `createInProcessRooms` (rooms and rate limiters held in the process, one per name, each room's history bounded) and `ServerOptions.inProcessRooms`, through which the public API upgrades a room's socket with the platform's `upgradeWebSocket`.
  - missiv-server-nodejs exports `createNodeServer({db, env})` (the app over libSQL, migrated, with rooms through `@hono/node-ws`) and serves rooms; its CLI uses it. missiv-server-bun runs on the same in-process rooms through `hono/bun`, and its SQL batch is a real transaction.
  - The Cloudflare room relies on the Hibernation API's handlers only (no listeners passing the wrong end of the pair) and returns no stack to clients. Every platform cleans up a socket on an error as on a close.

### Patch Changes

- 5121400: The docs describe missiv 0.4 as built: CONTEXT.md's vocabulary (delegate key, ownership proof, domain user, request signature, copy signature, introduction, block, push) and its untrusted relay as it now holds, `docs/architecture.md` (the packages, the configuration: `ADMIN_TOKEN`, `SERVER_ORIGIN`, `PUSH_SERVER_URL`, `PUSH_TOKENS`, `EXPOSE_ERRORS`, `CHAIN_<id>`, `DB`; `createNodeServer`, `createInProcessRooms`, the migrations), ADR-0003 for the trust model and its known limits, and a README for missiv-client and each platform. The review's observations are discharged (their fixes landed), two new ones record what is still open (bun and cf-worker not run since the rework; the room rate limiter refusing a quick burst), and the backlog tasks `per-message-signature-over-ciphertext` and `frontend-send-message-error-handling` are cancelled as superseded by the S3c items that built them.
- Updated dependencies [f048b28]
- Updated dependencies [79fe3ab]
- Updated dependencies [02bece9]
- Updated dependencies [a373e78]
- Updated dependencies [920cd88]
- Updated dependencies [6879061]
- Updated dependencies [57587d5]
- Updated dependencies [2b97f84]
- Updated dependencies [5121400]
- Updated dependencies [2903279]
- Updated dependencies [d021bbc]
- Updated dependencies [c3821ce]
  - missiv-common@0.4.0
  - missiv-server@0.4.0

## 0.3.2

### Patch Changes

- no static services, duplicate in DurableObject
- Updated dependencies
  - missiv-server@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies
  - missiv-server@0.3.1

## 0.3.0

### Minor Changes

- fixes

### Patch Changes

- Updated dependencies
  - missiv-common@0.3.0
  - missiv-server@0.3.0

## 0.2.3

### Patch Changes

- fix version
- Updated dependencies
  - missiv-common@0.2.2
  - missiv-server@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - missiv-server@0.2.2

## 0.2.1

### Patch Changes

- use zod instead of typia but keep typescript types as canonical
- Updated dependencies
  - missiv-common@0.2.1
  - missiv-server@0.2.1

## 0.2.0

### Minor Changes

- new version

### Patch Changes

- Updated dependencies
  - missiv-common@0.2.0
  - missiv-server@0.2.0

## 0.1.4

### Patch Changes

- Updated dependencies
  - missiv-server@0.1.3

## 0.1.3

### Patch Changes

- fix
- Updated dependencies
  - missiv-server@0.1.2

## 0.1.2

### Patch Changes

- fix

## 0.1.1

### Patch Changes

- Updated dependencies
  - missiv-server@0.1.1

## 0.1.0

### Minor Changes

- release v0.1.x

### Patch Changes

- Updated dependencies
  - missiv-common@0.1.0
  - missiv-server@0.1.0

## 0.0.2

### Patch Changes

- missiv-server-bun

## 0.0.1

### Patch Changes

- Updated dependencies
  - missiv-common@0.0.10
  - missiv-server@0.0.1
