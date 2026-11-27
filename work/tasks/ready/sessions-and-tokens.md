---
title: Sessions opened with one Ed25519 signed request, then HMAC tokens on every request
slug: sessions-and-tokens
spec: scalable-direct-messaging
blockedBy: [messaging-keys-and-registration]
covers: [5, 6]
---

## What to build

`POST /session {domain}` (ADR-0006, "Sessions and replay"): a `delegated-identity` Ed25519 signed request; the server finds the account whose current key set in that domain has the signing key and returns `{token, expiresAt, keyRef}`. The signed request is remembered for its 60 s window and a second use refused (a replay would hand out a token). Token: base64url `{account, domain, keyRef, exp}` + HMAC-SHA256 with `SESSION_SECRET` (env, required; `SESSION_SECRET_PREVIOUS` also accepted, for rotation), about an hour.

The `setup` middleware authenticates from `Authorization: Bearer <token>` with no signature check and no database read on every route EXCEPT `register` (proves itself) and `sendMessage`, which keeps its Ed25519 request signature and `refuseReplay` until `sqlite-conversation-store-and-api` replaces it with the message signature. `@missiv/client`'s `API` opens and renews sessions transparently. Room login is unchanged here (spec `scalable-rooms`). Document the new env in `docs/architecture.md`.

## Acceptance criteria

- [ ] A request with a valid token is authenticated without a database read (asserted, e.g. with a counting DB wrapper)
- [ ] Expired, tampered, wrong-domain and wrong-secret tokens are refused with `unauthenticated`; a token signed with the previous secret is accepted while configured
- [ ] A replayed `/session` request within its window is refused
- [ ] Sending still works (request signature + replay check) and the client-server tests pass
- [ ] The server refuses every authenticated route when `SESSION_SECRET` is unset, like `ADMIN_TOKEN`
- [ ] The client renews a session before it expires and retries once on `unauthenticated`

## Blocked by

- messaging-keys-and-registration

## Prompt

Implement ADR-0004 decision 5 and ADR-0006's "Sessions and replay". The per-request check is the `setup` middleware in `@missiv/server`; `refuseReplay` and its table are the replay store to reuse for `/session`. Compare tokens in constant time (the server's utils have a timing-safe helper).

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code, `work/tasks/done/`, ADR-0003/0004/0005/0006 and the tasks it depends on? If a dependency landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record) and link them. Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim sessions-and-tokens --arbiter <remote>
git fetch <remote> && git switch -c work/sessions-and-tokens <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/sessions-and-tokens.md work/tasks/done/sessions-and-tokens.md
```
