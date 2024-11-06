import {Context, Hono} from 'hono';
import {cors} from 'hono/cors';
import type {WSEvents} from 'hono/ws';
import type {Bindings} from 'hono/types';
import type {ServerOptions} from './types.js';
import {setup} from './setup.js';
import {getPublicAPI} from './api/index.js';

export type WebsocketHandler<Env extends Bindings> = (c: Context<{Bindings: Env}>) => WSEvents | Promise<WSEvents>;

export type Server<Env extends Bindings> = {
	app: any; //{fetch: any}; // TODO fetch, get ?
	handleWebsocket: WebsocketHandler<Env>;
};

function createAppWithPublicAPIOnly<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const app = new Hono<{Bindings: Env & {}}>().use(
		cors({
			origin: '*',
			allowHeaders: ['X-Custom-Header', 'Upgrade-Insecure-Requests', 'Content-Type', 'SIGNATURE'],
			allowMethods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
			exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
			maxAge: 600,
			credentials: true,
		}),
	);
	const publicAPI = getPublicAPI(options);
	const api = new Hono<{Bindings: Env & {}}>().use(setup({serverOptions: options})).route('/', publicAPI);
	return app.route('/api', api);
}

function createServerApp<Env extends Bindings>(options: ServerOptions<Env>) {
	return createAppWithPublicAPIOnly(options).get('/', (c) => {
		return c.text(`missiv api`);
	});
}

export function createServer<Env extends Bindings = Bindings>(options: ServerOptions<Env>): Server<Env> {
	const app = createServerApp<Env>(options);
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
