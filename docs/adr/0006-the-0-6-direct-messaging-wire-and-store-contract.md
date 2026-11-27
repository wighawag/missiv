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

## Storage keys

Messages keyed `(domain, namespace, conversationID, seq)` with unique `(domain, namespace, conversationID, messageID)`; inbox rows indexed `(user, domain, namespace, status, lastMessageAt DESC, conversationID)` with `lastSeq` and `lastReadSeq`; key sets keyed by `(domain, keyRef)` with the current one per `(domain, user)`.

## Considered options

- **Conversations keyed by `conversationID` alone**: rejected; one pair of members would share a sequence space, a status and an object across domains and namespaces.
- **Refusing a duplicate messageID outright**: rejected; it reports a successful send as failed to a client that retries after a lost response.
- **No replay set at all**: rejected for `/session` and `register`, for the reasons above.
- **Token as the first socket frame**: rejected; the socket cannot be routed to its Inbox before the user is known.
