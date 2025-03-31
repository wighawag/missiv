// ------------------------------------------------------------------------------------------------
// Logging
// ------------------------------------------------------------------------------------------------
import 'named-logs-context';
import {enable as enableWorkersLogger} from 'workers-logger';
import {logs} from 'named-logs';
// ------------------------------------------------------------------------------------------------
import {createServer, Room, ServerObjectId, ServerObjectStorage, RateLimiter} from 'missiv-server';
import {upgradeWebSocket} from 'hono/cloudflare-workers';
import {RemoteD1} from 'remote-sql-d1';
import {wrapWithLogger} from './logging/index.js';
import {Context} from 'hono';

// ------------------------------------------------------------------------------------------------
enableWorkersLogger('*');
const logger = logs('missiv-cf-worker');
// ------------------------------------------------------------------------------------------------

type Env = {
	DB: D1Database;
	ROOMS: DurableObjectNamespace;
	LIMITERS: DurableObjectNamespace;
	DEV?: string;
};

export class ServerObjectRateLimiter extends RateLimiter<Env> {
	state: DurableObjectState;

	constructor(state: DurableObjectState, env: Env) {
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

	// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
	// try/catch and return errors to the client. You probably wouldn't want to use this in production
	// code but it is convenient when debugging and iterating.
	async handleErrors(request: Request, func: () => Promise<Response>): Promise<Response> {
		try {
			return await func();
		} catch (err: any) {
			if (request.headers.get('Upgrade') == 'websocket') {
				// Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
				// won't show us the response body! So... let's send a WebSocket response with an error
				// frame instead.
				let pair = new WebSocketPair();
				pair[1].accept();
				pair[1].send(JSON.stringify({error: err.stack}));
				pair[1].close(1011, 'Uncaught exception during session setup');
				return new Response(null, {status: 101, webSocket: pair[0]});
			} else {
				return new Response(err.stack, {status: 500});
			}
		}
	}
}

// for each ServerObject we need a class that do the following:
export class ServerObjectRoom extends Room<Env> {
	state: DurableObjectState;

	constructor(state: DurableObjectState, env: Env) {
		super(env);
		this.state = state;
		this.instantiate();

		console.log({serverObjectId: this.state.id});
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

		// Upon receiving a message from the client, the server replies with the same message,
		// and the total number of connections with the "[Durable Object]: " prefix
		server.addEventListener('message', async (event) => {
			// console.log('message', event);
			await this.webSocketMessage(client, event.data);
		});

		// If the client closes the connection, the runtime will close the connection too.
		server.addEventListener('close', async (event) => {
			// console.log('close', event);
			try {
				server.close(event.code, 'Durable Object is closing WebSocket');
				// TODO client.close ?
			} catch (err) {
				console.error(`failed to close`, err);
			}
			try {
				await this.webSocketClose(client, event.code, event.reason, event.wasClean);
			} catch (err) {
				console.error(`failed to handle close`, err);
			}
		});

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

	// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
	// try/catch and return errors to the client. You probably wouldn't want to use this in production
	// code but it is convenient when debugging and iterating.
	async handleErrors(request: Request, func: () => Promise<Response>): Promise<Response> {
		try {
			return await func();
		} catch (err: any) {
			if (request.headers.get('Upgrade') == 'websocket') {
				// Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
				// won't show us the response body! So... let's send a WebSocket response with an error
				// frame instead.
				let pair = new WebSocketPair();
				pair[1].accept();
				pair[1].send(JSON.stringify({error: err.stack}));
				pair[1].close(1011, 'Uncaught exception during session setup');
				return new Response(null, {status: 101, webSocket: pair[0]});
			} else {
				return new Response(err.stack, {status: 500});
			}
		}
	}
}

const services = {
	getDB: (env: Env) => new RemoteD1(env.DB),
	getRoom: (env: Env, idOrName: ServerObjectId | string) => {
		if (typeof idOrName == 'string') {
			idOrName = env.ROOMS.idFromName(idOrName);
		}
		return env.ROOMS.get(idOrName);
	},
	getRateLimiter: (env: Env, idOrName: ServerObjectId | string) => {
		if (typeof idOrName == 'string') {
			idOrName = env.LIMITERS.idFromName(idOrName);
		}
		return env.LIMITERS.get(idOrName);
	},
};

export const app = createServer<Env>({
	services,
	getEnv: (c: Context<{Bindings: Env}>) => c.env,
	upgradeWebSocket,
});

const fetch = async (request: Request, env: Env, ctx: ExecutionContext) => {
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
