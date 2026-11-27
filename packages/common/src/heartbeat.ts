// The heartbeat of every missiv socket (the live inbox channel, ADR-0006 "Live
// channel", and the room sockets): a proxy or a mobile network commonly drops
// an idle connection after 60 to 100 s, silently, so a quiet socket would stop
// receiving pushes without either side knowing.
//
// Decisions recorded here:
// - The CLIENT sends the heartbeat, as an application frame: a browser cannot
//   send a protocol ping. Every `HEARTBEAT_INTERVAL_MS` it sends the bare text
//   `ping` (not JSON: Cloudflare's `setWebSocketAutoResponse` matches a frame's
//   exact text), and when no frame at all (a `pong` or anything else) arrives
//   within `HEARTBEAT_TIMEOUT_MS` it gives the socket up: it closes it with
//   `HEARTBEAT_CLOSE_TIMEOUT` and reconnects through its usual backoff, then
//   syncs as after any reconnection.
// - The server answers `ping` with `pong` and nothing else: on Cloudflare the
//   runtime does (the Inbox and Room objects register the pair as their
//   WebSocket auto-response, so a heartbeat neither wakes a hibernated object
//   nor bills its duration); on Node.js and Bun the inbox and room handlers do,
//   ahead of anything else (a room's rate limiter does not count a ping).
// - Node.js and Bun close a socket that sent nothing for
//   `HEARTBEAT_IDLE_INTERVALS` default intervals (90 s) with
//   `HEARTBEAT_CLOSE_TIMEOUT`, so dead clients do not accumulate in process. A
//   client configured with a longer interval than that is closed as idle.
//   Cloudflare closes nothing as idle: a hibernated socket costs nothing.
// - One close code for "the other side went silent", whichever side closes:
//   4002 (4000-4999 are the application's own, RFC 6455 7.4.2; 4001 is the
//   inbox's `session-expired`). Either way the client reconnects with backoff.

/** The text frame the client sends as its heartbeat. */
export const HEARTBEAT_PING = 'ping';
/** The text frame the server answers a `ping` with. */
export const HEARTBEAT_PONG = 'pong';
/** How often a client sends `ping`, by default (configurable on the inbox channel and the room store). */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** How long a client waits for a frame after a `ping` before it gives the socket up, by default. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** After how many default intervals without a frame from the client the Node.js and Bun servers close its socket. */
export const HEARTBEAT_IDLE_INTERVALS = 3;
/** The close code of a socket whose other side went silent: reconnect, with backoff. */
export const HEARTBEAT_CLOSE_TIMEOUT = 4002;
/** The close reason that goes with `HEARTBEAT_CLOSE_TIMEOUT`. */
export const HEARTBEAT_TIMEOUT_REASON = 'heartbeat-timeout';
