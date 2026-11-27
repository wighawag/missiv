// The Node.js platform as its CLI runs it (`createNodeServer` on in-memory
// libSQL, served by @hono/node-server, rooms on @hono/node-ws), in a worker
// thread of the harness: in process, but on its own event loop, so the
// simulated clients' signing does not run on the server's thread.
import {parentPort} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {serve} from '@hono/node-server';
import {createNodeServer} from 'missiv';

// a session secret of its own: the harness's clients open sessions like any client.
// The rate limits raised out of reach (every client registers from 127.0.0.1 and
// sends in a closed loop): the run measures the server, not its token buckets
const LOAD_RATE_LIMITS = {RATE_LIMIT_SEND_BURST: '1000000000', RATE_LIMIT_IP_BURST: '1000000000'};
// INBOX_TRANSPORTS from the harness's env (`INBOX_TRANSPORTS=poll pnpm load poll`:
// every poll reads its version from SQL, as several instances would)
const {app, injectWebSocket} = await createNodeServer({
	db: ':memory:',
	env: {
		SESSION_SECRET: 'load-harness-session-secret',
		...LOAD_RATE_LIMITS,
		...(process.env.INBOX_TRANSPORTS ? {INBOX_TRANSPORTS: process.env.INBOX_TRANSPORTS} : {}),
	},
});
const server = serve({fetch: app.fetch, port: 0, hostname: '127.0.0.1'}, (info) => {
	parentPort?.postMessage({port: info.port});
});
injectWebSocket(server);

// how long this thread has been busy and idle: the harness's measure of how close the server is to saturated
parentPort?.on('message', (m) => {
	if (m === 'load') {
		const {idle, active} = performance.eventLoopUtilization();
		parentPort?.postMessage({load: {idle, active}});
	}
});
