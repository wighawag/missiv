import {Context, Hono} from 'hono';
import {WSEvents} from 'hono/ws';
import {Bindings} from 'hono/types';
import {posts} from './db/schema';
import {Server, ServerOptions} from './types';
import {ServerObjectHandlerExample} from './websocket/ServerObjectHandlerExample';

export * from './types';

export function createServer<
	Env extends Bindings = Bindings,
	TSchema extends Record<string, unknown> = Record<string, never>,
>(options: ServerOptions<Env, TSchema>): Server<Env> {
	const app = new Hono<{Bindings: Env & {}}>();
	const {getDB, getServerObject} = options;

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
			const websocketServerInstance = getServerObject(
				c,
				c.req.param().name,
				(instance) => new ServerObjectHandlerExample(instance),
			);
			return websocketServerInstance.fetch(c.req.url);
		});

	return {
		app,
		handleWebsocket(c: Context<{Bindings: Env}>): WSEvents | Promise<WSEvents> {
			return {
				onMessage(event, ws) {
					ws.send(`Echo: ${event.data}`);
				},
				onClose: () => {},
			};
		},
	};
}
