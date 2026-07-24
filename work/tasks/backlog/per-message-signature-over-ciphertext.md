---
title: Per-message signature over the (encrypted) payload, verified client-side
slug: per-message-signature-over-ciphertext
blockedBy: []
covers: []
---

## What to build

Change the message-send model so the sender's authorship signature is **per message** and computed **over the payload as stored** (the `content` the server holds: ciphertext in the `encrypted` case, plaintext in the `clear` case), instead of the current single top-level `action.signature` that is copied verbatim onto every stored message.

Motivation (the decided design): the recipient (or any relaying party) must be able to attribute a message to its sender **without decrypting it** — verify the signature against the stored `content` + the message's `senderPublicKey`. A single signature cannot legitimately cover N differently-addressed messages, so today's top-level field is semantically wrong for a multi-recipient send.

**Two DISTINCT signatures — do not conflate them:**

1. **Transport/request signature** (the `SIGNATURE` HTTP header, verified in `setup.ts` via `recoverPublicKey(header, rawBody)` → `getDomainUserByPublicKey` → `account`). The server DOES verify this and it STAYS: it is what guarantees a caller can only send AS its own account (the `sender` is DERIVED from it, never taken from the body). This task does NOT touch it.
2. **Per-message CONTENT signature** (this task): stored with each message, returned by `getMessages`, proves authorship of the payload to a future reader. The server does NOT verify this — the recipient CLIENT does (ideally without decrypting). missiv is a minimal untrusted relay: it is not trusted for message authorship, only (best-effort) for delivery.

So this task moves the CONTENT signature into each message and makes the CLIENT produce and check it; it does NOT add server-side verification of the content signature, and it leaves the transport-signature auth in `setup.ts` exactly as-is.

Recommended signature preimage: bind both the ciphertext and the intended recipient, e.g. sign `keccak(content) || toPublicKey` (or an equivalent domain-separated digest), so a stored ciphertext row cannot be replayed against a different recipient. Confirm the exact preimage while implementing and record it (it is protocol-defining).

Thin end-to-end path: `missiv-common` type/schema → server storage shape → client send (sign per message) → client read/verify → the end-to-end tests.

### Concretely
- **`missiv-common` (`ActionSendMessageBase`) + server `ActionSendMessageSchema`:** move `signature` from the top-level action INTO each `messages[]` entry (`{to, toPublicKey, content, signature}`); drop the top-level `signature`. Keep the `encrypted`/`clear` discriminated union.
- **Server storage (`RemoteSQLStorage.sendMessage`):** store each message's own `signature` (from `message.signature`) instead of the shared `action.signature`. No verification added. `ConversationMessage` already carries a `signature` field on read, so `getMessages` continues to return it for the client to check.
- **Client (`packages/client` `conversation/index.ts` `sendMessage`):** replace the hardcoded fake `signature = '0x00…'` / `// TODO = signMessage(text)` with a real per-message signature over the stored `content` (ciphertext for `encrypted`, plaintext for `clear`), for BOTH recipient entries. Add the client-side VERIFY step on read (in the message-consuming path) so a message with a bad/mismatched signature is surfaced/rejected by the client.
- **Tests (`test/end-to-end/test/full-conversation-flow.test.ts`):** currently already put `signature` inside each `messages[]` entry (with `FAKE_SIG`) and omit the top-level one — i.e. they assume THIS shape, which is why they currently fail Zod validation against the old schema. Once the schema moves `signature` into `messages[]`, align these tests (real or fake-in-dev signature per message) so they pass, and add an assertion that the client rejects a message whose signature does not verify.

## Acceptance criteria

- [ ] `signature` lives on each `messages[]` entry in both the `missiv-common` type and the server zod schema; the top-level `action.signature` is gone.
- [ ] `RemoteSQLStorage.sendMessage` stores each message's own signature; the value is still returned by `getMessages` (via `ConversationMessage.signature`).
- [ ] The client (`conversation/index.ts`) signs each message over its stored `content` (+ recipient binding) for both `clear` and `encrypted` sends, replacing the fake `0x00…` placeholder.
- [ ] The client VERIFIES a message's signature on read (against stored `content` + `senderPublicKey`) WITHOUT needing to decrypt, and surfaces/rejects a message that fails.
- [ ] The server adds NO verification of the per-message CONTENT signature (relay stays untrusted-for-authorship); this is explicit, not an oversight. The existing TRANSPORT-signature auth in `setup.ts` (caller can only send as its own account) is left intact.
- [ ] `test/end-to-end/test/full-conversation-flow.test.ts` passes against the new shape, plus a test that a tampered/invalid signature is rejected client-side.
- [ ] `pnpm -r format:check && pnpm build && pnpm test` is green.

## Blocked by

- None — can start immediately.

## Prompt

> Change missiv's message-send signature model from a single top-level `action.signature` (currently duplicated onto every stored message and never checked) to a PER-MESSAGE signature computed over the payload AS STORED — ciphertext for `messageType: 'encrypted'`, plaintext for `'clear'`. The decided design: the recipient/relay must attribute a message to its sender WITHOUT decrypting it, by verifying the signature against the stored `content` + `senderPublicKey`. Bind the recipient into the preimage (e.g. sign `keccak(content) || toPublicKey`) so a ciphertext row can't be replayed against another recipient; confirm and RECORD the exact preimage (it is protocol-defining — if it clears the bar in `work/protocol/ADR-FORMAT.md`, write an ADR).
>
> CRITICAL CONSTRAINT: there are TWO distinct signatures. (a) The TRANSPORT/request signature (the `SIGNATURE` HTTP header) is verified by the server in `setup.ts` to derive the caller's account — this is what stops a caller sending as someone else, and it STAYS untouched. (b) The PER-MESSAGE CONTENT signature (this task) is NOT verified by the server — the recipient CLIENT verifies it. Do not add server-side verification of the content signature, and do not remove or weaken the transport-signature auth. missiv is a minimal relay untrusted for authorship, not an unauthenticated one.
>
> Where to work (by concept, verify against current code): the action type in `missiv-common` (`ActionSendMessageBase`) and the matching `ActionSendMessageSchema` in `packages/server/src/types.ts` — move `signature` from the action into each `messages[]` entry, drop the top-level one, keep the encrypted/clear discriminated union. `RemoteSQLStorage.sendMessage` (`packages/server/src/storage`) — store `message.signature` per message instead of the shared `action.signature`; add NO verification; `getMessages` already returns `signature` via `ConversationMessage`. Client `packages/client/src/lib/conversation/index.ts` `sendMessage` — replace the hardcoded `signature = '0x00…'` placeholder with a real per-message signature for both recipient entries, for both clear and encrypted paths; add a client-side verify-on-read step that rejects a message whose signature doesn't match. Tests: `test/end-to-end/test/full-conversation-flow.test.ts` already assumes per-`messages[]` signatures (with `FAKE_SIG`) and no top-level one — align it to the new schema so it passes, and add a tampered-signature rejection test.
>
> Domain vocabulary is in `CONTEXT.md`; the drift/diagnosis that motivated this is in `work/notes/observations/end-to-end-tests-failing-drift.md`. Follow the repo convention: add a changeset (`pnpm changeset`). Record any non-obvious in-scope decision durably and link it from the done record.

---

### Claiming this task

```sh
dorfl claim per-message-signature-over-ciphertext --arbiter origin
git fetch origin && git switch -c work/per-message-signature-over-ciphertext origin/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/per-message-signature-over-ciphertext.md work/tasks/done/per-message-signature-over-ciphertext.md
```
