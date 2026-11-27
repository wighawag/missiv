// @missiv/server on Node.js: the app over a libSQL database, with rooms held in
// process (WebSockets through @hono/node-ws), and the live inbox's sockets too. `createNodeServer` builds it without
// opening a port, so it can be served (`serve`) or exercised (`app.request`).
import {createInProcessLiveInbox, createInProcessRooms, createServer, migrate, type Env} from '@missiv/server';
import {createNodeWebSocket} from '@hono/node-ws';
import {RemoteLibSQL} from 'remote-sql-libsql';
import {createClient, type Client} from '@libsql/client';
import type {IncomingMessage} from 'node:http';

export type NodeJSEnv = Env & {
	/** a libSQL URL: `:memory:`, `file:missiv.db`, or a remote libSQL server */
	DB?: string;
};

export type NodeServer = Awaited<ReturnType<typeof createNodeServer>>;

/**
 * The app, its database migrated, and `injectWebSocket` to call on the HTTP
 * server once it is listening (rooms and the live inbox need it; the HTTP API
 * does not).
 */
export async function createNodeServer(options: {db: string | Client; env: NodeJSEnv}) {
	const client = typeof options.db === 'string' ? createClient({url: options.db}) : options.db;
	const db = new RemoteLibSQL(client);
	await migrate(db);

	const env = options.env;
	const rooms = createInProcessRooms<NodeJSEnv>({getDB: () => db});
	const liveInbox = createInProcessLiveInbox();
	// node-ws routes an upgrade request through the app, which is built below
	let app: ReturnType<typeof createServer<NodeJSEnv>>;
	const {upgradeWebSocket, injectWebSocket} = createNodeWebSocket({
		app: {request: (...args: Parameters<typeof app.request>) => app.request(...args)} as any,
	});

	app = createServer<NodeJSEnv>({
		services: {
			getDB: () => db,
			getRoom: rooms.getRoom,
			getRateLimiter: rooms.getRateLimiter,
		},
		inProcessRooms: {getRoom: rooms.getRoom},
		// the socket's address: behind a proxy, every client is the proxy's (one IP budget)
		getIP: (c) => (c.env as {incoming?: IncomingMessage} | undefined)?.incoming?.socket?.remoteAddress,
		liveInbox,
		getEnv: () => env,
		upgradeWebSocket: upgradeWebSocket as any,
	});

	return {app, db, injectWebSocket, liveInbox};
}
