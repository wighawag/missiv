<h1 align="center">
  MISSIV
</h1>

<h2 align="center">
  👾🌍 A Messaging System for Ethereum Accounts
</h2>

Missiv is a messaging system for Ethereum accounts. It allows Ethereum accounts to send messages to each other. The backend stores these messages, and clients can retrieve them. Messages are encrypted, but if a recipient is not yet registered (i.e., their public key is not yet public), the sender can send an introductory message in clear text to make contact.


## Features

- **User Registration**: APIs for user registration and message handling.
- **Platform Support**: Support for different platforms like Bun and Cloudflare Workers.
- **Asynchronous Messaging**: Allow users to send each other messages saved in inbox. 
- **WebSocket Connections**: Manage WebSocket connections for real-time messaging.
- **Message Broadcasting**: Broadcast messages to all connected clients.


## Getting Started

### Prerequisites

- Node.js
- pnpm
- zellij
- bun

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
pnpm test
```
