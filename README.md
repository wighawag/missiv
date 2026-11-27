<h1 align="center">
  MISSIV
</h1>

<h2 align="center">
  👾🌍 A Messaging System for Ethereum Accounts
</h2>

Missiv is a messaging system for Ethereum accounts. It allows Ethereum accounts to send messages to each other. The backend stores these messages, and clients can retrieve them. Messages are encrypted end to end, and the server is an untrusted relay: the client checks every key against the wallet's ownership proof and every message against its sender's signature. If a recipient is not yet registered (their public key is not yet published), the sender can choose to send an introductory message in clear text to make contact. See `CONTEXT.md`, `docs/architecture.md` and `docs/adr/`.


## Features

- **Registration**: a wallet publishes a delegate key per domain, with its ownership proof (delegated-identity).
- **Direct messages**: encrypted, each copy signed by its sender and checked by its reader; conversation requests, blocks, read state, and a push to the recipient through push-notification-server.
- **Rooms**: real-time public chat over WebSocket, optionally gated by a contract call.
- **Platforms**: Node.js, Bun and Cloudflare Workers, from one platform-agnostic server (`@missiv/server`) and one schema with numbered migrations.
- **Client**: Svelte stores (`@missiv/client`).


## Push notifications

When a direct message arrives, the server asks push-notification-server (`PUSH_SERVER_URL`, with each domain's token in `PUSH_TOKENS`) to notify each recipient, except the sender and anyone who blocked them. The push is a Declarative Web Push message (`pushMessage` in `packages/server/src/push.ts`). It names the sender, abbreviated, and never anything of the message: its content is end-to-end encrypted, and the push service is not to see even a clear one.

- `title`: `New message`; `body`: `From 0xaaaa...aaaa`.
- `tag`: `missiv:<conversationID>`, so a newer message of a conversation replaces the older notification.
- `data.missiv`: `MissivPushData` from `@missiv/common` (`type: 'message'`, `domain`, `namespace`, `conversationID`, `messageID`, `sender`, `recipient`), checked with `readMissivPushData`.
- `navigate`: the app's root (its registered `appOrigin`, else `https://<domain>`), never an app route, with a hand-off as its fragment: `/#push-handoff=<base64url JSON>`.

Adding a field to `data.missiv` or to the hand-off is compatible, and the readers ignore unknown fields. Renaming, removing or changing the meaning of a field is a new `type` value.

### Reaching the conversation from a click

Two browser facts decide how an app gets there:

- A notification with `navigate` is navigated to on click, and `notificationclick` is not fired (the Notifications standard, "Activating a notification": https://notifications.spec.whatwg.org/#activating-a-notification).
- On Safari 18.4+ (iOS and iPadOS Home Screen web apps) and 18.5+ (macOS), a Declarative Web Push message is shown and clicked with no JavaScript: the service worker gets no `push` event unless the message sets `mutable`, which missiv does not (https://webkit.org/blog/16535/meet-declarative-web-push/).

So an app does both:

- **Where its service worker runs**, the worker shows the notification itself, without `navigate` in `showNotification`'s options (or the click never reaches it), and routes from `data.missiv` on `notificationclick`.
- **Everywhere**, the page calls `consumePushHandoff()` from `@missiv/common` on load and on `hashchange`, and passes its `missiv` to `readMissivPushHandoff`, which gives `{type, namespace, conversationID, recipient}`. It removes the hand-off from the URL as it reads it, so a reload, a bookmark or a shared link never replays it.

The hand-off carries references only, since the URL ends up in the browser's history: the app fetches the rest by id.

`recipient` is the account the push is for. A device can be registered for several accounts, so before opening the conversation the app compares it with the account it is connected as, and when they differ tells the user ("this message is for 0xbbbb...bbbb") or offers to switch, rather than opening a conversation the connected account is not in.

There is no opt-in. An app that routes on the URL fragment must call `consumePushHandoff()` before its router reads the URL, and register its `hashchange` listener before the router's (or in the capture phase on `window`).

The format is generic, so another service pushing to the same app can use it (`withPushHandoff`, `splitPushHandoff`). The hand-off is a JSON object keyed by service, encoded as base64url without padding of its UTF-8 JSON. It is always the last segment of the fragment: `#push-handoff=...` when the URL has no fragment, `#<fragment>&push-handoff=...` when it has one. base64url has no `&` or `#`, so the segment runs to the end of the URL and removing it leaves the rest of the fragment byte for byte. The test vector:

- input URL: `https://app.example/#/conversations?x=1`
- hand-off: `{"missiv":{"type":"message","namespace":"","conversationID":"0xconv","recipient":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`
- output: `https://app.example/#/conversations?x=1&push-handoff=eyJtaXNzaXYiOnsidHlwZSI6Im1lc3NhZ2UiLCJuYW1lc3BhY2UiOiIiLCJjb252ZXJzYXRpb25JRCI6IjB4Y29udiIsInJlY2lwaWVudCI6IjB4YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiJ9fQ`

With every field at its schema maximum, a push message is about 2.1 KB with ASCII values and 2.8 KB with a JSON-escaped namespace. Web Push carries about 3993 bytes of plaintext.


## Getting Started

### Prerequisites

- Node.js
- pnpm
- zellij (for `pnpm start`)
- bun and wrangler, only for their platforms

### Installation

```bash
pnpm install
```

### Running all

To start the server, run:
```bash
pnpm start
```

### Running Tests

```bash
pnpm format:check && pnpm build && pnpm test
```

The verify (`dorfl.json`): no test opens a port; the client-server tests run the server in process.

### Publishing

`@missiv/common`, `@missiv/server`, `@missiv/client`, `@missiv/bun` and `missiv` (the Node.js server and CLI) are published by the release workflow through npm Trusted Publishing: see `PUBLISHING.md`.
