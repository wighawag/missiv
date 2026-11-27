---
'@missiv/server': minor
---

A message the blocker sends unblocks (ADR-0006 "Sending", amended 2026-11-27): when a member has rejected (so blocked) the other member in a domain and then sends them a message there, that send lifts the block as `unblock` would, so the other member's replies reach them again, and their inbox row moves to accepted as for any message they send. A retry of a message sent before a newer block does not lift it. The send path also reads the sender's current key set from the directory on every send (ADR-0006 "Send path" amended to say so).

- `@missiv/server`: the SQL stores lift the sender's block of the recipient in the send's own transaction (six statements per send, each a key lookup). The in-process token buckets never credit a refill twice when the clock steps back (the refill's anchor is the latest time seen, and `retryAfterMs` counts from it). `Retry-After` is in the CORS exposed headers, so a browser on another origin can read it.
- cf-worker (a deployment): the blocker's Inbox object lifts its block when it applies the blocker's own update, and propagates the unblock (versioned) to every Conversation object it shares with that member, as `unblock` does.
