import {serve} from '@hono/node-server';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {createServer} from 'missiv-server-app';

export function getDB() {
	const sqlite = new Database('sqlite.db');
	return drizzle(sqlite);
}

const {app} = createServer(getDB);

const port = 3000;
console.log(`Server is running on port ${port}`);

serve({
	fetch: app.fetch,
	port,
});
