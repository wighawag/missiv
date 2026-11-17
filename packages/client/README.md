# @missiv/client

The client of missiv, a messaging system for Ethereum accounts: Svelte stores (`svelte/store`) over missiv's HTTP API and rooms. The server is an untrusted relay: this library checks every key against the wallet's ownership proof and every message against its sender's signature, and decrypts each message on its own (`docs/adr/0003-the-client-verifies-the-server-relays.md` in the repo).

## The account

Every store follows a registration store, which follows the app's account: `{address, signer: {address, privateKey, publicKey}}` (the wallet address and its delegate key, `@etherplay/connect`'s origin account), or `undefined`.

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

`step` is `Idle` (no signer), `Fetching`, `Unregistered` (`otherKey` when another key of the account is registered in the domain: registering replaces it), or `Registered` (the server's record is this signer's key, proven by this wallet). `register(ownershipSignature, {name?, description?})` takes the wallet's signature over `originPublicKeyPublicationMessage(appOrigin, publicKey)`; `edit({name?, description?})`.

## The stores

Each store works only while it has a subscriber, and only for the registration's current account: subscribe to start polling or connect, unsubscribe to stop; another account restarts it. Each has an `error` (`{message, code?, cause?}`, `code` being the server's: `invalid_request`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `internal`) and takes an optional `fetch`.

- `openConversationList({registration, endpoint, domain, namespace, pollingInterval?})`: `conversations`, `numUnaccepted` (requests), `numUnread` (accepted, with a message newer than their last read).
- `openOneConversation({registration, endpoint, domain, namespace, otherUser: {address}, markAsAcceptedAndRead?, pollingInterval?})`: `messages`, each `{content}` or `{error: {code: 'unverified' | 'undecryptable'}}`; `otherUser.publicKey` is set only once verified (`unverifiedKey` when the server's key fails its proof). `sendMessage(text)` encrypts to that key and is refused without one; `sendIntroduction(text)` sends in clear, readable by the server, and only when called.
- `openRoom({url, registration, autoLogin?, createWebSocket?, reconnectDelayMs?})`: `messages` (`pending` until the room echoes one, `failed` with the room's error otherwise), `users` (one per session), `loginStatus`; `sendMessage`, `login`, `logout`. A lost socket is reconnected with a fresh challenge. Room messages are unencrypted and attributed by the server.

Below the stores: `API` (each call signed with delegated-identity's request envelope, a refusal thrown as `MissivAPIError` with its `status` and `code`), and `verifyDomainUser`, `encryptedCopies`, `clearCopies`, `openMessage`.

## Developing

`src/lib` is the library, `src/routes` and `src/app` a demo app against a local missiv (`PUBLIC_MISSIV_HTTP_ENDPOINT`).

```bash
pnpm dev      # the demo app
pnpm build    # svelte-check, the demo app, and the package (svelte-package, publint)
pnpm test
```

The stores' tests run against the in-process server, in the repo's `test/client-server`.
