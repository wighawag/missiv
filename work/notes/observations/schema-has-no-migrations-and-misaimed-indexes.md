---
title: The schema has no migrations, two indexes that serve no query, and none for the conversation list
slug: schema-has-no-migrations-and-misaimed-indexes
date: 2026-11-17
---

# The SQL schema and how it is applied

Seen in the S3 review of origin/main 79fe3ab (from reading).

- **No migrations**: the schema is `CREATE TABLE IF NOT EXISTS` (`packages/server/src/schema/sql/01_users.sql`, `02_conversations.sql`) applied by `storage.setup()` (`packages/server/src/storage/RemoteSQLStorage.ts:416-424`), on cf-worker by hand (`platforms/cf-worker/package.json` `init:db`). A column change reaches no existing database; the only other path is `reset()`, which drops everything (`:425-437`). The e2e drift (`end-to-end-tests-failing-drift.md`) is the same problem seen from the tests.
- **Indexes**: `idx_DomainUsers_publicKey` duplicates the `UNIQUE(publicKey)` index (`01_users.sql:20,24`); `idx_conversation_participants_participant` is the primary key again (`02_conversations.sql:57,62`); `idx_conversations_lastmessage` puts `conversationID` before `lastMessage` (`:41`), so it cannot serve `ORDER BY lastMessage`. The conversation-list queries filter `ConversationParticipants` by `(domain, namespace, user)` (`RemoteSQLStorage.ts:354-414`), which no index starts with.
- **Unused columns**: `DomainUsers.settings`, `Conversations.name`; `Messages.message` is a JSON blob holding `senderPublicKey`, `toPublicKey`, `signature`, `messageType` (`RemoteSQLStorage.ts:88-94,310-316`), so none of them is queryable, and the schema comment still says `TODO : senderPublicKey` (`02_conversations.sql:13`).
- **Conversation status** is an integer with its meaning in comments (`02_conversations.sql:55`), and the API exposes only `accepted: boolean` with `// TODO enum` (`packages/common/src/index.ts:52`).
- **The SQL splitter** strips comments with `/(\/\*[^*]*\*\/)|(\/\/[^*]*)|(--[^.].*)/gm` (`packages/server/src/storage/utils.ts:43`): `//` eats up to the next `*` across lines, and a comment starting `--.` survives. It works on today's files by the order of alternatives.
- `packages/server/src/schema/model.erd` (1093 lines) was last touched by a `wip` commit (a8a3e7b).
- `messageID = Date.now() * 1000 + random(1000)`: already `messageid-collision-risk.md`.

## Suggested direction (not yet decided)

Numbered migration files applied through one `migrate()` every platform calls (and cf-worker through wrangler's D1 migrations from the same files), indexes for the queries that exist, and the JSON blob's fields as columns.
