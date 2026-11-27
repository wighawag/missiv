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

Each store works only while it has a subscriber, and only for the registration's current account: subscribe to start polling or connect, unsubscribe to stop; another account restarts it. Each has an `error` (`{message, code?, cause?}`, `code` being the server's: `invalid_request`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `stale`, `rate_limited`, `internal`) and takes an optional `fetch`.

- `openConversationList({registration, endpoint, domain, namespace, pollingInterval?})`: `conversations` (each with its `status`, `lastSeq`, `lastReadSeq`), `numUnaccepted` (requests), `numUnread` (accepted, with `lastReadSeq < lastSeq`: `isUnread`).
- `openOneConversation({registration, endpoint, domain, namespace, otherUser: {address}, markAsAcceptedAndRead?, pollingInterval?})`: `messages` in seq order (the newest page, then each poll fetches only what is after the last seq it has), each `{content}` or `{error: {code: 'unverified' | 'undecryptable'}}`; `markAsAcceptedAndRead` accepts once and marks read up to each newer seq; `otherUser.keySet` is set only once verified (`unverifiedKey` when the server's key set fails its proof). `sendMessage(text)` sends a `pairwise-v1` message to its key set and is refused without one; `sendIntroduction(text)` sends in clear, readable by the server, and only when called. A send the server refuses `stale` (this device's clock is off by more than 10 minutes) is composed once more under the server's time.
- `openRoom({url, registration, autoLogin?, createWebSocket?, reconnectDelayMs?})`: `messages` (`pending` until the room echoes one, `failed` with the room's error otherwise), `users` (one per session), `loginStatus`; `sendMessage`, `login`, `logout`. A lost socket is reconnected with a fresh challenge. Room messages are unencrypted and attributed by the server.

Below the stores: `API` (`register` signed with delegated-identity's Ed25519 request envelope by the key set's signing key, every other call on a session the `API` opens with one such signed request; a refusal thrown as `MissivAPIError` with its `status`, `code` and `details`; `sendMessage`, `listMessages` (`after` / `before` a seq), `listConversations`, `accept`, `reject`, `unblock`, `markRead`; `getDomainUser` and `getKeySet` read the key directory), and `verifyDomainUser`, `verifyKeySet`; the missiv message (one ciphertext per message, ADR-0006): `composeMessage` (`pairwise-v1`), `composeIntroduction` (`clear`), `openMessage` (fetches the sender's key set by `senderKeyRef` through `getKeySet`, checks it and the signature, decrypts; `unverified` / `undecryptable` otherwise).

## Developing

`src/lib` is the library, `src/routes` and `src/app` a demo app against a local missiv (`PUBLIC_MISSIV_HTTP_ENDPOINT`).

```bash
pnpm dev      # the demo app
pnpm build    # svelte-check, the demo app, and the package (svelte-package, publint)
pnpm test
```

The stores' tests run against the in-process server, in the repo's `test/client-server`.
