# @missiv/client

The client of missiv, a messaging system for Ethereum accounts: Svelte stores (`svelte/store`) over missiv's HTTP API and rooms. The server is an untrusted relay: this library checks every key set against the wallet's ownership proof and every message against its sender's signature, and decrypts each message on its own (`docs/adr/0003-the-client-verifies-the-server-relays.md` in the repo).

## The account

Every store follows a registration store, which follows the app's account: `{address, keySet, savedPublicKeyPublicationSignature?}` (the wallet address, its key set in the app with its private keys, and the wallet's ownership signature of that key set once signed: `@etherplay/connect`'s signed-in account is one), or `undefined`.

```ts
import {
	createMissivRegistration,
	openConversationList,
	openOneConversation,
	openRoom
} from '@missiv/client';

const registration = createMissivRegistration({
	endpoint: 'https://missiv.example',
	domain: 'game.example',
	appOrigin: 'https://game.example', // the page's origin by default
	account // a Readable<Account>
});
```

`step` is `Idle` (no account), `Fetching`, `Unregistered` (`otherKey` when another key set of the account is registered in the domain: registering replaces it), or `Registered` (the server's current key set is this account's, proven by this wallet). Every device of an account derives the same key set, so a second device is `Registered` at once. `register(ownershipSignature?, {name?, description?})` takes the wallet's signature over delegated-identity's `originPublicKeyPublicationMessage(appOrigin, keySet)`, the account's `savedPublicKeyPublicationSignature` by default; `edit({name?, description?})`.

## The stores

Each store works only while it has a subscriber, and only for the registration's current account: subscribe to start (fetch, connect), unsubscribe to stop; no store polls (the live channel may, see below); another account restarts it. Each has an `error` (`{message, code?, cause?}`, `code` being the server's: `invalid_request`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `stale`, `rate_limited`, `internal`) and takes an optional `fetch`.

- The conversation list and the conversations of an account share ONE WebSocket, the live inbox channel (`openInboxChannel`, `GET /api/inbox/ws` on Node.js and Bun), open while one of them is subscribed: the server pushes each new message and each change of an inbox row on it, and after every (re)connection each store `sync`s what it missed by seq, so a message is shown once whatever the network did. A lost socket is reconnected after a delay that doubles from `retryDelayMs` (1 s) up to 30 s; when the server closes it as `session-expired`, the session is renewed and the socket reopened at once. Both stores take `createWebSocket?` (a test's socket). The channel's `transport` (`'socket' | 'poll' | 'auto'`, default `auto`, also on both stores) chooses how it reaches the server: `poll` asks `POST /api/inbox/changes` every `pollIntervalMs` (5 s) for the rows changed after the last inbox version it saw and reads the messages it lacks; `auto` uses the socket, polls after three sockets in a row failed (or when the server offers no socket), and tries the socket again every minute. The stores see the same callbacks whatever the transport.
- `openConversationList({registration, endpoint, domain, namespace, retryDelayMs?, createWebSocket?, transport?, pollIntervalMs?})`: `conversations` (each with its `status`, `lastSeq`, `lastReadSeq`), `numUnaccepted` (requests), `numUnread` (accepted, with `lastReadSeq < lastSeq`: `isUnread`); fetched each time the channel opens, then kept current by its pushed rows (a mark read by another store or device included).
- `openOneConversation({registration, endpoint, domain, namespace, otherUser: {address}, markAsAcceptedAndRead?, retryDelayMs?, createWebSocket?, transport?, pollIntervalMs?})`: `messages` in seq order (the newest page once, then each message pushed on the channel, and after a reconnection what came after the last seq it has; a message it sends is shown from the send's answer), each `{content}` or `{error: {code: 'unverified' | 'undecryptable'}}`; `markAsAcceptedAndRead` accepts once and marks read up to each newer seq; `otherUser.keySet` is set only once verified (`unverifiedKey` when the server's key set fails its proof). `sendMessage(text)` sends a `pairwise-v1` message to its key set and is refused without one; `sendIntroduction(text)` sends in clear, readable by the server, and only when called. A send the server refuses `stale` (this device's clock is off by more than 10 minutes) is composed once more under the server's time.
- `openRoom({url, registration, autoLogin?, createWebSocket?, reconnectDelayMs?})`: `messages` (`pending` until the room echoes one, `failed` with the room's error otherwise), `users` (one per session), `loginStatus`; `sendMessage`, `login`, `logout`. A lost socket is reconnected with a fresh challenge. Room messages are unencrypted and attributed by the server.

Below the stores: `API` (`getSession(domain, options, {renew?})` the session token the live channel presents, `register` signed with delegated-identity's Ed25519 request envelope by the key set's signing key, every other call on a session the `API` opens with one such signed request; a refusal thrown as `MissivAPIError` with its `status`, `code` and `details`; `sendMessage`, `listMessages` (`after` / `before` a seq), `listConversations`, `accept`, `reject`, `unblock`, `markRead`, `inboxChanges` (the polling transport); `getDomainUser` and `getKeySet` read the key directory), and `verifyDomainUser`, `verifyKeySet`; the missiv message (one ciphertext per message, ADR-0006): `composeMessage` (`pairwise-v1`), `composeIntroduction` (`clear`), `openMessage` (fetches the sender's key set by `senderKeyRef` through `getKeySet`, checks it and the signature, decrypts; `unverified` / `undecryptable` otherwise).

## Developing

`src/lib` is the library, `src/routes` and `src/app` a demo app against a local missiv (`PUBLIC_MISSIV_HTTP_ENDPOINT`).

```bash
pnpm dev      # the demo app
pnpm build    # svelte-check, the demo app, and the package (svelte-package, publint)
pnpm test
```

The stores' tests run against the in-process server, in the repo's `test/client-server`.
