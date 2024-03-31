import {DrizzleD1Database} from 'drizzle-orm/d1';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import {Context, Hono} from 'hono';
import {WSEvents} from 'hono/ws';
import {Bindings} from 'hono/types';
import {posts} from './db/schema';

export function createServer<
	Env extends Bindings = Bindings,
	TSchema extends Record<string, unknown> = Record<string, never>,
>(
	getDB: (
		c: Context<{Bindings: Env}>,
	) => BetterSQLite3Database<TSchema> | DrizzleD1Database<TSchema> | BunSQLiteDatabase<TSchema>,
): {app: Hono<{Bindings: Env}>; handleWebsocket(c: Context<{Bindings: Env}>): WSEvents | Promise<WSEvents>} {
	const app = new Hono<{Bindings: Env & {}}>();

	app
		.get('/', (c) => {
			return c.text('Hello dd!');
		})
		.get('/posts', async (c) => {
			const db = getDB(c);
			const result = await db.select().from(posts).all();
			return c.json(result);
		})
		.post('/posts', async (c) => {
			const db = getDB(c);
			const {title, content} = await c.req.json();
			const result = await db.insert(posts).values({title, content}).returning();
			return c.json(result);
		});

	return {
		app,
		handleWebsocket(c: Context<{Bindings: Env}>): WSEvents | Promise<WSEvents> {
			return {
				onMessage(event, ws) {
					console.log(`Message from client: ${event.data}`);
					ws.send('Hello from server!');
				},
				onClose: () => {
					console.log('Connection closed');
				},
			};
		},
	};
}
