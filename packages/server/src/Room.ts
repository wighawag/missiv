import {AbstractServerObject} from './types.js';

export abstract class Room extends AbstractServerObject {
	lastTimestamp = 0;

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

		const storage = this.getStorage();
		const fromStorage = await storage.list<string>({limit: 100});
		const entries = fromStorage.entries();
		for (const entry of entries) {
			ws.send(entry[1]);
		}
		// ws.send('welcome!');
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		const storage = this.getStorage();

		let data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
		console.log(`data: ${data}`);
		// Construct sanitized message for storage and broadcast.
		data = {message: '' + data.message};

		// Block people from sending overly long messages. This is also enforced on the client,
		// so to trigger this the user must be bypassing the client code.
		if (data.message.length > 256) {
			ws.send(JSON.stringify({error: 'Message too long.'}));
			return;
		}
		// Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
		// messages at the same time (or if the clock somehow goes backwards????), we'll assign
		// them sequential timestamps, so at least the ordering is maintained.
		data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
		this.lastTimestamp = data.timestamp;

		console.log(`message@: ${message}`);
		let key = new Date(data.timestamp).toISOString();
		let dataStr = JSON.stringify(data);
		await storage.put(key, dataStr);
		const sockets = this.getWebSockets();

		for (const socket of sockets) {
			if (ws != socket) {
				socket.send(dataStr);
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		console.log(`closing...`, code, reason, wasClean);
	}
}
