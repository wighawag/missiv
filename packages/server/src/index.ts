import {Context, Hono} from 'hono';
import {WSEvents} from 'hono/ws';
import {Bindings} from 'hono/types';
import {ServerOptions} from './types.js';

export function createServer<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const {getDB} = options;

	const app = new Hono<{Bindings: Env & {}}>();

	app.get('/', (c) => {
		return c.text('Hello dd!');
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
