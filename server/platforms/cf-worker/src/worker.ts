import { createServer, Room } from 'missiv-server-app';
import { upgradeWebSocket } from 'hono/cloudflare-workers';
import { RemoteD1 } from './api/d1db';

type Env = {
	DB: D1Database;
	ROOM_DO: DurableObjectNamespace;
};

// for each ServerObject we need a class that do the following:
export class ChatRoom extends Room {
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
			return new Response('Durable Object expected Upgrade: websocket', { status: 426 });
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

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	getWebSockets(tag?: string): WebSocket[] {
		return this.state.getWebSockets(tag);
	}
}

const app = createServer<Env>({
	getDB: (c) => new RemoteD1(c.env.DB),
	getRoom: (c, idOrName) => {
		if (typeof idOrName == 'string') {
			idOrName = c.env.ROOM_DO.idFromName(idOrName);
		}
		return c.env.ROOM_DO.get(idOrName);
	},
	upgradeWebSocket,
});

export default {
	fetch: app.fetch,
	// @ts-expect-error TS6133
	async scheduled(event, env, ctx) {
		ctx.waitUntil(() => {
			console.log(`scheduled`);
		});
	},
};
