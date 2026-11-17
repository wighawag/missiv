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

export function getPublicChatAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const {services, inProcessRooms, upgradeWebSocket} = options;

	if (inProcessRooms) {
		// a room held in this process: check the request, then hand the socket the
		// platform's WebSocket server accepts to the room
		const app = new Hono<{Bindings: CustomEnv}>().get(
			'/room/:name/ws',
			async (c, next) => {
				const room = inProcessRooms.getRoom(options.getEnv(c), c.req.param('name'));
				const refused = room.prepareConnection(c.req.raw);
				if (refused) {
					return refused;
				}
				return next();
			},
			upgradeWebSocket((c) => {
				const room = inProcessRooms.getRoom(options.getEnv(c), c.req.param('name') as string);
				const ip = inProcessRooms.getIP?.(c);
				// the runtime's own socket: stable for the connection's life (a WSContext may
				// be created per event), with send and close
				const socket = (ws: {raw?: unknown}) => (ws.raw ?? ws) as WebSocket;
				return {
					onOpen(_event, ws) {
						room.addWebSocket(socket(ws));
						room.webSocketOpen(socket(ws), {ip}).catch((err) => console.error(err));
					},
					onMessage(event, ws) {
						room.webSocketMessage(socket(ws), event.data as string).catch((err) => console.error(err));
					},
					onClose(event, ws) {
						const close = event as CloseEvent;
						room
							.webSocketClose(socket(ws), close.code, close.reason, close.wasClean)
							.catch((err) => console.error(err));
					},
					onError(event, ws) {
						room.webSocketError(socket(ws), event).catch((err) => console.error(err));
					},
				};
			}),
		);
		return app;
	}

	const app = new Hono<{Bindings: CustomEnv}>()
		// we need to cast the function as WebsocketResponse so client get the correct type
		// but by doing so. we then need to also type the context manually
		.get('/room/:name/ws', ((c: Context<{Bindings: CustomEnv}, '/room/:name/ws', BlankInput>) => {
			const room = services.getRoom(options.getEnv(c), c.req.param().name);
			return room.fetch(c.req.raw);
		}) as WebsocketResponse);

	return app;
}
