import {Context, Hono} from 'hono';
import {BlankInput, MiddlewareHandler} from 'hono/types';
import {ServerOptions} from '../../types.js';
import {Env} from '../../env.js';
import {Room} from '../../Room.js';

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

export function getPublicChatAPI<Bindings extends Env>(options: ServerOptions<Bindings>) {
	const {services, upgradeWebSocket} = options;

	const app = new Hono<{Bindings: Bindings}>()
		.get('/', async (c) => {
			return c.text('Hello World!');
		})
		// we need to cast the function as WebsocketResponse so client get the correct type
		// but by doing so. we then need to also type the context manually
		.get('/room/:name/ws', ((c: Context<{Bindings: Bindings}, '/room/:name/ws', BlankInput>) => {
			Room.services = services;
			const room = services.getRoom(c.env, c.req.param().name);
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
		);

	return app;
}
