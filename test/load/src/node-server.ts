// The Node.js platform as its CLI runs it (`createNodeServer` on in-memory
// libSQL, served by @hono/node-server, rooms on @hono/node-ws), in a worker
// thread of the harness: in process, but on its own event loop, so the
// simulated clients' signing does not run on the server's thread.
import {parentPort} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {serve} from '@hono/node-server';
import {createNodeServer} from 'missiv';

// a session secret of its own: the harness's clients open sessions like any client
const {app, injectWebSocket} = await createNodeServer({
	db: ':memory:',
	env: {SESSION_SECRET: 'load-harness-session-secret'},
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
