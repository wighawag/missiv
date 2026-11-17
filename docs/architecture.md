# missiv architecture (code-shape overview)

A description of how missiv's own code is laid out. This is current-truth about OUR code (it changes as the code changes); external ground-truth we integrate with lives in `work/notes/findings/`, and decisions-with-rationale live in `docs/adr/`.

## Monorepo layout

A pnpm workspace (`pnpm-workspace.yaml`) with three groups:

- `packages/*`
  - **`@missiv/common`**: the protocol. Every request and response of the HTTP API as a zod schema with its type inferred from it (the server validates exactly what the client is typed against), the error codes and their statuses, the room messages, `conversationIDOf`, and the copy signature (`messageCopyMessage`, `signMessageCopy`, `recoverMessageCopySigner`). It re-exports delegated-identity's ownership proof and request envelope (`originPublicKeyPublicationMessage`, `recoverAccount`, `signRequest`, `recoverRequestSigner`). No runtime host.
  - **`@missiv/server`**: the server core, platform-agnostic: `createServer(options)` (a Hono app: `/api/user`, `/api/private`, `/api/public` with the room upgrade, `/api/admin`), the `setup` middleware that recovers a request's signer and its domain user, `RemoteSQLStorage` over `remote-sql`, the numbered migrations (`src/schema/migrations/*.sql`, applied by `migrate(db)`), the `Room` base class and its in-process implementation (`createInProcessRooms`: rooms and rate limiters held in a Map, for one long-lived process), and the push notifier (`createHTTPPushNotifier`, `pushNotifierFromEnv`).
  - **`@missiv/client`**: a Svelte library (`src/lib`, published) plus a demo app (`src/routes`, `src/app`). The library: `API` (typed calls, each signed with delegated-identity's envelope, a refusal thrown as `MissivAPIError` with its status and code), `messages.ts` (what the client trusts: `verifyDomainUser`, `encryptedCopies`, `clearCopies`, `openMessage`), and four stores on one lifecycle (`utils/lifecycle.ts`'s `activeStore`: work only while subscribed, for the registration's current account): `createMissivRegistration`, `openConversationList`, `openOneConversation`, `openRoom`.
- `platforms/*`: per-runtime hosts: **`nodejs`** (`createNodeServer({db, env})`: libSQL, migrated at start, rooms in process on `@hono/node-ws`; the CLI `missiv`), **`bun`** (bun:sqlite with real transactions, rooms in process), **`cf-worker`** (D1, migrated by `wrangler d1 migrations apply` from the same files, rooms and rate limiters as Durable Objects with hibernation).
- `test/*`: cross-cutting tests, `client-server`: the server in process (`app.request` on in-memory libSQL, no port), driven through @missiv/client with real wallets and delegate keys; the client's stores driven the same way, the room through fake sockets wired to an in-process room.

## Configuration (every platform's env)

- `ADMIN_TOKEN`: the bearer token of `/api/admin` (`db-reset`); every admin request is refused when it is unset.
- `SERVER_ORIGIN`: the server's origin as clients address it, which every request signature names; defaults to the request URL's origin (set it behind a proxy that rewrites the host or the scheme).
- `PUSH_SERVER_URL` and `PUSH_TOKENS` (`<domain>=<token>,...`, the tokens push-notification-server issued, held as secrets): a new direct message is pushed to its recipients; a domain without a token sends none.
- `EXPOSE_ERRORS=true`: an internal error's cause and stack go to the caller (never in production).
- `CHAIN_<chainId>`: a chain's JSON-RPC endpoint, for contract-gated rooms.
- nodejs: `DB`, a libSQL URL (`:memory:` by default).

## Trust

The server verifies requests (who may write, as which account, in which domain); the client verifies keys and messages (whose key, whose message). See CONTEXT.md's "untrusted relay" and `docs/adr/0003-the-client-verifies-the-server-relays.md`.

## Two messaging surfaces

missiv has two distinct message paths:

1. **Stored async messaging** (inbox / conversations): the action/response protocol in `@missiv/common` (`ActionSendMessage`, `getConversations`, `acceptConversation`, `rejectConversation`, `unblock`, `markAsRead`, `getMessages`, …), lists and messages by cursor page. A message is one signed copy per member, `encrypted` or `clear`; a `clear` message is the introduction a user asks for, to a recipient with no verified key.
2. **Real-time rooms** (public chat) — the WebSocket `Room` class in `packages/server/src/Room.ts`. Clients connect to `@<domain>` (public) or `@<domain>!<authorization>` (semi-private). The server keeps in-memory `Session`s, buffers a message backlog (last 100) from storage, broadcasts to connected sessions, and enforces a per-IP rate limit.

## Semi-private (contract-gated) rooms

A room name of the form `@<domain>!<authorization>` carries an `authorization` string `chainId:contractAddress:callData:expectedResult`. On a session's login (an `address` message with the delegate key's request signature over the socket's challenge, method `GET` and the room's path), if the room has an authorization the server substitutes the connecting account into `callData` (the `(address)` placeholder), performs an `eth_call` against the chain RPC configured as `CHAIN_<chainId>`, and only marks the session `authorized` (releasing its buffered messages and allowing sends) if the returned value equals `expectedResult`. Access control is therefore contract-defined and public/unencrypted: anyone the contract admits can read and write. (See the room-authorization finding in `work/notes/findings/`.)

## Storage & platform seams

`@missiv/server` talks to storage through the `remote-sql` abstraction (`RemoteSQLStorage`), so each platform supplies its own SQL backend (e.g. libsql for the local/dev and Node paths, Cloudflare's binding on the worker). The `Room` base class defers `getDB` and `getRateLimiter` to the subclass, which the platform adapter provides. Cloudflare's hibernation is handled by serialising socket metadata (`saveSocketData` / `retrieveSocketData`); non-hibernating platforms (Bun) treat those as no-ops.
