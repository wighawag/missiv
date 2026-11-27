---
'@missiv/common': minor
'@missiv/server': minor
'@missiv/client': minor
---

A switchable inbox transport: direct messages can be delivered on the live inbox socket (as before) or by polling a cheap "changed since", and a client in `auto` falls back from one to the other.

- `@missiv/common`: the inbox version, `Conversation.version` (the version at which the row last changed), `INBOX_CHANGES_PATH`, `INBOX_TRANSPORTS`, `ActionInboxChangesSchema` and `ResponseInboxChanges` (`{version, unchanged: true}` or `{version, conversations, hasMore}`).
- `@missiv/server`: `POST /api/inbox/changes {domain, since}` on a session token, new port method `Inbox.changes` (SQL: migration `0003_inbox_version`, a `version` column on `Inbox`), `INBOX_TRANSPORTS` (`socket,poll` by default; a transport left out answers 404; `poll` alone for several Node.js or Bun instances behind one load balancer). On Node.js and Bun an unchanged poll is answered from the process's memory, with no database read, while the socket is offered (`createInboxVersionCache`). Accept, reject and markRead that change nothing no longer write.
- `@missiv/client`: `openInboxChannel` (and `openConversationList`, `openOneConversation`) take `transport: 'socket' | 'poll' | 'auto'` (default `auto`) and `pollIntervalMs` (default 5 s); `auto` polls after three sockets in a row failed and tries the socket again every minute. New `API.inboxChanges`.
- cf-worker (a deployment): the Inbox Durable Object keeps the version with its rows (an existing object gets the column on its next start) and answers a poll from its own storage. Polling still costs a Worker and a Durable Object request per poll; the socket stays the cheaper transport there.
