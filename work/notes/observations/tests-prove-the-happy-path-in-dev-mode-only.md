---
title: The tests run only with DEV backdoors, a fixed conversationID and a fake key; nothing tests rooms, stores or platforms
slug: tests-prove-the-happy-path-in-dev-mode-only
date: 2026-11-17
---

# What missiv's tests prove

Measured in the S3 review of origin/main 79fe3ab on 2026-11-17 (Node 24, pnpm 11.25; the `pnpm build` and `pnpm test` scripts could not run because of the pnpm 11 install error below, so the packages were built and tested by calling their binaries directly).

- `packages/server` 1 test, passes: one registration with the all-zero signature and `FAKE:` auth, one send (`packages/server/src/index.test.ts`).
- `test/client-server` 7 tests, pass in 0.12 s, port-free: the conversation lifecycle (request, accept, unread, group, types, reject). Every call but registration uses `FAKE:` auth, every conversation is `'1'` or a literal, every `toPublicKey` is `'0xff'`, every message is clear (`test/client-server/test/setup.ts:71,102,122,136`). So they pass against the behaviours in `send-message-trusts-client-conversation-id.md` and would pass unchanged if the transport signature were never checked.
- `packages/client` 1 test, `expect(1 + 2).toBe(3)` (`src/demo.spec.ts`); svelte-check 1 error (`src/routes/+page.svelte:120`, the demo app's type) and 4 warnings.
- `test/end-to-end`: not run here (it needs bun, which this machine lacks, and port 2001). Its server instance is named `fuzd` (`test/end-to-end/test/prool/node-instances.ts:4`), and `src/cli.ts:10` calls a `room/:name/websocket` route that does not exist. Its drift is `end-to-end-tests-failing-drift.md`.
- Nothing tests: the Room (rooms, login, authorization, rate limit), any platform adapter, the transport signature with a real key on a non-registration route, the client's stores, encryption end to end, or a production (non-DEV) configuration.
- **The verify gate** (`dorfl.json`: `pnpm -r format:check && pnpm build && pnpm test`): `pnpm -r` skips the root (whose `format:check` needs a prettier the root does not install), `platforms/bun` has no `format:check` and fails prettier on 2 files, `packages/client` names its check `lint`.
- **pnpm 11**: `pnpm install` ends with `ERR_PNPM_IGNORED_BUILDS` (`@parcel/watcher`, `esbuild` x4, `sharp`, `workerd`), warns that the `pnpm.onlyBuiltDependencies` field of `package.json` is no longer read, and writes an `allowBuilds:` block with placeholder values into `pnpm-workspace.yaml`; every later `pnpm run` re-runs the install check and fails the same way.

## Suggested direction (not yet decided)

Tests that run with `DEV` unset as the default harness (and DEV-only paths tested to REFUSE there), real keys on every route, a Room test on fake sockets (the review's probe in `gated-room-accepts-writes-without-authorization.md` is the shape), one contract test per platform through `app.request`, and the client's stores driven against the in-process server.
