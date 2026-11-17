---
title: The API's types are declared twice, every error is a 500, and two client shapes coexist
slug: api-shape-duplicated-and-unversioned
date: 2026-11-17
---

# The API's shape, as a template's dependency would be judged

Seen in the S3 review of origin/main 79fe3ab (from reading).

- **Two sources of truth**: every action is a TypeScript type in `missiv-common` (`packages/common/src/index.ts:10-202`) AND a zod schema in `missiv-server` (`packages/server/src/types.ts:103-237`), kept in step by `Assert<IsZodExactly<...>>` lines (`:239-265`), except `sendMessage`, whose assertion is commented out (`:252`). The response types drifted already: `ConversationMessage` has no `signature` (`common/src/index.ts:105-117`) though `getMessages` returns one (`packages/server/src/storage/RemoteSQLStorage.ts:226`); the backlog task `per-message-signature-over-ciphertext.md` says it "already carries a signature field on read", which is not so.
- **Errors**: every failure, a missing auth included, is an exception mapped to `500` with `code: 5000` (`packages/server/src/index.ts:56-82`); a client cannot tell "not registered" from "server down" without parsing English. The stack is returned when `DEV` is truthy (`:75-76`).
- **Response shapes differ for no reason**: `register` and `editUser` answer `201 {ok, message}` (`api/user/index.ts:53-59,75-81`), `markAsRead` `{success: true}`, `acceptConversation` `{timestampMS}`, the common types declare `ResponseRegisterDomainUser = {timestampMS}` (`common/src/index.ts:174`), which the server never sends.
- **Two clients**: `missiv-server` exports a typed Hono client (`createClient`, `packages/server/src/index.ts:87-90`), unused, while `missiv-client` hand-writes `API` with `any` actions (`packages/client/src/lib/API.ts:50`). `getCompleteUser` has no `type` field (`common/src/index.ts:178-182`, a TODO), unlike every other action.
- **Naming**: RPC-style POST routes under `/api/private` and `/api/user`, no version in the path or a header; `namespace` is required everywhere and explained nowhere (the demo app passes `'default'` with `// TODO remove domain from missiv ?`, `packages/client/src/app/state.ts`).
- **CORS**: `origin: '*'` with `credentials: true` (`index.ts:27-34`), a combination browsers refuse; `/api/public` is mounted before the CORS middleware (`:51-52`).
- **Leftovers**: the `/api/public/ws` echo route (`api/public/index.ts:32-42`, and see `nodejs-platform-cannot-start.md`), `/api/public/` "Hello World!", the Room's usage text naming a `/websocket` endpoint that does not exist (`Room.ts:115-121`), `requireLogin` and a `DEBUG` branch never used (`Room.ts:49,275-277`), `css2ts.cjs` writing to a `src/dashboard/` that does not exist, `handleErrors` commented out in `utils/response.ts`.
- **Unbounded inputs**: no length limit on `content`, names or descriptions, no limit on `messages[]` (`types.ts:161-237`); any registered account can store unlimited clear messages for any address, registered or not; `getMessages` returns a conversation's whole history (`RemoteSQLStorage.ts:206-231`); on bun every room name creates a room kept in memory forever, with an in-memory history never pruned (`platforms/bun/src/cli.ts:356-368,120-189`).

## Suggested direction (not yet decided)

The zod schemas in `missiv-common` as the single source, types inferred from them; typed errors with 400/401/403/404/409/429; one response convention; one client generated from the schemas; a `/v1` prefix; bounds on every string and array; pagination by cursor.
