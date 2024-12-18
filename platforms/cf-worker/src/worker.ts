import {createServer, Room} from 'missiv-server';
import {upgradeWebSocket} from 'hono/cloudflare-workers';
import {RemoteD1} from 'remote-sql-d1';
import {wrapWithLogger} from './logging';

type Env = {
	DB: D1Database;
	ROOMS: DurableObjectNamespace;
	DEV?: string;
};

// for each ServerObject we need a class that do the following:
export class ServerObjectRoom extends Room {
	state: DurableObjectState;

	constructor(state: DurableObjectState) {
		super();
		this.state = state;
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

		this.webSocketOpen(client);

		// Upon receiving a message from the client, the server replies with the same message,
		// and the total number of connections with the "[Durable Object]: " prefix
		server.addEventListener('message', (event) => {
			this.webSocketMessage(client, event.data);
		});

		// If the client closes the connection, the runtime will close the connection too.
		server.addEventListener('close', (cls) => {
			server.close(cls.code, 'Durable Object is closing WebSocket');
			this.webSocketClose(client, cls.code, cls.reason, cls.wasClean);
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	getWebSockets(tag?: string): WebSocket[] {
		return this.state.getWebSockets(tag);
	}
}

export const app = createServer<Env>({
	getDB: (c) => new RemoteD1(c.env.DB),
	getEnv: (c) => c.env,
	getRoom: (c, idOrName) => {
		if (typeof idOrName == 'string') {
			idOrName = c.env.ROOMS.idFromName(idOrName);
		}
		return c.env.ROOMS.get(idOrName);
	},
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
