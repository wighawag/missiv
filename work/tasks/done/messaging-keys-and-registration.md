---
title: missiv on the new identity: key sets registered, every signer on Ed25519, 0.5 messages on the new keys
slug: messaging-keys-and-registration
spec: scalable-direct-messaging
blockedBy: [load-harness]
covers: [2, 3, 4]
---

## What to build

Prerequisites in other repos (not expressible in `blockedBy`): `delegated-identity` 0.2.0 (its spec `ed25519-keys-in-the-publication`: the publication naming an Ed25519 signing key and an X25519 encryption key, `deriveKeySet`, `keySetRef`, the Ed25519 request envelope and its verifiers) and `@etherplay/connect` 0.19.0 with `@etherplay/connect-core` 0.8.0 (its plan `plans/ed25519-keys-in-the-publication.md`: the key set and the new publication signature on the account). Check with `npm view delegated-identity@0.2.0 version` and `npm view @etherplay/connect@0.19.0 version`; if either prints nothing, stop and route the task to needs-attention.

Move ALL of missiv onto the new identity in one step, keeping 0.5's message model (per-copy storage) so `verify` stays green; the format itself changes in `one-ciphertext-message-format` and `sqlite-conversation-store-and-api`:

- **Directory**: a 0.6 schema (an empty database: replace the migrations, as 0.4 did): per (user, domain) the current key set (Ed25519 and X25519 public keys, the ownership signature, the app origin, `keyRef` from `keySetRef`), replaced key sets kept by `(domain, keyRef)`. `register` (a signed request carrying account, domain, app origin, the key set and the ownership signature) verified with `delegated-identity`, refusing a key set registered for another (user, domain); its replay protection stays (`refuseReplay`). `getDomainUser` returns the current key set; `getKeySet {domain, keyRef}` returns any registered one (ADR-0006).
- **Every signer**: the server's `setup` middleware, `@missiv/client`'s `API`, the room login (the challenge signed as an Ed25519 request, `Room`'s login and the client room store) and the demo app's registration flow, all on `delegated-identity`'s Ed25519 envelope; missiv's re-exports of the old secp256k1 publication and request helpers removed from `@missiv/common`.
- **0.5 messages on the new keys (interim)**: each copy signed with the sender's Ed25519 key and encrypted under the X25519 agreement of the two key sets (keeping today's per-copy shape and cipher); replaced by the next format task.
- **Client**: `createMissivRegistration` takes the key set, its private keys and the ownership signature from connect's account; `verifyDomainUser` verifies a key set against the wallet with `delegated-identity`.

## Acceptance criteria

- [ ] Registration refuses an ownership signature that does not recover the account for the key set and app origin, a key set registered for another (user, domain), a request not signed by the key set's Ed25519 key, and a replayed registration
- [ ] Two devices of one account (one origin key) register the same key set
- [ ] No secp256k1 request signature, publication or copy signature remains in missiv (server, client, demo app); missiv carries no copy of the publication or the derivation
- [ ] `getDomainUser` and `getKeySet` return the current and a replaced key set
- [ ] Every existing client-server test passes on the new identity, the room tests included (login and send)
- [ ] Tests cover the new behaviour (mirror the repo's existing test style)

## Blocked by

- load-harness

## Prompt

Implement ADR-0004 decision 1 on missiv's side (`docs/adr/0004-messaging-keys-one-ciphertext-server-checked-signatures.md`; API names in ADR-0006). Context: `work/notes/findings/shared-identity-across-services.md`. Signers today: the server's `setup` middleware, `@missiv/client`'s `API`, `Room`'s login and the client room store, the demo app's registration flow; the ownership proof is re-exported by `@missiv/common` from `delegated-identity`.

FIRST, check this task against current reality (it is a launch snapshot and may have drifted): does it still match the code, `work/tasks/done/`, ADR-0003/0004/0005/0006 and the tasks it depends on? If a dependency landed differently than assumed, route the task to needs-attention with the discrepancy instead of building on a stale premise.

RECORD non-obvious in-scope decisions you make while building (an ADR in `docs/adr/` if it meets the ADR gate in `work/protocol/ADR-FORMAT.md`, otherwise a JSDoc at the choice site or a `## Decisions` block for the done record) and link them. Update `docs/architecture.md` and `CONTEXT.md` where this task changes what they describe.

Command cost: bound exploratory shell commands (`timeout 30`, cap output with `head`), never run an unbounded regex over minified, bundled or generated files, and never `grep -r` through `node_modules`, `dist` or `.git`.

Done means: the acceptance criteria hold and `dorfl.json`'s `verify` passes (`pnpm check:packaging && pnpm format:check && pnpm build && pnpm test`).

---

### Claiming this task

```sh
dorfl claim messaging-keys-and-registration --arbiter <remote>
git fetch <remote> && git switch -c work/messaging-keys-and-registration <remote>/main
# on completion, in the work branch's PR/merge:
git mv work/tasks/ready/messaging-keys-and-registration.md work/tasks/done/messaging-keys-and-registration.md
```

## Decisions

Each is recorded with its alternatives in `work/notes/observations/2026-11-27-messaging-keys-and-registration-decisions.md`, plus JSDoc or SQL comments at the code they govern. Please link that note from the done record.
1. The migration is a new file (`0001_v0_6.sql`) rather than an edit of `0001_initial.sql`, so a 0.5 database fails loudly at start instead of running on the wrong schema.
2. Both the signing key and the encryption key are unique across all (user, domain) pairs, so even the same account registering its key set in another domain gets 409.
3. Message rows store `senderKeyRef` and the read joins `KeySets`, so the sender's key set and proof still arrive inline with each message.
4. The interim copy format changes its labels to `missiv message copy v2` and `missiv encrypted v2`. As the task asked, the cipher (xchacha20poly1305) and the keccak hashing stay the same.
5. Wire field names follow delegated-identity: `keySet`, `ownershipSignature`, `keyRef`. Until the next format task, `toPublicKey`/`recipientPublicKey` keep their names but now hold the X25519 key, and `APIOptions.privateKey` now holds the Ed25519 signing key.
6. The client account uses connect's own field names, so connect's account can be passed straight in.
7. New refusal: a registration whose request is signed by a key other than the key set's own is 403.
8. `@missiv/common` re-exports only the two delegated-identity types.
9. `verifyKeySet` also checks that `keyRef` matches `keySetRef(keySet)`.
10. connect 0.19 requires a chain, so the demo app now names Ethereum mainnet with a public RPC. The demo never transacts on it.

**Limitations (in the same note):**
- Ed25519 signatures are deterministic. If two devices send byte-identical registrations in the same millisecond, the second is refused as a replay (409), even though its key set is already registered.
- The load harness's `0.5` adapter now uses the new keys, so a run today can't be compared with the secp256k1 baseline in `load-baseline-0-5.md`.
