import {Context, Hono} from 'hono';
import {WSEvents} from 'hono/ws';
import {Bindings} from 'hono/types';
import {posts} from './db/schema';
import {Server, ServerOptions} from './server-abstraction/types';

export {Room} from './Room';

export * from './server-abstraction/types';

export function createServer<
	Env extends Bindings = Bindings,
	TSchema extends Record<string, unknown> = Record<string, never>,
>(options: ServerOptions<Env, TSchema>): Server<Env> {
	const app = new Hono<{Bindings: Env & {}}>();
	const {getDB, getRoom, upgradeWebSocket} = options;

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
		})
		.get('/room/:name/websocket', (c) => {
			const room = getRoom(c, c.req.param().name);
			return room.fetch(c.req.url);
		});

	app.get(
		'/ws',
		upgradeWebSocket(() => {
			return {
				onMessage(event, ws) {
					ws.send(`Echo: ${event.data}`);
				},
				onClose: () => {},
			};
		}),
	);

	return app;
}
