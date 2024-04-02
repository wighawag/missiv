import {createServer} from 'missiv-server-app';
import {createBunWebSocket} from 'hono/bun';
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {Database} from 'bun:sqlite';

export function getDB() {
	const sqlite = new Database('sqlite.db');
	return drizzle(sqlite);
}

export function getRoom() {
	return {} as any;
}

const {upgradeWebSocket, websocket} = createBunWebSocket();
const app = createServer({getDB, getRoom, upgradeWebSocket});

Bun.serve({
	fetch: app.fetch,
	websocket,
});
