import {ServerObjetInstance} from '../types';

export class ServerObjectHandlerExample {
	so: ServerObjetInstance;

	constructor(so: ServerObjetInstance) {
		this.so = so;
	}

	// Handle HTTP requests from clients.
	async fetch(request: Request): Promise<Response> {
		if (request.url.endsWith('/websocket')) {
			return this.so.upgradeWebsocket(request);
		} else if (request.url.endsWith('/getCurrentConnections')) {
			// Retrieves all currently connected websockets accepted via `acceptWebSocket()`.
			let numConnections: number = this.so.getWebSockets().length;
			if (numConnections == 1) {
				return new Response(`There is ${numConnections} WebSocket client connected to this Durable Object instance.`);
			}
			return new Response(`There are ${numConnections} WebSocket clients connected to this Durable Object instance.`);
		}

		// Unknown path, reply with usage info.
		return new Response(`
  This Server Object supports the following endpoints:
    /websocket
      - Creates a WebSocket connection. Any messages sent to it are echoed with a prefix.
    /getCurrentConnections
      - A regular HTTP GET endpoint that returns the number of currently connected WebSocket clients.
  `);
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		// Upon receiving a message from the client, reply with the same message,
		// but will prefix the message with "[Server Object]: ".
		ws.send(`[Server Object]: ${message}`);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		// If the client closes the connection, the runtime will invoke the webSocketClose() handler.
		ws.close(code, 'Server Object is closing WebSocket');
	}
}
