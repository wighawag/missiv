---
title: The bun SQL adapter's batch runs async statements inside a synchronous bun:sqlite transaction, so it is not atomic
slug: bun-batch-is-not-a-transaction
date: 2026-11-17
---

# RemoteBunSQL.batch commits before its statements have all run

Seen in the S3 review of origin/main 79fe3ab (from reading; bun is not installed on the review machine, so not run).

`platforms/bun/src/remote-sql-bun/index.ts:37-47` wraps an `async` callback in `this.client.transaction(...)`. `bun:sqlite` transactions are synchronous: the wrapper runs `BEGIN`, calls the callback, and `COMMIT`s when it returns. An async callback returns its promise at the first `await`, so only the first statement runs inside the transaction; the rest run after the commit. `sendMessage`'s batch (the conversation, each participant, each message: `packages/server/src/storage/RemoteSQLStorage.ts:277-332`) and `register`'s (`:132-144`) are therefore not atomic on bun, and a failure halfway (the messageID collision of `messageid-collision-risk.md`, for one) leaves a half-written send.

## Suggested direction (not yet decided)

Run the statements synchronously inside the transaction (`statement.query.all(...args)` directly), and give every `RemoteSQL` adapter one shared contract test (a batch whose last statement fails leaves nothing behind).
