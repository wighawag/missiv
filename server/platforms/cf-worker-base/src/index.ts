import {createServer, ServerObjetHandler} from 'missiv-server-app';
import {upgradeWebSocket} from 'hono/cloudflare-workers';
import {drizzle} from 'drizzle-orm/d1';

type Env = {
	DB: D1Database;
	WEBSOCKET_HIBERNATION_SERVER: DurableObjectNamespace;
};

export class WebSocketHibernationServer {
	state: DurableObjectState;
	_handler!: ServerObjetHandler;

	constructor(state: DurableObjectState) {
		this.state = state;
	}

	setHandler(handler: ServerObjetHandler): void {
		this._handler = handler;
	}

	// Handle HTTP requests from clients.
	async fetch(request: Request): Promise<Response> {
		return this._handler.fetch(request);
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

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	getWebSockets(tag?: string): WebSocket[] {
		return this.state.getWebSockets(tag);
	}

	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		return this._handler.webSocketMessage(ws, message);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		return this._handler.webSocketClose(ws, code, reason, wasClean);
	}
}

const {app, handleWebsocket} = createServer<Env>({
	getDB: (c) => drizzle(c.env.DB),
	getServerObject: (c, idOrName, implementation) => {
		if (typeof idOrName == 'string') {
			idOrName = c.env.WEBSOCKET_HIBERNATION_SERVER.idFromName(idOrName);
		}
		let stub: DurableObjectStub = c.env.WEBSOCKET_HIBERNATION_SERVER.get(idOrName);
		const instance = stub as unknown as WebSocketHibernationServer;
		instance.setHandler(implementation(instance));
		return instance;
	},
});

app.get('/ws', upgradeWebSocket(handleWebsocket));

export default {
	fetch: app.fetch,
	// @ts-expect-error TS6133
	async scheduled(event, env, ctx) {
		ctx.waitUntil(() => {
			console.log(`scheduled`);
		});
	},
};
