import {AbstractServerObject} from './types.js';

export abstract class Room extends AbstractServerObject {
	// Handle HTTP requests from clients.
	async fetch(request: Request): Promise<Response> {
		if (request.url.endsWith('/ws')) {
			return this.upgradeWebsocket(request);
		} else if (request.url.endsWith('/getCurrentConnections')) {
			// TODO cors ?
			// Retrieves all currently connected websockets accepted via `acceptWebSocket()`.
			let numConnections: number = this.getWebSockets().length;
			if (numConnections == 1) {
				return new Response(`There is ${numConnections} WebSocket client connected to this Server Object instance.`);
			}
			return new Response(`There are ${numConnections} WebSocket clients connected to this Server Object instance.`);
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

	async webSocketOpen(ws: WebSocket) {
		console.log('socket is open');
		ws.send('welcome!');
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		console.log(`message@: ${message}`);
		const sockets = this.getWebSockets();
		for (const socket of sockets) {
			if (ws != socket) {
				socket.send(message);
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		console.log(`closing...`, code, reason, wasClean);
	}
}
