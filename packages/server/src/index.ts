import {Context, Hono} from 'hono';
import type {WSEvents} from 'hono/ws';
import type {Bindings} from 'hono/types';
import type {ServerOptions} from './types.js';

export type WebsocketHandler<Env extends Bindings> = (c: Context<{Bindings: Env}>) => WSEvents | Promise<WSEvents>;

export type Server<Env extends Bindings> = {app: Hono<{Bindings: Env}>; handleWebsocket: WebsocketHandler<Env>};

function createServerApp<Env extends Bindings>() {
	const app = new Hono<{Bindings: Env & {}}>();

	app.get('/', (c) => {
		return c.text('Hello dd!');
	});
	return app;
}

export function createServer<Env extends Bindings = Bindings>(options: ServerOptions<Env>): Server<Env> {
	const {getDB} = options;

	const app = createServerApp<Env>();
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
