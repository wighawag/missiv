---
title: One ciphertext per message: the missiv message format, pairwise-v1 encryption and its verification
slug: one-ciphertext-message-format
spec: scalable-direct-messaging
blockedBy: [messaging-keys-and-registration]
covers: [7, 8, 11, 12, 26]
---

## What to build

In `@missiv/common`: the `Message` type and zod schema, the signing payload and `pairwise-v1` exactly as ADR-0006 "The message" specifies (newline-free validated fields, the content by its SHA-256; HKDF-SHA256 per-message key from the X25519 shared secret, AES-256-GCM with a random 96-bit IV and the scope as associated data; keyID = the two keyRefs sorted). Ed25519 through `delegated-identity`'s key module. One cipher module using WebCrypto when `crypto.subtle` exists and `@noble/ciphers` / `@noble/hashes` otherwise (plain-http origins have no `crypto.subtle`). No XChaCha and no keccak in messaging (`conversationIDOf`'s keccak form for more than two members stays, unused while groups are refused).

In `@missiv/client`: compose (encrypt + sign) and `openMessage` (fetch the sender's key set by `senderKeyRef` through `getKeySet`, verify it against its ownership signature, verify the signature, decrypt) returning text or `unverified` / `undecryptable` as today. The server-side store and API changes are `sqlite-conversation-store-and-api`; this task is the format, its crypto and the client functions, with test vectors.

## Acceptance criteria

- [ ] Test vectors for the signing payload, the signature and `pairwise-v1` (both members decrypt the same ciphertext), identical through WebCrypto and through the JS fallback
- [ ] A message moved to another conversation, namespace, domain or messageID, or with changed content, fails verification
- [ ] A ciphertext under another keyID is `undecryptable`, not a thrown error
- [ ] The format's JSDoc states how a later scheme reuses `scheme` + `keyID`
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- messaging-keys-and-registration

## Prompt

Implement ADR-0004 decisions 2 and 3 and the format half of decision 4, to ADR-0006's "The message". Today's per-copy format is `packages/common/src/message-signature.ts` and the client's `messages.ts` (`encryptedCopies`, `clearCopies`, `openMessage`), as left on the new keys by `messaging-keys-and-registration`.

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code, `work/tasks/done/`, ADR-0003/0004/0005/0006 and the tasks it depends on? If a dependency landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record) and link them. Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim one-ciphertext-message-format --arbiter <remote>
git fetch <remote> && git switch -c work/one-ciphertext-message-format <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/one-ciphertext-message-format.md work/tasks/done/one-ciphertext-message-format.md
```

## Decisions

The builder recorded its in-scope decisions in a separate note; see:

- [2026-11-27-one-ciphertext-message-format-decisions.md](../../notes/observations/2026-11-27-one-ciphertext-message-format-decisions.md)
