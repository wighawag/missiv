import {Context, Hono} from 'hono';
import {Bindings, BlankInput, MiddlewareHandler} from 'hono/types';
import {posts} from './db/schema';
import {ServerOptions} from './types';
import {UpgradedWebSocketResponseInputJSONType} from 'hono/ws';

export type {ServerObject, ServerObjectId} from './types';
export {Room} from './Room';

type WebsocketResponse = MiddlewareHandler<
	any,
	string,
	{
		in: {
			json: UpgradedWebSocketResponseInputJSONType;
		};
	}
>;

export function createServer<
	Env extends Bindings = Bindings,
	TSchema extends Record<string, unknown> = Record<string, never>,
>(options: ServerOptions<Env, TSchema>) {
	const app = new Hono<{Bindings: Env & {}}>();
	const {getDB, getRoom, upgradeWebSocket} = options;

	return (
		app
			.get('/', (c) => {
				return c.text('Hello world!');
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
			.get('/websocket', async (c) => {
				console.log({name: 'global websocket'});
				const room = getRoom(c, 'global websocket');
				// console.log({room: room.id});
				const response = await room.fetch(c.req.raw);
				console.log(response);
				return response;
			})
			// we need to cast the function as WebsocketResponse so client get the correct type
			// but by doing so. we then need to also type the context manually
			.get('/room/:name/websocket', ((c: Context<{Bindings: Env}, '/room/:name/websocket', BlankInput>) => {
				console.log({name: c.req.param().name});
				const room = getRoom(c, c.req.param().name);
				return room.fetch(c.req.raw);
			}) as WebsocketResponse)
			.get(
				'/ws',
				upgradeWebSocket(() => {
					return {
						onMessage(event, ws) {
							ws.send(`Echo: ${event.data}`);
						},
						onClose: () => {},
					};
				}),
			)
			.get(
				'/rrr',
				upgradeWebSocket(() => {
					return {
						onMessage(event, ws) {
							ws.send(`rrr: ${event.data}`);
						},
						onClose: () => {},
					};
				}),
			)
	);
}
