---
title: end-to-end tests fail — drifted from the current zod schema / domain-origin logic
slug: end-to-end-tests-failing-drift
date: 2026-07-24
---

# end-to-end tests fail (drift, not a server regression)

`pnpm --filter missiv-test-end-to-end test` fails 5 of 6 tests. `secp256k1.test.ts` (raw crypto) passes; the API-level tests fail. Both failure classes are the TESTS being out of sync with the current server schema / signing logic (the schema was reworked in `6ad7b8d "use zod instead of typia"`, `test/end-to-end/test/` last meaningfully updated in `2b4dfab`/`29a8ee5`), NOT a server bug. Diagnosed during `setup`; verify + decide the fix direction before acting.

## Failure 1 — `register.test.ts`: `no matching address from signature`

The test signs the delegation message for origin `https://test.com`:

```
originPublicKeyPublicationMessage('https://test.com', delegatePublicKey)   // setup.ts + register.test.ts
```

but calls `register` with `domain: 'test'`. The server (`packages/server/src/api/user/index.ts` `/register`) reconstructs the signed message from the domain via `fromDomainToOrigin(action.domain)`:

- `fromDomainToOrigin('test')` → `'https://test'` (no `.com`), because `'test'` is neither `https://…` nor `localhost`.

So the server verifies against origin `https://test`, the signature was over `https://test.com` → different message → different recovered address → `address != action.address` → thrown error (the error string literally shows `Origin: https://test`).

**FIXED (2026-07-24):** `register.test.ts` now sends `domain: 'test.com'` (matching what it signed) for both the `register` and the `getCompleteUser` lookup; the test passes. Corroboration: `full-conversation-flow.test.ts` already used `domain: 'test.com'` and its `register` calls succeed.

## Failure 2 — `full-conversation-flow.test.ts`: `ZodError: signature Required` on path `["signature"]`

The `register` calls here succeed (domain `'test.com'` matches). The 4 failures are all on `api.sendMessage`. The current `ActionSendMessageSchema` (`packages/server/src/types.ts`) — and the canonical `ActionSendMessageBase` type in `missiv-common` — require:

- a **top-level** `signature: String0x` on the sendMessage action, AND
- `messages[]` items shaped `{to, toPublicKey, content}` only (NO per-message `signature`).

But the test sends the inverse: a per-message `signature: FAKE_SIG` inside each `messages[]` entry and **no top-level `signature`**. Zod rejects it for the missing required top-level `signature`.

**DECIDED (2026-07-24) → captured as a task.** Direction: per-message signature over the STORED payload (ciphertext for `encrypted`, plaintext for `clear`), verified CLIENT-side only (missiv is a minimal untrusted relay; the server does not check signatures). The failing tests already assume the per-`messages[]` signature shape, so they pass once the schema moves `signature` into `messages[]` and drops the top-level one. See `work/tasks/backlog/per-message-signature-over-ciphertext.md`. (Note `conversationID: '1'` is still hardcoded with a `// TODO not specified` comment; out of scope for that task.)

## Suggested next step

Route this to a task once the direction is decided (fix the tests to match the current schema, vs change the schema to match intended behaviour). Until then the `verify` gate's `pnpm test` step is red for a pre-existing reason unrelated to the contract onboarding.
