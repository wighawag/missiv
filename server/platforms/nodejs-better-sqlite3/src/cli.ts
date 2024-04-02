import {serve} from '@hono/node-server';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {createServer} from 'missiv-server-app';

export function getDB() {
	const sqlite = new Database('sqlite.db');
	return drizzle(sqlite);
}

export function getRoom() {
	return {} as any;
}

const app = createServer({
	getDB,
	getRoom,
	upgradeWebSocket: (d: any) => {
		return {} as any;
	},
});

const port = 3000;
console.log(`Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
