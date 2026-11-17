# missiv-client

## 0.4.0

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
- 2903279: missiv-client's stores rebuilt on one lifecycle (S3-14). `activeStore` (in `utils/lifecycle.ts`) runs a store's work only while it has subscribers and only for the registration's current account: a change of account stops the run and starts another, the last unsubscription stops it, and a stopped run cannot write the store; `poll` repeats a fetch while the run lives. It replaces the copied `derivedWithStartStopNotifier` and the `running`/`fetching` flags, and fixes what they broke: the conversation list polls again (it fetched once) and counts requests (`numUnaccepted`: not accepted) apart from unread accepted conversations (they were inverted); a conversation closed while fetching stops polling; `markAsAcceptedAndRead` accepts once per newer message instead of on every poll; the room reconnects a lost socket with backoff, with a fresh challenge and a new login, and stops listening to a socket it closed. Every server error reaches the store: a store's `error` carries the server's `code`, `register` and `edit` reject with the `MissivAPIError` and set it, and a room message the room refuses (rate-limited, too long, not logged in, not authorized) is marked `failed` with the room's error instead of staying pending. Breaking: `openOneConversation` takes no `account` (the registration's account is the reader) and its state's `conversationID` is undefined while `Idle`; `ChatUser` is `{address, id}`, one per session; each store takes an optional `fetch`, and `openRoom` a `createWebSocket` and a `reconnectDelayMs`. Room messages carry no `signature` field any more (the server attributes them to the session, ADR-0002), and every room error has a `code`. The demo app's conversation panel sends an introduction in clear only on an explicit button, shows a copy it cannot open as such, and its svelte-check error is fixed; `svelte-check` now runs in missiv-client's build, so the verify fails on a type error.
- d021bbc: The client trusts no key it has not verified (S3-12). Each copy of a message now carries its own `signature`, the sender's delegate key over a `missiv message v1` EIP-191 message naming its domain, namespace, conversation, type, sender, recipient, key and content hash (`signMessageCopy`, `recoverMessageCopySigner` in missiv-common); the top-level `signature` of `sendMessage` is gone. The server stores each copy's signature and the sender's ownership proof of its key (`senderOwnershipSignature`, `senderAppOrigin`) with it, and checks neither: the reader does. missiv-client checks every key against its wallet's ownership proof (`verifyDomainUser`, `verifyOwnership`), refuses to encrypt to a key that fails, never sends in clear unless asked (`sendIntroduction`), binds the scope and both keys as the ciphertext's associated data, and opens each copy on its own (`openMessage`), into its text or an `unverified` or `undecryptable` error, so one bad copy no longer stops a thread. The registration store is `Registered` only when the server's record is this signer's key, proven by this wallet; otherwise it is `Unregistered` with `otherKey`.

### Patch Changes

- 5121400: The docs describe missiv 0.4 as built: CONTEXT.md's vocabulary (delegate key, ownership proof, domain user, request signature, copy signature, introduction, block, push) and its untrusted relay as it now holds, `docs/architecture.md` (the packages, the configuration: `ADMIN_TOKEN`, `SERVER_ORIGIN`, `PUSH_SERVER_URL`, `PUSH_TOKENS`, `EXPOSE_ERRORS`, `CHAIN_<id>`, `DB`; `createNodeServer`, `createInProcessRooms`, the migrations), ADR-0003 for the trust model and its known limits, and a README for missiv-client and each platform. The review's observations are discharged (their fixes landed), two new ones record what is still open (bun and cf-worker not run since the rework; the room rate limiter refusing a quick burst), and the backlog tasks `per-message-signature-over-ciphertext` and `frontend-send-message-error-handling` are cancelled as superseded by the S3c items that built them.
- Updated dependencies [f048b28]
- Updated dependencies [02bece9]
- Updated dependencies [a373e78]
- Updated dependencies [920cd88]
- Updated dependencies [6879061]
- Updated dependencies [2903279]
- Updated dependencies [d021bbc]
- Updated dependencies [c3821ce]
  - missiv-common@0.4.0

## 0.3.0

### Minor Changes

- release v0.1.x

### Patch Changes

- Updated dependencies
  - missiv-common@0.1.0

## 0.0.14

### Patch Changes

- new
- Updated dependencies
  - missiv-common@0.0.10
