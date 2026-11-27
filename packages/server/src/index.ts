import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {ServerOptions} from './types.js';
import {getPrivateChatAPI} from './api/private/index.js';
import {getMessagesAPI} from './api/messages/index.js';
import {getPublicChatAPI} from './api/public/index.js';
import {getUserAPI} from './api/user/index.js';
import {getAdminAPI} from './api/admin/index.js';
import {getSessionAPI} from './api/session/index.js';
import {getInboxAPI} from './api/inbox/index.js';
import {HTTPException} from 'hono/http-exception';
import {Env} from './env.js';
import {MissivError} from './errors.js';
import type {ErrorResponse} from '@missiv/common';

export {MissivError};

export type {Env};

export type {
	Services,
	ServerOptions,
	ServerObject,
	ServerObjectId,
	AbstractServerObject,
	ServerObjectStorage,
	InProcessRoom,
} from './types.js';

export type {
	AppendResult,
	ConversationKey,
	ConversationStore,
	Inbox,
	InboxUpdate,
	KeyDirectory,
	LiveConnection,
	LiveInbox,
	LiveInboxHost,
	PushRecipient,
	Stores,
} from './stores/index.js';
export {createSQLStores, SQLConversationStore, SQLInbox, SQLKeyDirectory} from './stores/index.js';
export {Room} from './Room.js';
export {createInProcessLiveInbox} from './live.js';
export {RateLimiter} from './RateLimiter.js';
export {migrate, resetDatabase} from './schema/migrate.js';
export {
	createHTTPPushNotifier,
	parsePushTokens,
	pushKey,
	pushMessage,
	pushNotifierFromEnv,
	type NewMessageNotification,
	type PushNotifier,
} from './push.js';
export {createInProcessRooms, InMemoryRoom, InMemoryRateLimiter, InMemoryObjectStorage} from './memory.js';

const corsSetup = cors({
	origin: '*',
	allowHeaders: ['X-Custom-Header', 'Upgrade-Insecure-Requests', 'Content-Type', 'SIGNATURE', 'Authorization'],
	allowMethods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
	exposeHeaders: ['Content-Length', 'X-Kuma-Revision'],
	maxAge: 600,
});

export function createServer<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	const app = new Hono<{Bindings: CustomEnv}>().get('/', (c) => {
		return c.text('missiv');
	});

	const userAPI = getUserAPI(options);
	const privateChatAPI = getPrivateChatAPI(options);
	const messagesAPI = getMessagesAPI(options);
	const publicChatAPI = getPublicChatAPI(options);
	const adminAPI = getAdminAPI(options);
	const sessionAPI = getSessionAPI(options);

	if (options.liveInbox) {
		// the live channel, where this process holds the sockets (ADR-0006 "Live channel")
		app.route('/api/inbox', getInboxAPI(options, options.liveInbox));
	}

	return app
		.use('/*', corsSetup)
		.route('/api/public', publicChatAPI)
		.route('/api/session', sessionAPI)
		.route('/api/user', userAPI)
		.route('/api/private', privateChatAPI)
		.route('/api/messages', messagesAPI)
		.route('/api/admin', adminAPI)
		.onError((err, c) => {
			const config = c.get('config');
			const env = config?.env || {};
			if (err instanceof MissivError) {
				return c.json(err.toResponseBody(), err.status);
			}
			if (err instanceof HTTPException) {
				return err.getResponse();
			}
			console.error(err);
			return c.json(
				{
					error: {
						code: 'internal',
						message: err.message,
						...(env.EXPOSE_ERRORS === 'true' ? {details: {cause: err.cause, stack: err.stack}} : {}),
					},
				} satisfies ErrorResponse,
				500,
			);
		});
}

export type App = ReturnType<typeof createServer<{}>>;
