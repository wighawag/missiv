import {Hono} from 'hono';
import {cors} from 'hono/cors';
import {RouteOptions, ServerOptions} from './types.js';
import {createInProcessTokenBuckets} from './rate-limit.js';
import {getPrivateChatAPI} from './api/private/index.js';
import {getMessagesAPI} from './api/messages/index.js';
import {getPublicChatAPI} from './api/public/index.js';
import {getUserAPI} from './api/user/index.js';
import {getAdminAPI} from './api/admin/index.js';
import {getSessionAPI} from './api/session/index.js';
import {getInboxAPI, getInboxChangesAPI, getRoutedInboxAPI} from './api/inbox/index.js';
import {createInboxVersionCache} from './stores/versions.js';
import {HTTPException} from 'hono/http-exception';
import {Env} from './env.js';
import {MissivError} from './errors.js';
import type {ErrorResponse, RateLimitedDetails} from '@missiv/common';

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
	InboxChanges,
	InboxUpdate,
	KeyDirectory,
	LiveConnection,
	LiveInbox,
	LiveInboxHost,
	LiveInboxRouter,
	PushRecipient,
	Stores,
} from './stores/index.js';
export {
	cachedKeyDirectory,
	createInboxVersionCache,
	createSQLStores,
	inboxChangesOf,
	SQLConversationStore,
	SQLInbox,
	SQLKeyDirectory,
	type InboxVersionCache,
	type KeyDirectoryCache,
} from './stores/index.js';
export {answerSync, checkInboxUpgrade, type SyncStores} from './api/inbox/index.js';
export {inboxTransportsFromEnv, requireInboxTransport, type InboxTransports} from './transports.js';
export {signSessionToken, verifySessionToken, type SessionClaims} from './session.js';
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
export {
	charge,
	createInProcessTokenBuckets,
	createTokenBuckets,
	DEFAULT_TOKEN_BUCKETS,
	limitPerIP,
	tokenBucketConfigsFromEnv,
	type InProcessTokenBuckets,
	type ServerTokenBuckets,
	type TokenBucketConfig,
	type TokenBucketResult,
	type TokenBuckets,
} from './rate-limit.js';
export {createInProcessRooms, InMemoryRoom, InMemoryRateLimiter, InMemoryObjectStorage} from './memory.js';

const corsSetup = cors({
	origin: '*',
	allowHeaders: ['X-Custom-Header', 'Upgrade-Insecure-Requests', 'Content-Type', 'SIGNATURE', 'Authorization'],
	allowMethods: ['POST', 'GET', 'HEAD', 'OPTIONS'],
	exposeHeaders: ['Content-Length', 'X-Kuma-Revision', 'Retry-After'],
	maxAge: 600,
});

export function createServer<CustomEnv extends Env>(serverOptions: ServerOptions<CustomEnv>) {
	// one set of buckets for every route (/session and register share the IP's)
	const options: RouteOptions<CustomEnv> = {
		...serverOptions,
		getTokenBuckets: serverOptions.getTokenBuckets ?? createInProcessTokenBuckets(),
		// where this process holds the sockets it is the only instance: it may answer an unchanged poll from memory
		inboxVersionCache: serverOptions.liveInbox ? createInboxVersionCache() : undefined,
	};
	const app = new Hono<{Bindings: CustomEnv}>().get('/', (c) => {
		return c.text('missiv');
	});

	const userAPI = getUserAPI(options);
	const privateChatAPI = getPrivateChatAPI(options);
	const messagesAPI = getMessagesAPI(options);
	const publicChatAPI = getPublicChatAPI(options);
	const adminAPI = getAdminAPI(options);
	const sessionAPI = getSessionAPI(options);

	// the polling transport, on the stores alone (ADR-0006 "Amendment: the inbox version and polling")
	app.route('/api/inbox', getInboxChangesAPI(options));
	if (options.liveInbox) {
		// the live channel, where this process holds the sockets (ADR-0006 "Live channel")
		app.route('/api/inbox', getInboxAPI(options, options.liveInbox));
	} else if (options.getLiveInboxRouter) {
		// the live channel, where another object holds the sockets (cf-worker's Inbox objects)
		app.route('/api/inbox', getRoutedInboxAPI(options, options.getLiveInboxRouter));
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
				if (err.code === 'rate_limited') {
					const {retryAfterMs} = err.details as RateLimitedDetails;
					c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
				}
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
