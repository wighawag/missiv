import {Context, Hono} from 'hono';
import {Bindings, BlankInput, MiddlewareHandler} from 'hono/types';
import {ServerOptions} from '../../types.js';

export type {ServerObject, ServerObjectId} from '../../types.js';
export type {Storage} from '../../storage/index.js';
export {Room} from '../../Room.js';

type WebsocketResponse = MiddlewareHandler<
	any,
	string,
	{
		outputFormat: 'ws';
	}
>;

export function getPublicChatAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const {getRoom, upgradeWebSocket} = options;

	const app = new Hono<{Bindings: Env & {}}>()
		.get('/', async (c) => {
			return c.text('Hello World!');
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
		);

	return app;
}
