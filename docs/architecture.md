# missiv architecture (code-shape overview)

A description of how missiv's own code is laid out. This is current-truth about OUR code (it changes as the code changes); external ground-truth we integrate with lives in `work/notes/findings/`, and decisions-with-rationale live in `docs/adr/`.

## Monorepo layout

A pnpm workspace (`pnpm-workspace.yaml`) with three groups:

- `packages/*`
  - **`missiv-common`** — shared TypeScript types and pure helpers used by both client and server (the action/response protocol shapes, `Conversation` / `ConversationMessage` / user types, and helpers like `getConversationID`, `originPublicKeyPublicationMessage`, `fromDomainToOrigin`). No runtime host; just types + functions.
  - **`missiv-server`** — the server core: request handling, the `Room` server-object base class, storage over `remote-sql`, a rate limiter, signature recovery, and SQL-schema-to-TS generation (`sql2ts`). Platform-agnostic; concrete DB / server-object / rate-limiter are injected by a platform adapter.
  - **`missiv-client`** — the client (SvelteKit app + library).
- `platforms/*` — per-runtime hosts that instantiate the server against a concrete runtime: **`bun`**, **`cf-worker`** (Cloudflare Workers, uses Durable-Object-style hibernation), **`nodejs`**.
- `test/*` — cross-cutting tests: `client-server` and `end-to-end`.

## Two messaging surfaces

missiv has two distinct message paths:

1. **Stored async messaging** (inbox / conversations) — the action/response protocol in `missiv-common` (`ActionSendMessage`, `getConversations`, `acceptConversation`, `markAsRead`, …). Messages are `encrypted` or `clear`; a `clear` message is the introductory-message path to an unregistered recipient.
2. **Real-time rooms** (public chat) — the WebSocket `Room` class in `packages/server/src/Room.ts`. Clients connect to `@<domain>` (public) or `@<domain>!<authorization>` (semi-private). The server keeps in-memory `Session`s, buffers a message backlog (last 100) from storage, broadcasts to connected sessions, and enforces a per-IP rate limit.

## Semi-private (contract-gated) rooms

A room name of the form `@<domain>!<authorization>` carries an `authorization` string `chainId:contractAddress:callData:expectedResult`. On a session's login (`address` message with a valid signature over the server challenge), if the room has an authorization the server substitutes the connecting account into `callData` (the `(address)` placeholder), performs an `eth_call` against the chain RPC configured as `CHAIN_<chainId>`, and only marks the session `authorized` (releasing its buffered messages and allowing sends) if the returned value equals `expectedResult`. Access control is therefore contract-defined and public/unencrypted — anyone the contract admits can read and write. (See the room-authorization finding in `work/notes/findings/`.)

## Storage & platform seams

`missiv-server` talks to storage through the `remote-sql` abstraction (`RemoteSQLStorage`), so each platform supplies its own SQL backend (e.g. libsql for the local/dev and Node paths, Cloudflare's binding on the worker). The `Room` base class defers `getDB` and `getRateLimiter` to the subclass, which the platform adapter provides. Cloudflare's hibernation is handled by serialising socket metadata (`saveSocketData` / `retrieveSocketData`); non-hibernating platforms (Bun) treat those as no-ops.
