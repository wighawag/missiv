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
- **Platforms**: Node.js, Bun and Cloudflare Workers, from one platform-agnostic server (`missiv-server`) and one schema with numbered migrations.
- **Client**: Svelte stores (`missiv-client`).


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
