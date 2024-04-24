import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {Bindings} from 'hono/types';
import {ServerOptions} from './types';
import {getPrivateChatAPI} from './api/private';
import {getPublicChatAPI} from './api/public';

export type {ServerObject, ServerObjectId} from './types';
export type {Storage} from './storage';
export {Room} from './Room';

export * from './utils/DB';

export function createServer<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const app = new Hono<{Bindings: Env & {}}>();

	const privateChatAPI = getPrivateChatAPI<Env>(options);
	const publicChatAPI = getPublicChatAPI<Env>(options);

	return app
		.use(
			'/*',
			cors({
				origin: '*',
				allowHeaders: ['X-Custom-Header', 'Upgrade-Insecure-Requests', 'Content-Type', 'SIGNATURE'],
				allowMethods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
				exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
				maxAge: 600,
				credentials: true,
			}),
		)
		.get('/', (c) => {
			return c.text('Hello world!');
		})
		.route('api/private', privateChatAPI)
		.route('api/public', publicChatAPI);
}
