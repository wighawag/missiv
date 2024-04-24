import {Context, Hono} from 'hono';
import {cors} from 'hono/cors';
import {Bindings, BlankInput, MiddlewareHandler} from 'hono/types';
import {ServerOptions} from './types';
import {UpgradedWebSocketResponseInputJSONType} from 'hono/ws';
import {getMessagesAPI} from './api/messages';

export type {ServerObject, ServerObjectId} from './types';
export type {Storage} from './storage';
export {Room} from './Room';

export * from './utils/DB';

type WebsocketResponse = MiddlewareHandler<
	any,
	string,
	{
		in: {
			json: UpgradedWebSocketResponseInputJSONType;
		};
	}
>;

export function createServer<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const app = new Hono<{Bindings: Env & {}}>();
	const {getDB, getRoom, upgradeWebSocket} = options;

	const messagesAPI = getMessagesAPI<Env>(options);

	return (
		app
			.use(
				'/*',
				cors({
					// 'Access-Control-Allow-Origin': '*',
					// 'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
					// 'Access-Control-Allow-Headers': 'Content-Type,SIGNATURE',
					// 'Access-Control-Max-Age': '86400',
					// Allow: 'GET, HEAD, POST, OPTIONS',
					origin: '*',
					allowHeaders: ['X-Custom-Header', 'Upgrade-Insecure-Requests', 'Content-Type', 'SIGNATURE'],
					allowMethods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
					exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
					maxAge: 600,
					credentials: true,
				}),
			)
			.route('api/messages', messagesAPI)
			.get('/', (c) => {
				return c.text('Hello world!');
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
