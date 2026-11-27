# @missiv/server

## 0.6.0

### Minor Changes

- 5ea6e6c: Rate limits on direct messaging (spec `scalable-direct-messaging`, story 27): a token bucket per account (and domain) on `messages/send`, and one per client IP on `/api/session` and `register` together, refused `rate_limited` (429) with `details.retryAfterMs` and a `Retry-After` header.

  - `@missiv/server`: `createTokenBuckets`, `createInProcessTokenBuckets`, `tokenBucketConfigsFromEnv`, `DEFAULT_TOKEN_BUCKETS`, `limitPerIP`, `charge`; the env `RATE_LIMIT_SEND_BURST` / `RATE_LIMIT_SEND_REFILL_PER_SECOND` (default 20, 1 a second) and `RATE_LIMIT_IP_BURST` / `RATE_LIMIT_IP_REFILL_PER_SECOND` (default 30, 0.5 a second); `ServerOptions.getTokenBuckets` (by default in process, idle buckets evicted). Breaking: `ServerOptions.inProcessRooms.getIP` moved to `ServerOptions.getIP`, which the per-IP limit and the rooms both use. `createInProcessRooms` evicts an idle room rate limiter (its map grew forever) and exposes `rateLimiterCount()`.
  - `@missiv/common`: `RateLimitedDetails`.
  - `missiv`, `@missiv/bun`: pass the client's IP as `getIP`. The cf-worker passes `CF-Connecting-IP`; its buckets are per isolate until the Inbox Durable Object holds them.

- acfc339: Cloudflare's direct messaging on Durable Objects (ADR-0005, ADR-0006): the cf-worker keeps D1 for the key directory only, behind an in-isolate cache of its lookups, and holds each conversation in a Conversation Durable Object and each (domain, user)'s inbox, blocks and live sockets in an Inbox Durable Object (SQLite storage, hibernatable WebSockets). A send's inbox updates are retried by the Conversation object's alarm until acknowledged; a block is owned by the blocker's Inbox and propagated to every conversation it shares with the blocked member, in every namespace of the domain. The cf-worker now serves the live inbox channel (`GET /api/inbox/ws`), so the client's stores update live there too. The store contract runs on the Workers runtime (`@cloudflare/vitest-pool-workers`, `pnpm --filter @missiv/cf-worker test`).

  - `@missiv/server`: `ServerOptions.getLiveInboxRouter` and the `LiveInboxRouter` port (a live inbox whose sockets another object holds and pushes to: the server checks the token at the upgrade and hands the request over); `cachedKeyDirectory` (a KeyDirectory answering found lookups from a cache for a time to live); `answerSync` and `checkInboxUpgrade` exported; `signSessionToken` and `verifySessionToken` exported. A `sync` now also heals the account's inbox row when the newest message it sends is above the row's `lastSeq` (never the case on the SQL stores, whose rows are written with the message).
  - cf-worker (a deployment): new Durable Object classes `ServerObjectConversation` and `ServerObjectInbox` (wrangler migration `v3`, `new_sqlite_classes`), compatibility date 2025-03-10 (Durable Object RPC); the D1 database keeps the shared migrations, of which only the key directory's tables are used.

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

- f7e2d57: A message the blocker sends unblocks (ADR-0006 "Sending", amended 2026-11-27): when a member has rejected (so blocked) the other member in a domain and then sends them a message there, that send lifts the block as `unblock` would, so the other member's replies reach them again, and their inbox row moves to accepted as for any message they send. A retry of a message sent before a newer block does not lift it. The send path also reads the sender's current key set from the directory on every send (ADR-0006 "Send path" amended to say so).

  - `@missiv/server`: the SQL stores lift the sender's block of the recipient in the send's own transaction (six statements per send, each a key lookup). The in-process token buckets never credit a refill twice when the clock steps back (the refill's anchor is the latest time seen, and `retryAfterMs` counts from it). `Retry-After` is in the CORS exposed headers, so a browser on another origin can read it.
  - cf-worker (a deployment): the blocker's Inbox object lifts its block when it applies the blocker's own update, and propagates the unblock (versioned) to every Conversation object it shares with that member, as `unblock` does.

- 57b5d26: Sessions (ADR-0004 decision 5, ADR-0006): `POST /api/session {domain}`, a request signed by the signing key of the caller's current key set in the domain, answers `{token, expiresAt, keyRef}`, an HMAC-SHA256 token (`SESSION_SECRET`) valid an hour. Every route but `register` and `sendMessage` now takes `Authorization: Bearer <token>` instead of a request signature (a signed request there is refused 401), and checks it without reading the database. Breaking.

  - The server needs `SESSION_SECRET`: every route that authenticates its caller is refused (403 `forbidden`) while it is unset. `SESSION_SECRET_PREVIOUS` keeps tokens of a rotated-out secret valid until they expire.
  - A replayed session request is refused (409), as a replayed registration or send.
  - `@missiv/client`'s `API` opens a session per domain and signing key on its own, renews it five minutes before it expires and opens a new one once when a token is refused (`unauthenticated`); `openSession` opens one explicitly. Calls keep their signature (`{privateKey}`).
  - CORS allows the `Authorization` header.

- eeff070: A heartbeat on every missiv socket (the live inbox channel and the rooms), so an idle socket that a proxy or a mobile network dropped silently is noticed and replaced.

  - `@missiv/common`: the heartbeat's wire (`HEARTBEAT_PING`, `HEARTBEAT_PONG`, `HEARTBEAT_INTERVAL_MS` 30 s, `HEARTBEAT_TIMEOUT_MS` 10 s, `HEARTBEAT_IDLE_INTERVALS` 3, `HEARTBEAT_CLOSE_TIMEOUT` 4002 with `HEARTBEAT_TIMEOUT_REASON` `heartbeat-timeout`).
  - `@missiv/client`: `openInboxChannel` and `openRoom` send the text frame `ping` every interval and, when no frame arrives within the timeout, close the socket `heartbeat-timeout` and reconnect with their backoff (then sync, or log in again). New options `heartbeatIntervalMs` and `heartbeatTimeoutMs`, also on `openConversationList` and `openOneConversation`.
  - `@missiv/server`: the live inbox's sockets and the rooms answer `ping` with `pong` (ahead of a sync and of a room's rate limiter), and on Node.js and Bun a socket that sent nothing for three intervals (90 s) is closed `heartbeat-timeout`. A client from before this release sends no ping, so against an upgraded Node.js or Bun server its idle socket is closed every 90 s and reconnects: upgrade `@missiv/client` together with the server.
  - cf-worker (a deployment): the Inbox and Room Durable Objects answer `ping` by WebSocket auto-response, which neither wakes the object nor bills its duration.

- 72dd105: Direct messaging on the 0.6 API and store ports (ADR-0005, ADR-0006). Breaking: 0.5's messaging routes, actions and the per-copy format are removed, and `0002_v0_6_conversations` replaces the message tables.

  - `@missiv/server`: the store ports `KeyDirectory`, `ConversationStore` and `Inbox` (`Stores`, `services.getStores`), and one SQL implementation over `remote-sql` (`createSQLStores`) for libSQL, bun:sqlite and D1: one row per message under a per-conversation seq, one inbox row per member with `lastSeq` / `lastReadSeq`. `POST /api/messages/send` stores a message authorized by the session token and its own Ed25519 signature against the sender's current key set (no request signature, no replay set), its messageID within 10 minutes of the server's clock (else `stale`, with the server's time); a retry answers the stored seq, another signature under the same messageID is `conflict`. A send is one transaction of five statements whatever the history. `/api/private/listMessages` (`after` / `before` by seq), `listConversations` (by status, from the inbox index), `accept`, `reject` (blocks the other member in the domain; their messages are acknowledged and stored hidden from you), `unblock`, `markRead {seq}`. `RemoteSQLStorage` and the `Storage` type are gone.
  - `@missiv/common`: the 0.6 actions and responses (`ActionSendMessage` with a `MessageToSend`, `ActionListMessages`, `ActionListConversations`, `ActionAccept`, `ActionReject`, `ActionMarkRead`), `Conversation` with `status`, `lastSeq`, `lastReadSeq`, `lastMessageAt`, `isUnread`, `membersOfConversationID`, `MESSAGE_ID_WINDOW_MS`, the `stale` error code, `ulidTime`, `ulidAt`. Removed: the copy signature (`signMessageCopy`, `verifyMessageCopy`, `messageCopyMessage`) and 0.5's conversation actions.
  - `@missiv/client`: the `API`'s `sendMessage` (on the session), `listMessages`, `listConversations`, `accept`, `reject`, `unblock`, `markRead`; the conversation store fetches only what is after the last seq it has and sends `pairwise-v1` messages, composing a `stale` one again under the server's time; the list counts unread from `lastReadSeq`. Removed: `encryptedCopies`, `clearCopies`, `openMessageCopy`.
  - `@missiv/bun`: declares Bun 1.3.13 or later; `createBunServer`; its tests (the store contract on bun:sqlite, the platform's boot) run under `bun test`.

- 197bb22: A switchable inbox transport: direct messages can be delivered on the live inbox socket (as before) or by polling a cheap "changed since", and a client in `auto` falls back from one to the other.

  - `@missiv/common`: the inbox version, `Conversation.version` (the version at which the row last changed), `INBOX_CHANGES_PATH`, `INBOX_TRANSPORTS`, `ActionInboxChangesSchema` and `ResponseInboxChanges` (`{version, unchanged: true}` or `{version, conversations, hasMore}`).
  - `@missiv/server`: `POST /api/inbox/changes {domain, since}` on a session token, new port method `Inbox.changes` (SQL: migration `0003_inbox_version`, a `version` column on `Inbox`), `INBOX_TRANSPORTS` (`socket,poll` by default; a transport left out answers 404; `poll` alone for several Node.js or Bun instances behind one load balancer). On Node.js and Bun an unchanged poll is answered from the process's memory, with no database read, while the socket is offered (`createInboxVersionCache`). Accept, reject and markRead that change nothing no longer write.
  - `@missiv/client`: `openInboxChannel` (and `openConversationList`, `openOneConversation`) take `transport: 'socket' | 'poll' | 'auto'` (default `auto`) and `pollIntervalMs` (default 5 s); `auto` polls after three sockets in a row failed and tries the socket again every minute. New `API.inboxChanges`.
  - cf-worker (a deployment): the Inbox Durable Object keeps the version with its rows (an existing object gets the column on its next start) and answers a poll from its own storage. Polling still costs a Worker and a Durable Object request per poll; the socket stays the cheaper transport there.

### Patch Changes

- f7e0ee5: The missiv message format (ADR-0004 decisions 2 and 3, ADR-0006 "The message"): one ciphertext per message, signed once. Not yet stored or sent by the server (that is the next release step); the per-copy format keeps working meanwhile.

  - `@missiv/common`: the `Message` type and its zod schemas (`MessageToSendSchema`, `MessageSchema`), the signing payload (`messageSigningPayload`, `signMessage`, `verifyMessage`: Ed25519 over `missiv message` with the content's SHA-256), `pairwise-v1` (`pairwiseKeyID`, `encryptPairwise`, `decryptPairwise`: HKDF-SHA256 of the X25519 shared secret, AES-256-GCM), through WebCrypto when `crypto.subtle` exists and `@noble` otherwise, pinned by test vectors; `newULID`.
  - `@missiv/client`: `composeMessage` (`pairwise-v1`), `composeIntroduction` (`clear`) and `openMessage`, which fetches the sender's key set by `senderKeyRef` through `getKeySet`. Breaking: the per-copy reader is renamed `openMessageCopy` (and `OpenedMessage` of a copy `OpenedMessageCopy`).
  - `@missiv/server`: its ULIDs come from `@missiv/common`.

- Updated dependencies [5ea6e6c]
- Updated dependencies [3def73c]
- Updated dependencies [ab69a57]
- Updated dependencies [f7e0ee5]
- Updated dependencies [57b5d26]
- Updated dependencies [eeff070]
- Updated dependencies [72dd105]
- Updated dependencies [197bb22]
  - @missiv/common@0.6.0

## 0.5.0

### Minor Changes

- 43d28cb: A direct message's push is a documented contract, and its `navigate` carries the conversation for browsers where the app's service worker never runs (Safari 18.4+). `@missiv/common` exports `MissivPushData` (now with the `recipient` the push is for) and `MissivPushHandoff` with their readers, and the generic hand-off helpers `withPushHandoff`, `splitPushHandoff` and `consumePushHandoff`. The push's `navigate` stays the app's root and gains a `#push-handoff=<base64url JSON>` fragment, `{missiv: {type, namespace, conversationID, recipient}}`. The page reads it with `consumePushHandoff()`, which also removes it from the URL. See the README's "Push notifications".

### Patch Changes

- Updated dependencies [43d28cb]
  - @missiv/common@0.5.0

## 0.4.0

Published as `@missiv/server` from 0.4.0 (formerly `missiv-server`, which stops at 0.3.x and is deprecated).

### Minor Changes

- f048b28: missiv 0.4.0: the reworked protocol, server and client (S3-15; a 0.x minor, not yet 1.0, by the user's choice). What changed since 0.3, in one place: every request is signed with delegated-identity's envelope (server origin, route, timestamp, body hash) and a key acts only in the domain it is registered for; the `DEV`/`FAKE:` paths, the all-zero registration and `_initDB` are gone, the admin API needs `ADMIN_TOKEN`; the schema is numbered migrations (`migrate()`, or `wrangler d1 migrations apply`), and 0.4 starts from an empty database (a database of 0.3 or earlier is not migrated); profiles are per domain; conversation IDs are derived by the server, recipients' keys checked, lists and messages paged by cursor; rejecting blocks; a newer key replaces the older; rooms run on nodejs and bun in process and the gated room is enforced; a new direct message is pushed through push-notification-server (`PUSH_SERVER_URL`, `PUSH_TOKENS`); each copy carries its sender's signature, checked by the reading client with the sender's ownership proof; the client verifies every key, sends in clear only when asked, opens each copy on its own, and its stores share one lifecycle. Errors are `{error: {code, message}}` under their status. missiv-client now depends on missiv-common (it was a peer dependency), and the packages depend on each other with `^`, so an app installs `missiv-client@^0.4` alone. (The root has `prettier-plugin-svelte`, so `changeset version` can format missiv-client's changelog.) See each package's earlier entries for the detail.
- 02bece9: No backdoors, a key bound to its domain, and migrations.

  - The `DEV` flag is gone, and with it `FAKE:` request authentication and the all-zero registration signature. `/api/admin/db-reset` needs `Authorization: Bearer <ADMIN_TOKEN>` and refuses every request when `ADMIN_TOKEN` is unset. `?_initDB=true` is gone. An internal error's cause and stack reach the caller only with `EXPOSE_ERRORS=true`. The bun platform's default env no longer sets `DEV=true`.
  - A key acts only in the domain it is registered for: an action naming another domain is a 403.
  - The profile is per domain (`name`, `description` on the domain user); the global `Users` table, `/user/getUser` and `/user/getCompleteUser` are replaced by `/user/getDomainUser` (`{domainUser}`); `domainUsername` and `domainDescription` are gone.
  - The schema is numbered migration files (`packages/server/src/schema/migrations`), applied by `migrate(db)` (exported) at every platform's start, and on cf-worker by `wrangler d1 migrations apply` from the same files. Message fields are columns, message IDs are ULIDs (strings). 0.4 starts from an empty database: a database of 0.3 or earlier is not migrated.
  - missiv-client's `API` signs every request with a delegate key (`{privateKey}`); `clear()` became `adminReset(token)`.

- a373e78: Conversations the server keeps honest, reject as block, and key replacement.

  - A send's members are its recipients, the sender's own copy included; its `conversationID` must be `conversationIDOf(members)` (exported by missiv-common: the pair's ID for two, keccak256 of the sorted addresses otherwise), or it is a 400. An encrypted copy for a recipient must name that recipient's registered key (else 409); a clear copy names no key (`toPublicKey` is optional there, and stored as null).
  - Rejecting a conversation of two blocks its other member in the domain: nothing they send reaches you, in any conversation, until `/private/unblock`.
  - `getMessages` and the conversation lists take `limit` (at most 100) and `before`, and answer a `cursor` when there are older items; messages come newest first.
  - Registering a new key for the same wallet and domain replaces the old one (which stops authenticating; messages encrypted to it stay readable only by it); a key registered for another account or domain is a 409.

- 920cd88: Every signature is delegated-identity's request envelope. A request's `SIGNATURE` header is `signRequest`'s (`<timestamp>:<signature>:<recovery>`, over the server's origin, the method and path, the timestamp and the body's hash, EIP-191-hashed) and the server refuses one outside 60 s or for another server, route or body (`SERVER_ORIGIN` sets the origin the server expects behind a rewriting proxy). A signed `sendMessage` or `register` is refused if replayed within its window. The room login signs the same envelope around its challenge (`GET`, the room's path). Registration names the app's origin (`appOrigin`, whose host is the domain), which the ownership signature is checked against and which the domain user keeps, so a client can verify the proof itself; missiv-client's registration store takes it as `appOrigin` (the page's origin by default). missiv-server's own raw-body recovery (`utils/signature.ts`) is gone.
- 6879061: One schema source and typed errors. The request schemas are zod schemas in missiv-common, with their types inferred from them; missiv-server validates against them (an invalid body is a 400 `invalid_request`). Every error answers `{error: {code, message, details?}}` under its code's status (400, 401, 403, 404, 409, 429, 500), and missiv-client's `API` throws a `MissivAPIError` carrying both. Removed: the unused Hono client export (`createClient`, `Client`), the `/api/public/ws` echo route and `/api/public/` (so a platform without WebSockets can build the app), CORS credentials, and dead code (`utils/response.ts`, `css2ts.cjs`, the Room's `requireLogin` and `DEBUG` branch, nodejs's `migrate.ts`). `ConversationMessage` now declares the `signature` the server returns.
- 57587d5: A push on a new direct message, through push-notification-server (@push-notification/server). With `PUSH_SERVER_URL` set and a token for the domain in `PUSH_TOKENS` (`<domain>=<token>,...`, the tokens it issued, held as secrets), each registered recipient other than the sender, and other than one who blocked the sender, gets one `POST /api/push` with `Authorization: Bearer <token>` and `Idempotency-Key: missiv:<domain>:<messageID>:<recipient>`. The message is a Declarative Web Push naming the sender and the conversation, never the content. A failed send (502) or an unreachable server is retried with the same key, a busy key (409) later, each a bounded number of times; a refused token (401, 403) is logged and not retried; a domain without a token sends nothing and is logged once. The pushes run after the response (`ServerOptions.waitUntil`, cf-worker's `executionCtx.waitUntil`). `ServerOptions.getPushNotifier` replaces the notifier (a recording one in tests).
- 2b97f84: Rooms: the gated room enforced, rooms held in process shared by nodejs and bun, and the nodejs platform serving them.

  - A login changes the session only when both the signature and, in a contract-gated room, the contract's `eth_call` pass; a session the contract did not admit cannot write. The `eth_call`'s detail goes to the log, not to the client, and the result is compared case-insensitively.
  - missiv-server exports `createInProcessRooms` (rooms and rate limiters held in the process, one per name, each room's history bounded) and `ServerOptions.inProcessRooms`, through which the public API upgrades a room's socket with the platform's `upgradeWebSocket`.
  - missiv-server-nodejs exports `createNodeServer({db, env})` (the app over libSQL, migrated, with rooms through `@hono/node-ws`) and serves rooms; its CLI uses it. missiv-server-bun runs on the same in-process rooms through `hono/bun`, and its SQL batch is a real transaction.
  - The Cloudflare room relies on the Hibernation API's handlers only (no listeners passing the wrong end of the pair) and returns no stack to clients. Every platform cleans up a socket on an error as on a close.

- 2903279: missiv-client's stores rebuilt on one lifecycle (S3-14). `activeStore` (in `utils/lifecycle.ts`) runs a store's work only while it has subscribers and only for the registration's current account: a change of account stops the run and starts another, the last unsubscription stops it, and a stopped run cannot write the store; `poll` repeats a fetch while the run lives. It replaces the copied `derivedWithStartStopNotifier` and the `running`/`fetching` flags, and fixes what they broke: the conversation list polls again (it fetched once) and counts requests (`numUnaccepted`: not accepted) apart from unread accepted conversations (they were inverted); a conversation closed while fetching stops polling; `markAsAcceptedAndRead` accepts once per newer message instead of on every poll; the room reconnects a lost socket with backoff, with a fresh challenge and a new login, and stops listening to a socket it closed. Every server error reaches the store: a store's `error` carries the server's `code`, `register` and `edit` reject with the `MissivAPIError` and set it, and a room message the room refuses (rate-limited, too long, not logged in, not authorized) is marked `failed` with the room's error instead of staying pending. Breaking: `openOneConversation` takes no `account` (the registration's account is the reader) and its state's `conversationID` is undefined while `Idle`; `ChatUser` is `{address, id}`, one per session; each store takes an optional `fetch`, and `openRoom` a `createWebSocket` and a `reconnectDelayMs`. Room messages carry no `signature` field any more (the server attributes them to the session, ADR-0002), and every room error has a `code`. The demo app's conversation panel sends an introduction in clear only on an explicit button, shows a copy it cannot open as such, and its svelte-check error is fixed; `svelte-check` now runs in missiv-client's build, so the verify fails on a type error.
- d021bbc: The client trusts no key it has not verified (S3-12). Each copy of a message now carries its own `signature`, the sender's delegate key over a `missiv message v1` EIP-191 message naming its domain, namespace, conversation, type, sender, recipient, key and content hash (`signMessageCopy`, `recoverMessageCopySigner` in missiv-common); the top-level `signature` of `sendMessage` is gone. The server stores each copy's signature and the sender's ownership proof of its key (`senderOwnershipSignature`, `senderAppOrigin`) with it, and checks neither: the reader does. missiv-client checks every key against its wallet's ownership proof (`verifyDomainUser`, `verifyOwnership`), refuses to encrypt to a key that fails, never sends in clear unless asked (`sendIntroduction`), binds the scope and both keys as the ciphertext's associated data, and opens each copy on its own (`openMessage`), into its text or an `unverified` or `undecryptable` error, so one bad copy no longer stops a thread. The registration store is `Registered` only when the server's record is this signer's key, proven by this wallet; otherwise it is `Unregistered` with `otherKey`.

### Patch Changes

- 79fe3ab: Remove debug logging and fix a misleading schema comment.

  - Stop logging authentication material: dropped the `console.log` that printed the WebSocket login signature and challenge, plus two other stray debug logs in `Room` and `RemoteSQLStorage.sendMessage`.
  - Fix the inverted status comment in the ConversationParticipants schema so it matches the actual enum (`0 = unaccepted, 1 = rejected, 2 = accepted`).

- 5121400: The docs describe missiv 0.4 as built: CONTEXT.md's vocabulary (delegate key, ownership proof, domain user, request signature, copy signature, introduction, block, push) and its untrusted relay as it now holds, `docs/architecture.md` (the packages, the configuration: `ADMIN_TOKEN`, `SERVER_ORIGIN`, `PUSH_SERVER_URL`, `PUSH_TOKENS`, `EXPOSE_ERRORS`, `CHAIN_<id>`, `DB`; `createNodeServer`, `createInProcessRooms`, the migrations), ADR-0003 for the trust model and its known limits, and a README for missiv-client and each platform. The review's observations are discharged (their fixes landed), two new ones record what is still open (bun and cf-worker not run since the rework; the room rate limiter refusing a quick burst), and the backlog tasks `per-message-signature-over-ciphertext` and `frontend-send-message-error-handling` are cancelled as superseded by the S3c items that built them.
- c3821ce: The ownership proof (a wallet's signature authorizing a delegate key for an app origin) now comes from delegated-identity (its own package and repo, github.com/wighawag/delegated-identity), shared with the other services that check it: missiv-common re-exports `originPublicKeyPublicationMessage` and `fromDomainToOrigin` from it (`fromDomainToOrigin` now keeps an `http://` origin as it is), and missiv-server's `/register` recovers the account through it, unchanged in behaviour. missiv's own raw-body request signature is unchanged; delegated-identity's request envelope replaces it in a later release.
- Updated dependencies [f048b28]
- Updated dependencies [02bece9]
- Updated dependencies [a373e78]
- Updated dependencies [920cd88]
- Updated dependencies [6879061]
- Updated dependencies [2903279]
- Updated dependencies [d021bbc]
- Updated dependencies [c3821ce]
  - missiv-common@0.4.0

## 0.3.2

### Patch Changes

- no static services, duplicate in DurableObject

## 0.3.1

### Patch Changes

- fix env

## 0.3.0

### Minor Changes

- fixes

### Patch Changes

- Updated dependencies
  - missiv-common@0.3.0

## 0.2.3

### Patch Changes

- fix version
- Updated dependencies
  - missiv-common@0.2.2

## 0.2.2

### Patch Changes

- fixes types

## 0.2.1

### Patch Changes

- use zod instead of typia but keep typescript types as canonical
- Updated dependencies
  - missiv-common@0.2.1

## 0.2.0

### Minor Changes

- new version

### Patch Changes

- Updated dependencies
  - missiv-common@0.2.0

## 0.1.3

### Patch Changes

- fixes

## 0.1.2

### Patch Changes

- fix

## 0.1.1

### Patch Changes

- typia is a runtime dependency

## 0.1.0

### Minor Changes

- release v0.1.x

### Patch Changes

- Updated dependencies
  - missiv-common@0.1.0

## 0.0.1

### Patch Changes

- new
- Updated dependencies
  - missiv-common@0.0.10
