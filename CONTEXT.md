# CONTEXT — missiv domain language

The domain glossary for `missiv`. Agents and skills use THIS vocabulary when naming modules, tests, and discussing the system. Architectural rationale lives in `docs/adr/` (decisions); the code-shape overview lives in `docs/architecture.md`; product framing lives in `work/specs/`.

## What missiv is

Missiv is a messaging system for Ethereum accounts. A backend stores messages that clients retrieve; messages are encrypted, but a sender can send a clear-text introductory message to a recipient who has not yet published their public key, so first contact is possible before the recipient is registered. It ships as a pnpm/TypeScript monorepo: shared logic in `missiv-common`, a `missiv-server` and `missiv-client`, and platform adapters for Bun, Cloudflare Workers, and Node.js.

## Core domain terms

- **account** — an Ethereum address (`0x…`); the identity a user messages from and to.
- **public key** — the key a user publishes (via a signed registration message) so others can encrypt messages to them. Until it is published, only clear-text intro messages can reach that account.
- **registration** — a signed action (`ActionRegisterDomainUser`) that associates an account + public key with a domain, making the account reachable with encrypted messages.
- **introductory message** — a `clear` (unencrypted) message a sender may send to an unregistered recipient to make first contact; contrasts with an `encrypted` message.
- **conversation** — a message thread between accounts, keyed by a deterministic `conversationID` derived from the participating addresses; carries accepted/unaccepted state.
- **inbox** — the stored set of messages a client retrieves for an account.
- **domain** — the site/context a user is registered under; scopes users, conversations, and rooms.
- **room** — a public-chat channel (WebSocket-based). A room name is `@<domain>` for a public room, or `@<domain>!<authorization>` for a **semi-private room** whose read/write access is gated by an on-chain contract call encoded in the name (contract-gated, NOT encrypted). See `docs/architecture.md`.
- **authorization (room)** — the `chainId:contractAddress:callData:expectedResult` string embedded after `!` in a room name; the server runs an `eth_call` (substituting the connecting account) and admits the session only if the result matches (rationale in `docs/adr/0001-contract-gated-room-authorization.md`).
- **untrusted relay** — a core design principle: the missiv server is a deliberately minimal store-and-forward relay that clients need NOT trust for message AUTHORSHIP or content integrity (only, best-effort, for delivery). Two distinct signatures keep this honest: (1) the **transport/request signature** (the `SIGNATURE` HTTP header, over the raw request body) that the server DOES verify to derive the caller's account, so a caller can only send AS itself — real API auth against impersonation; and (2) the **per-message content signature** (stored with each message, returned by `getMessages`) that the server does NOT verify — the recipient CLIENT verifies it (ideally without decrypting). The server stores and delivers opaque (often encrypted) payloads it does not read or vouch for the authorship of.
- **platform adapter** — a per-runtime host (`platforms/bun`, `platforms/cf-worker`, `platforms/nodejs`) that wires `missiv-server` to a concrete storage / server-object / rate-limiter implementation.
- **promptGuidance** — the per-repo NUDGE namespace in `dorfl.json` whose members (currently just `testFirst`) strengthen the wording in the worker's in-band prompt. NOT a gate: the `verify` step is still the only acceptance bar. Omitted ⇒ off; absence is the default.
- **work/ contract** — the on-disk system this repo uses, defined by the reference docs in **`work/protocol/`** (copied here by `setup`): `WORK-CONTRACT.md` (the contract), `CLAIM-PROTOCOL.md`, `REVIEW-PROTOCOL.md`, `task-template.md`, `spec-template.md`, `ADR-FORMAT.md`. Three REGIME umbrellas — `notes/` (capture buckets), `tasks/` (the build board), `specs/` (the spec lifecycle) — plus top-level `questions/` and `protocol/`. One markdown file per item, status = the folder it lives in (never a field). Capture buckets: `notes/ideas/` (proposed), `notes/observations/` (spotted, unverified, append-only), `notes/findings/` (verified external/domain ground truth, each with a `source:`). ADRs (`docs/adr/`, format in `work/protocol/ADR-FORMAT.md`) record what WE decided and why.

## Conventions

Standing per-change rules agents must follow in this repo.

- **Every change requires a changeset.** Run `pnpm changeset` and commit the generated file with your change (this repo uses `@changesets/cli`). For enforcement, wire `changeset status --since=main` into the `dorfl.json` `verify` gate yourself.

## Skills this repo uses

- Required: `setup` (onboarding/migration), `to-spec`, `to-task`.
- Recommended: `review`, `grill-me`.
