// @missiv/server on Bun: the app over bun:sqlite (one transaction per batch, so
// a send is one transaction), with rooms held in process (WebSockets through
// hono/bun). `createBunServer` builds it without opening a port, so it can be
// served (`Bun.serve`, as the CLI does) or exercised (`app.request`, tests).
import {createInProcessRooms, createServer, migrate} from '@missiv/server';
import {createBunWebSocket} from 'hono/bun';
import {Database} from 'bun:sqlite';
import {RemoteBunSQL} from './remote-sql-bun/index.js';
import type {BunEnv} from './env.js';

export async function createBunServer(options: {db: string | Database; env: BunEnv}) {
	const database = typeof options.db === 'string' ? new Database(options.db, {strict: true}) : options.db;
	const db = new RemoteBunSQL(database);
	// the schema: the migrations this database has not had
	await migrate(db);

	const env = options.env;
	const {upgradeWebSocket, websocket} = createBunWebSocket();
	const rooms = createInProcessRooms<BunEnv>({getDB: () => db});

	const app = createServer<BunEnv>({
		services: {getDB: () => db, getRoom: rooms.getRoom, getRateLimiter: rooms.getRateLimiter},
		inProcessRooms: {getRoom: rooms.getRoom},
		// TODO behind a proxy, a forwarded address once the proxy is trusted
		getIP: (c) =>
			(c.env as {requestIP?(r: Request): {address: string} | null} | undefined)?.requestIP?.(c.req.raw)?.address,
		getEnv: () => env,
		upgradeWebSocket: upgradeWebSocket as any,
	});

	return {app, db, websocket};
}
