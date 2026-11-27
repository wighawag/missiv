# missiv load harness

Drives a missiv server over real HTTP and WebSockets with many simulated clients (real wallets and delegate keys, registered as `test/client-server` registers its users) and prints the throughput and the p50/p95/p99 latencies of what they do. It is not part of `pnpm test` (that runs only `test/stats.test.ts`, the harness's arithmetic); a load run has its own command.

```sh
pnpm build                       # the harness runs the built packages
pnpm load all                    # every scenario against the Node.js platform
pnpm load send --target bun      # one scenario against the Bun platform (bun on PATH, or --bun <path>)
pnpm load read --target url --url http://127.0.0.1:34003   # a server already running (wrangler dev, a deployment)
pnpm load room --room-size 500 --rate 50 --json /tmp/room.json
pnpm load --help
```

## Scenarios

- `send`: every client sends direct messages in its conversations, one after another (an `encrypted` send, so the server checks the recipients' keys; the content is a placeholder of `--size` characters, so the client's encryption is not in the numbers, its signing is).
- `read`: every client reads its conversations as an open conversation view does. In 0.5 that is the newest page (`getMessages`, up to 100 messages, the 2 s poll); each conversation is first filled with `--history` messages.
- `list`: every client fetches its conversation list (`getConversations`, the 20 s poll).
- `room`: `--room-size` sockets join one room (`room-join`: each socket's connect and login), then `--rate` messages a second for `--duration` seconds, the sockets taking turns to send. `room` is each message's time to its LAST delivery (every socket, the sender's included), `room-delivery` every single delivery; a message refused (`error:rate_limited`) or not delivered to every socket counts as `incomplete`.
- `all`: the four in turn; `send`, `read` and `list` share one set of users and conversations.

`send`, `read` and `list` are closed loops: each of `--clients` clients issues its next request as soon as the previous one is answered, so the throughput is what the server sustains at that concurrency and the latency includes the queueing. `room` is an open loop at a fixed rate.

Each result line also gives `serverLoad` (node only: the share of the scenario's time the server's thread was busy, 100% means the server is the bottleneck) and, at the end, the harness's own event loop utilization: above 90% the harness, not the server, is the limit, and it says so.

## Targets

- `node` (default): the Node.js platform (`createNodeServer` from `missiv`, on in-memory libSQL, served by `@hono/node-server`), in a worker thread of the harness.
- `bun`: the Bun platform's CLI (`platforms/bun/src/cli.ts`, on bun:sqlite in memory), a child process on a free port.
- `url`: any server at `--url`, which the harness neither starts nor stops. For `wrangler dev`: `cd platforms/cf-worker && pnpm init:db && pnpm dev` (port 34003). Rooms do not open there today (observation `cf-worker-room-upgrade-500-on-wrangler-dev`): `room` stops with the join errors.

Whatever the harness starts it stops, at the end of the run, on an error, and on Ctrl-C (SIGINT/SIGTERM). Only a SIGKILL of the harness itself can leave a `bun` child behind.

## API adapters

The scenarios speak only `src/adapters/types.ts`'s `Adapter`; `src/adapters/v0-5.ts` is missiv 0.5's API (`--api 0.5`, the default), built on `test/client-server/test/setup.ts`'s `createUser` and `createActions` over a real-HTTP `@missiv/client` `API`. A later API is one more adapter registered in `src/cli.ts`'s `ADAPTERS`, run against the same scenarios.

## Decisions

- **The Node.js target runs in a worker thread.** In process, as the task asks, but not on the harness's thread: the simulated clients sign every request with secp256k1, which on one shared event loop would be counted as server time. A child process (`node platforms/nodejs/dist/cli.js`) was the alternative; the worker keeps the start and stop in the harness's hands and lets it read the server thread's load (`serverLoad`). Touches only this package.
- **Each room socket connects from its own loopback address** (`sourceAddress` in `src/scenarios.ts`: 127.0.1.1, 127.0.1.2, ...). The room rate-limits per IP (one action per 5 s past a 20 s burst, a login included), so a hundred sockets from 127.0.0.1 would measure the limiter. A remote `--url` sees one IP for every socket, and the harness warns. Alternatives: a server built without the limiter (no longer the platform as it runs), or fewer messages per socket (not a fan-out test). Keep `--rate` at or below `--room-size / 5` for a sustained run.
- **HTTP scenarios are closed loops, the room an open loop** (see above). An open-loop HTTP rate would need a target rate per platform before the first measurement; the closed loop finds the plateau by itself, and a sweep of `--clients` shows the latency at lower load.
- **The harness's arithmetic is in `pnpm test`, no load run is.** `test/stats.test.ts` (percentiles, the pairing of conversations) takes milliseconds and starts nothing.
- **`test/client-server/test/setup.ts` exposes `createActions(api)`**: the actions its harness had (register, send, accept, read, lists), now over any `API`, so the tests and the load harness register and sign the same way. `createHarness` is unchanged for the tests.
