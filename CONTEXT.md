# CONTEXT — missiv domain language

The domain glossary for `missiv`. Agents and skills use THIS vocabulary when naming modules, tests, and discussing the system. Architectural rationale lives in `docs/adr/` (decisions); the code-shape overview lives in `docs/architecture.md`; product framing lives in `work/specs/`.

## What missiv is

Missiv is a messaging system for Ethereum accounts. A backend stores messages that clients retrieve; messages are encrypted, but a sender can choose to send a clear-text introductory message to a recipient who has not yet published their public key, so first contact is possible before the recipient is registered. It ships as a pnpm/TypeScript monorepo: shared logic in `@missiv/common`, a `@missiv/server` and `@missiv/client`, and platform adapters for Bun, Cloudflare Workers, and Node.js.

## Core domain terms

- **account**: an Ethereum address (`0x…`, lowercase in missiv); the identity a user messages from and to.
- **delegate key**: the secp256k1 key an app holds for an account (`@etherplay/connect`'s origin account), which signs every request and message so the wallet is asked only once. A **public key** in missiv is a delegate key's public half.
- **ownership proof**: the wallet's EIP-191 signature over the publication message of a delegate key for an **app origin** (the app's scheme, host and port, whose host is the domain). Its text is delegated-identity's `originPublicKeyPublicationMessage`, byte-identical to `@etherplay/connect-core`'s (see `work/notes/findings/publication-message-shared-with-etherplay-connect.md`).
- **registration**: a signed action (`ActionRegisterDomainUser`) publishing a delegate key with its ownership proof and a profile for one domain, making the account reachable with encrypted messages there. One key per account and domain: a newer key replaces the older (**key replacement**), whose messages then become unreadable with the new key.
- **domain user**: an account's registration in one domain (`DomainUser`: its key, its ownership proof and app origin, its profile there). There is no global profile.
- **request signature**: the delegate key's signature over delegated-identity's request envelope (server origin, route, timestamp, body hash), in the `SIGNATURE` header; the server verifies it, derives the caller from the key, and refuses it 60 s off or (on `sendMessage` and `register`) replayed.
- **copy**: one recipient's row of a message (the sender's own copy included), each with its own **copy signature**: the sender's delegate key over `missiv message v1` (domain, namespace, conversation, type, sender, recipient, key, content hash). The server stores it with the sender's ownership proof and never checks either; the reading client does.
- **introductory message**: a `clear` (unencrypted) message, sent only when the user asks (`sendIntroduction`), to reach a recipient with no verified key; contrasts with an `encrypted` message. Never a fallback.
- **conversation**: a message thread between accounts, its `conversationID` derived from the members (`conversationIDOf`: `getConversationID` of the two for two, a hash of the sorted addresses for more), by the server too, which refuses any other; carries an accepted/unaccepted state per member.
- **block**: rejecting a conversation of two blocks its other member in the domain: nothing from them reaches you (no copy, no push) until `unblock`. The sender is not told.
- **inbox**: the stored set of copies a client retrieves for an account, newest first, by page.
- **domain**: the site/context a user is registered under; scopes users, conversations, and rooms.
- **room**: a public-chat channel (WebSocket-based). A room name is `@<domain>` for a public room, or `@<domain>!<authorization>` for a **semi-private room** whose read/write access is gated by an on-chain contract call encoded in the name (contract-gated, NOT encrypted). A room message carries no signature: the server attributes it to the session that sent it. See `docs/architecture.md`.
- **authorization (room)**: the `chainId:contractAddress:callData:expectedResult` string embedded after `!` in a room name; the server runs an `eth_call` (substituting the connecting account) and admits the session only if the result matches (rationale in `docs/adr/0001-contract-gated-room-authorization.md`). A session's identity and authorization are committed together, and every send checks them.
- **untrusted relay**: the core design principle: the missiv server stores and forwards; clients need NOT trust it for keys, authorship or content (only, best-effort, for delivery). The server verifies the **request signature** (who may write, as which account); the client verifies every **ownership proof** before using a key and every **copy signature** before showing a copy, and decrypts each copy on its own into its text or an `unverified` / `undecryptable` error. Rationale and known limits (non-deterministic wallets, no forward secrecy, metadata, rooms): `docs/adr/0003-the-client-verifies-the-server-relays.md`.
- **push**: a new direct message is pushed to each recipient (not the sender, not one who blocked them) through push-notification-server, with the domain's token, naming the sender and the conversation and never the content.
- **load harness**: `test/load` (`pnpm load <send|read|list|room|all>`), many simulated clients with real keys driving a server over HTTP and WebSockets; reports throughput and p50/p95/p99 latency per scenario. Its **API adapter** (`--api`, `src/adapters/`) is one API version's client side (0.5 today): not to be confused with a **platform adapter**, which is a server runtime.
- **platform adapter** — a per-runtime host (`platforms/bun`, `platforms/cf-worker`, `platforms/nodejs`) that wires `@missiv/server` to a concrete storage / server-object / rate-limiter implementation.
- **promptGuidance** — the per-repo NUDGE namespace in `dorfl.json` whose members (currently just `testFirst`) strengthen the wording in the worker's in-band prompt. NOT a gate: the `verify` step is still the only acceptance bar. Omitted ⇒ off; absence is the default.
- **work/ contract** — the on-disk system this repo uses, defined by the reference docs in **`work/protocol/`** (copied here by `setup`): `WORK-CONTRACT.md` (the contract), `CLAIM-PROTOCOL.md`, `REVIEW-PROTOCOL.md`, `task-template.md`, `spec-template.md`, `ADR-FORMAT.md`. Three REGIME umbrellas — `notes/` (capture buckets), `tasks/` (the build board), `specs/` (the spec lifecycle) — plus top-level `questions/` and `protocol/`. One markdown file per item, status = the folder it lives in (never a field). Capture buckets: `notes/ideas/` (proposed), `notes/observations/` (spotted, unverified, append-only), `notes/findings/` (verified external/domain ground truth, each with a `source:`). ADRs (`docs/adr/`, format in `work/protocol/ADR-FORMAT.md`) record what WE decided and why.

## Conventions

Standing per-change rules agents must follow in this repo.

- **Every change requires a changeset.** Run `pnpm changeset` and commit the generated file with your change (this repo uses `@changesets/cli`). For enforcement, wire `changeset status --since=main` into the `dorfl.json` `verify` gate yourself.

## Skills this repo uses

- Required: `setup` (onboarding/migration), `to-spec`, `to-task`.
- Recommended: `review`, `grill-me`.
