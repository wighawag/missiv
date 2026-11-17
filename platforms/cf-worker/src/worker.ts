// ------------------------------------------------------------------------------------------------
// Logging
// ------------------------------------------------------------------------------------------------
import 'named-logs-context';
import {enable as enableWorkersLogger} from 'workers-logger';
import {logs} from 'named-logs';
// ------------------------------------------------------------------------------------------------
import {createServer, Room, ServerObjectId, ServerObjectStorage, RateLimiter, Env, ServerObject} from 'missiv-server';
import {upgradeWebSocket} from 'hono/cloudflare-workers';
import {RemoteD1} from 'remote-sql-d1';
import {wrapWithLogger} from './logging/index.js';
import {Context} from 'hono';
import {CloudflareWorkerEnv} from './env.js';
import type {RemoteSQL} from 'remote-sql';

// ------------------------------------------------------------------------------------------------
enableWorkersLogger('*');
const logger = logs('missiv-cf-worker');
// ------------------------------------------------------------------------------------------------

const services = {
	getDB: (env: CloudflareWorkerEnv) => new RemoteD1(env.DB),
	getRoom: (env: CloudflareWorkerEnv, idOrName: ServerObjectId | string) => {
		if (typeof idOrName == 'string') {
			idOrName = env.ROOMS.idFromName(idOrName);
		}
		return env.ROOMS.get(idOrName);
	},
	getRateLimiter: (env: CloudflareWorkerEnv, idOrName: ServerObjectId | string) => {
		if (typeof idOrName == 'string') {
			idOrName = env.LIMITERS.idFromName(idOrName);
		}
		return env.LIMITERS.get(idOrName);
	},
};

export class ServerObjectRateLimiter extends RateLimiter<CloudflareWorkerEnv> {
	state: DurableObjectState;

	constructor(state: DurableObjectState, env: CloudflareWorkerEnv) {
		super(env);
		this.state = state;
		this.instantiate();
	}

	getStorage(): ServerObjectStorage {
		return this.state.storage;
	}

	saveSocketData(ws: WebSocket, data: any) {}

	retrieveSocketData(ws: WebSocket) {
		return {};
	}

	async upgradeWebsocket(request: Request): Promise<Response> {
		throw new Error(`no websocket connection expected`);
	}

	getWebSockets(tag?: string): WebSocket[] {
		return [];
	}

	async handleErrors(request: Request, func: () => Promise<Response>): Promise<Response> {
		try {
			return await func();
		} catch (err: any) {
			// the detail goes to the log; the client learns only that it failed
			console.error(err);
			if (request.headers.get('Upgrade') == 'websocket') {
				let pair = new WebSocketPair();
				pair[1].accept();
				pair[1].send(JSON.stringify({error: 'internal error', code: 'internal'}));
				pair[1].close(1011, 'Uncaught exception during session setup');
				return new Response(null, {status: 101, webSocket: pair[0]});
			} else {
				return new Response('internal error', {status: 500});
			}
		}
	}
}

// for each ServerObject we need a class that do the following:
export class ServerObjectRoom extends Room<CloudflareWorkerEnv> {
	state: DurableObjectState;

	constructor(state: DurableObjectState, env: CloudflareWorkerEnv) {
		super(env);
		this.state = state;
		this.instantiate();
	}

	getDB(env: Env): RemoteSQL {
		return services.getDB(this.env);
	}

	getRateLimiter(env: Env, idOrName: ServerObjectId | string): ServerObject {
		return services.getRateLimiter(this.env, idOrName);
	}

	getStorage(): ServerObjectStorage {
		return this.state.storage;
	}

	saveSocketData(ws: WebSocket, data: any) {
		ws.serializeAttachment({...ws.deserializeAttachment(), ...data});
	}

	retrieveSocketData(ws: WebSocket) {
		return ws.deserializeAttachment();
	}

	async upgradeWebsocket(request: Request): Promise<Response> {
		// Expect to receive a WebSocket Upgrade request.
		// If there is one, accept the request and return a WebSocket Response.
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('Durable Object expected Upgrade: websocket', {status: 426});
		}

		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `acceptWebSocket()` tells the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		// Unlike `ws.accept()`, `state.acceptWebSocket(ws)` informs the Workers Runtime that the WebSocket
		// is "hibernatable", so the runtime does not need to pin this Durable Object to memory while
		// the connection is open. During periods of inactivity, the Durable Object can be evicted
		// from memory, but the WebSocket connection will remain open. If at some later point the
		// WebSocket receives a message, the runtime will recreate the Durable Object
		// (run the `constructor`) and deliver the message to the appropriate handler.
		this.state.acceptWebSocket(server);

		// With the Hibernation API the runtime delivers the socket's events to this
		// object's webSocketMessage, webSocketClose and webSocketError (Room's), even
		// after the object was evicted: no listener is added here.

		try {
			// Get the client's IP address for use with the rate limiter.
			let ip = request.headers.get('CF-Connecting-IP');
			await this.webSocketOpen(server, {ip: ip ? ip : undefined});
		} catch (err) {
			console.error(`failed to handle open`, err);
		}

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	getWebSockets(tag?: string): WebSocket[] {
		return this.state.getWebSockets(tag);
	}

	async handleErrors(request: Request, func: () => Promise<Response>): Promise<Response> {
		try {
			return await func();
		} catch (err: any) {
			// the detail goes to the log; the client learns only that it failed
			console.error(err);
			if (request.headers.get('Upgrade') == 'websocket') {
				let pair = new WebSocketPair();
				pair[1].accept();
				pair[1].send(JSON.stringify({error: 'internal error', code: 'internal'}));
				pair[1].close(1011, 'Uncaught exception during session setup');
				return new Response(null, {status: 101, webSocket: pair[0]});
			} else {
				return new Response('internal error', {status: 500});
			}
		}
	}
}

export const app = createServer<CloudflareWorkerEnv>({
	services,
	getEnv: (c: Context<{Bindings: CloudflareWorkerEnv}>) => c.env,
	// the pushes of a new message run after the response
	waitUntil: (c, promise) => c.executionCtx.waitUntil(promise),
	upgradeWebSocket,
});

const fetch = async (request: Request, env: CloudflareWorkerEnv, ctx: ExecutionContext) => {
	return wrapWithLogger(request, env, ctx, async () => app.fetch(request, env, ctx));
};

export default {
	fetch,
	// // @ts-expect-error TS6133
	// async scheduled(event, env, ctx) {
	// 	ctx.waitUntil(() => {
	// 		console.log(`scheduled`);
	// 	});
	// },
};
