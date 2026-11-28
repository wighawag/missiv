---
status: proposed
---

# The 0.6 direct-messaging wire and store contract

The contract the 0.6 tasks build against (spec `scalable-direct-messaging`, tasked 2026-11-27; keys and crypto in ADR-0004, store ports in ADR-0005). Recorded as a decision because each rule below was a real choice that is costly to change once clients exist, and several were corrected by review before any code.

## Identity of a conversation

A conversation is `(domain, namespace, conversationID)`, with `conversationID = conversationIDOf(members)` as today. Every table, cursor, sequence space and Durable Object name is keyed by the triple, never by `conversationID` alone, because the same two members talk separately per domain and namespace. 1:1 only: a send naming other than two members is refused until a group scheme exists. `conversationIDOf` keeps its keccak form for more than two members (unused while groups are refused); the 1:1 form is unchanged.

## The message

```ts
type Message = {
	domain: string;
	namespace: string;
	conversationID: string;
	messageID: string; // client ULID: unique within the conversation, its time within the window
	seq: number; // assigned by the ConversationStore; absent on send
	sender: Address;
	senderKeyRef: string; // keySetRef of the sender's key set (delegated-identity)
	scheme: 'clear' | 'pairwise-v1'; // reserved: 'sender-key-v1' | 'mls-v1'
	keyID: string | null; // pairwise-v1: the two members' keyRefs, sorted, joined; null for clear
	content: string; // base64url ciphertext (iv || ciphertext || tag), or the text for clear
	signature: string; // Ed25519, see below
	serverTimestamp: number; // assigned by the store
};
```

- **Signing payload**: the UTF-8 lines `missiv message`, then `domain: …`, `namespace: …`, `conversation: …`, `id: …`, `sender: …`, `senderKey: …`, `scheme: …`, `keyID: …` (`none` when null), `content: 0x<SHA-256 of content>`, joined with `\n`. Unambiguous because every value is schema-validated to contain no newline (domains, namespaces, hex ids, ULIDs, hex keys) and the content is represented by its hash. Pinned by test vectors.
- **`pairwise-v1`**: content key = HKDF-SHA256 (IKM the X25519 shared secret of the two members' encryption keys, salt empty, info the payload lines `domain` through `keyID`); AES-256-GCM with a random 96-bit IV, the same info as associated data. One key per message, so the random-IV bound never applies.
- **Crypto availability**: WebCrypto when `crypto.subtle` exists; `@noble/curves`, `@noble/ciphers`, `@noble/hashes` otherwise, including on plain-http origins (a LAN dev stack), where `crypto.subtle` is absent because it is not a secure context.

## Sending

- Authorized by the message signature (verified against the sender's current key set) plus the session token naming the same account and key set.
- **Window**: the messageID's time must be within 10 minutes of the server clock; outside it the send is refused `stale` with the server's time, and the client re-signs with a fresh messageID.
- **Idempotent retry**: a messageID already stored with the same signature answers success with the stored `seq` (a retry after a lost response); with a different signature it is refused `conflict`.
- **Blocks are domain-level**, as in 0.5: rejecting a 1:1 conversation blocks the other member in the whole domain, and unblock lifts it, as does a message the blocker sends to them after the block (amended 2026-11-27: replying is taken as lifting the block, so the other member's replies reach the blocker again; the blocker's inbox row moves to accepted as for any message it sends; an older message retried after a newer block does not lift it). A message from a blocked sender is acknowledged and stored flagged hidden from the recipient: the sender keeps seeing it (dropping it would reveal the block), the recipient never receives, lists or is pushed it. Node/Bun keep blocks in one table read in the send transaction; on Cloudflare the blocker's Inbox owns its block list and propagates the state to the Conversation objects it shares with the blocked member, which check it on append (the blocker's own message lifts the block when its Inbox applies the update, and is propagated as an unblock); a Conversation object created later (a first message in another namespace) reads the block state from both members' Inboxes when it is created, before its first append.
- **Send path**: token (HMAC) → message signature (Ed25519; the sender's current key set read from the directory on every send: uncached on Node/Bun, on Cloudflare through the isolate's cache of the directory's lookups, whose time to live (5 s) bounds how long a replaced key set may still send; amended 2026-11-27, was "a cached directory read") → ConversationStore.append (dedup, block check, seq) → Inbox.update for both members → live frames and Web Push. Node/Bun: append, inbox rows and the lift of the sender's block of the recipient in one SQLite transaction. Cloudflare: Worker → Conversation object → Inbox objects (alarm-retried) → sockets / `waitUntil` push.
- **Inbox.update is idempotent and monotonic**: keyed by conversation, it applies only an update whose `seq` is greater than the stored `lastSeq`, so a retried or reordered update changes nothing.

## Sessions and replay

- `POST /session {domain}`, a `delegated-identity` Ed25519 signed request, returns `{token, expiresAt, keyRef}` when the signing key is the current key set of an account in that domain. Token = base64url `{account, domain, keyRef, exp}` + HMAC-SHA256 with `SESSION_SECRET` (`SESSION_SECRET_PREVIOUS` also accepted), about an hour.
- **A small replay set stays for `/session` and `register` only**: their signed requests are remembered for the 60 s window and a second use is refused. A replayed session request would hand out a bearer token, and a replayed older registration could make a replaced key set current again. Sends need no replay set (the messageID does it).

## API (zod in `@missiv/common`)

`POST /session`; `register` (account, domain, app origin, the key set, the wallet's ownership signature; a signed request); `getDomainUser {domain, address}` (the current key set, its ownership signature and app origin); `getKeySet {domain, keyRef}` (any registered key set, current or replaced, so a reader verifies old messages); `messages/send`; `listMessages {domain, namespace, conversationID, after? | before?, limit}` by seq; `listConversations {domain, namespace, status?, before?, limit}`; `accept`; `reject`; `unblock`; `markRead {domain, namespace, conversationID, seq}`.

## Live channel

`GET /inbox/ws`, the session token presented AT UPGRADE (the `Sec-WebSocket-Protocol` header, or a one-shot ticket from an HTTP call), so the server can verify it and route to the user's Inbox before accepting the socket (on Cloudflare the Worker must pick the Inbox object then). Server frames: `{type: 'message', message}`, `{type: 'conversation', conversation}`, `{type: 'ready'}`; the client may send `{type: 'sync', since: {[conversation]: seq}}` and receives what it missed, then `ready`. At the token's expiry the server closes the socket with a `session-expired` code and the client reconnects with a renewed token. Sends stay HTTP. The client keeps the socket alive with a heartbeat, as on every missiv socket (rooms too): the text frame `ping` every 30 s, answered `pong` (on Cloudflare by the Durable Object's WebSocket auto-response, which wakes nothing), the socket given up and reconnected when no frame arrives within 10 s, and on Node.js and Bun the server closes a socket that sent nothing for 90 s (`packages/common/src/heartbeat.ts`).

## Amendment: the inbox version and polling (2026-11-27)

The live inbox gains a second transport, so a deployment and a client can choose how direct messages are delivered (task `switchable-inbox-transport`; reasons and costs in `work/notes/ideas/switchable-inbox-transport-and-socket-heartbeat.md`, numbers in `work/notes/findings/load-inbox-polling.md`).

- **The inbox version**: a monotonic counter per (domain, user). Every change of one of the user's inbox rows gives that row the next version (`Conversation.version`, carried by every row: listed, polled, and in each `conversation` frame); the inbox's version is its highest row's. An update that changes nothing (a repeated or reordered `Inbox.update`, an accept of an accepted row, a markRead that reads nothing new) takes none; `unblock` changes no row and takes none. Stored with the rows: the `version` column of SQL's `Inbox` (migration `0003_inbox_version`), the Inbox Durable Object's own rows on Cloudflare, each change computing its version in the statement that makes it.
- **`POST /api/inbox/changes {domain, since, limit?}`** (session token, the token's domain, every namespace): `{version, unchanged: true}` when no row changed after `since`, otherwise `{version, conversations, hasMore}`, the rows changed after it, oldest change first, a page at a time (`version` is then the last row's: poll again at once from it). `since` 0 means every row; a `since` above the inbox's version (a reset database) is answered as 0. The client reads the messages it lacks with `listMessages {after}`. On Node.js and Bun a single process answers an unchanged poll from memory, with no database read, while it offers the socket; with polling alone it reads the version from SQL on every poll (one indexed lookup), which stays correct across several instances. On Cloudflare a poll reads only the user's Inbox object, though each is still a Worker and a Durable Object request.
- **`INBOX_TRANSPORTS`** (`socket,poll` by default): which transports a deployment offers; a route that is off answers 404 (the socket before any upgrade), and a value naming anything else fails the request that reads it.
- **The client** (`openInboxChannel`, and both inbox stores): `transport: 'socket' | 'poll' | 'auto'` (default `auto`) and `pollIntervalMs` (default 5 s). `auto` uses the socket, polls after three sockets in a row failed before the server sent them anything, tries the socket again every minute while polling, and goes back to the socket at once when the server refuses polling (404). Stores see the same callbacks whatever the transport, and sync on every switch. Rooms stay on sockets on every platform.

Considered: a CDN or KV cache of "unchanged" answers (rejected: per user and authenticated, and Cloudflare's Cache API is per colo with non-instant purge, KV eventually consistent for up to about 60 s); a separate `InboxVersions` counter table (rejected: a row's version computed as the highest row's plus one needs no second write, and the highest is one lookup on the index); triggers (rejected: the migrations runner splits statements on `;`, and the rule would be hidden from the code that writes rows).

## Storage keys

Messages keyed `(domain, namespace, conversationID, seq)` with unique `(domain, namespace, conversationID, messageID)`; inbox rows indexed `(user, domain, namespace, status, lastMessageAt DESC, conversationID)` with `lastSeq` and `lastReadSeq`; key sets keyed by `(domain, keyRef)` with the current one per `(domain, user)`.

## Considered options

- **Conversations keyed by `conversationID` alone**: rejected; one pair of members would share a sequence space, a status and an object across domains and namespaces.
- **Refusing a duplicate messageID outright**: rejected; it reports a successful send as failed to a client that retries after a lost response.
- **No replay set at all**: rejected for `/session` and `register`, for the reasons above.
- **Token as the first socket frame**: rejected; the socket cannot be routed to its Inbox before the user is known.

## Amendment: room to grow the live channel's wire (2026-11-28)

The live channel will gain optional client frames (typing and presence, analysed in `work/notes/ideas/dm-presence-typing-read-receipts.md`), and until now a server closed the socket (1008) on any client frame but `sync` and `ping`, so a newer client would lose its socket on an older server. Decided with the human, ahead of those frames, so that tolerant servers are deployed before any client needs them:

- **`welcome`**: every accepted socket is first sent `{type: 'welcome', features: string[]}`, the optional client frames the server accepts (none yet, `INBOX_SERVER_FEATURES`). A client sends an optional frame only when the welcome of the socket it is on names it (`InboxChannel.features`); no welcome means a server older than this, which accepts only `sync` and `ping`. A client ignores server frames it does not know, as it already did, so the welcome breaks no older client.
- **Unknown client frames are ignored**: a JSON object with a string `type` other than `sync` leaves the socket open (`readInboxClientFrame`); anything else (not JSON, no `type`, a malformed `sync`) still closes it with 1008.
- Considered: the features on `ready` (rejected: `ready` answers a sync, and a channel with nothing to sync sends none); a second protocol name at the upgrade, such as `missiv-inbox-2` (rejected: one name per wire version multiplies with every feature, where a list does not); the polling transport carries no optional frames, so it gets no welcome.

## Amendment: read receipts (2026-11-28)

For live diplomacy in Conquest (analysis and choices in `work/notes/ideas/dm-presence-typing-read-receipts.md`), decided with the human: read receipts first, typing and presence deferred.

- **Shape**: each inbox row carries `otherReadSeq`, the other member's read point (every message at or below it read). A `markRead` raises the reader's `lastReadSeq` as before, then the other member's `otherReadSeq` to the reader's read point (raised only, at most that row's `lastSeq`, with that member's next inbox version), even when the reader's own row did not move. It travels wherever a row does (lists, `conversation` frames, `POST /api/inbox/changes`), so it needs no new frame and works on every transport.
- **Privacy**: shared by default with an opt-out per account and domain (`setSettings {domain, readReceipts}`, `getSettings`), and reciprocal: a receipt moves only while both members share, and a member who shares none sees 0 in every row. No receipt is ever above the receiving member's `lastSeq`, so a blocker learns nothing of the messages hidden from it, and a blocked sender sees its hidden messages never read, as a reader who has not read them.
- **No delivered state**: a message is sent (stored, the send's answer) and then read. A tick for "reached the device" would stay missing exactly for a blocked sender, which "Sending" keeps from learning of the block.
- **Read means seen**: the client marks read only while the thread is visible (`openOneConversation`'s `visibility`, by default the page's visibility).
- **Storage**: Node.js and Bun, a column `otherReadSeq` and a table `InboxSettings` (migration `0004_read_receipts`), the receipt a second statement in `markRead`'s batch. Cloudflare, the settings in the user's Inbox object, the receipt sent from the reader's Inbox object to the other member's, retried by alarm until acknowledged, and applied there only when its user shares too.
- Considered: receipts per message (rejected: the read point is one number per row, already stored, and the seq orders the messages); the reader's receipt applied even when the receiving member shares none and hidden at read time only (rejected: the row's new version and its frame would still tell the receiving member when the other read); a frame of its own on the socket (rejected: the row already reaches every transport).
