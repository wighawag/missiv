import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {Bindings} from 'hono/types';
import {ServerOptions} from './types.js';
import {getPrivateChatAPI} from './api/private/index.js';
import {getPublicChatAPI} from './api/public/index.js';
import {getUserAPI} from './api/user/index.js';
import {getAdminAPI} from './api/admin/index.js';

export type {ServerObject, ServerObjectId} from './types.js';

export * from './api/utils.js';
export type {Storage} from './storage/index.js';
export {Room} from './Room.js';

export function createServer<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const app = new Hono<{Bindings: Env & {}}>()
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
		});

	const userAPI = getUserAPI<Env>(options);
	const privateChatAPI = getPrivateChatAPI<Env>(options);
	const publicChatAPI = getPublicChatAPI<Env>(options);
	const adminAPI = getAdminAPI<Env>(options);

	return app
		.route('/api/user', userAPI)
		.route('/api/private', privateChatAPI)
		.route('/api/public', publicChatAPI)
		.route('/api/admin', adminAPI);
}

export type App = ReturnType<typeof createServer<{}>>;
