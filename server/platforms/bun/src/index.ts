import {Room, ServerObjectId, createServer} from 'missiv-server-app';
import {createBunWebSocket} from 'hono/bun';
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {Database} from 'bun:sqlite';
import {Context, Env} from 'hono';

const {upgradeWebSocket, websocket} = createBunWebSocket();

export function getDB() {
	const sqlite = new Database('sqlite.db');
	return drizzle(sqlite);
}

const rooms = new Map<string, BunRoom>();
class BunRoom extends Room {
	websockets: WebSocket[] = [];
	counter: number = 1;

	constructor(private name: string) {
		super();
		rooms.set(this.name, this);
	}

	async upgradeWebsocket(request: Request): Promise<Response> {
		if ((request as any).server) {
			const upgraded = (request as any).server.upgrade(request, {
				data: {
					room: this.name,
					id: this.counter++,
				},
			});
			console.log(upgraded);
			if (upgraded) {
				return;
			}
		}

		return new Response('Upgrade failed :(', {status: 500});
	}
	getWebSockets(): WebSocket[] {
		return this.websockets; // TODO
	}
	_addWebSocket(ws: WebSocket) {
		this.websockets.push(ws);
	}
	_removeWebSocket(ws: WebSocket) {
		const index = this.websockets.indexOf(ws);
		if (index >= 0) {
			this.websockets.splice(index, 1);
		}
	}
}

export function getRoom(c: Context<{Bindings: Env}>, idOrName: ServerObjectId | string) {
	return new BunRoom(idOrName.toString()); // TODO check toString for ServerObjectId
}

const app = createServer({getDB, getRoom, upgradeWebSocket});

Bun.serve({
	fetch: (request, server) => {
		(request as any).server = server;
		return app.fetch(request, server);
	},
	websocket: {
		open(ws) {
			const data = ws.data as {room: string} | undefined;
			if (data?.room) {
				console.log(`websocket:open: ${data.room}`);
				const room = rooms.get(data.room);
				room._addWebSocket(ws as any);
			} else {
				console.log(`global:websocket:open`);
				return websocket.open(ws as any);
			}
		},
		close(ws, code, reason) {
			const data = ws.data as {room: string} | undefined;
			if (data?.room) {
				console.log(`websocket:close: ${data.room}`);
				const room = rooms.get(data.room);
				room._removeWebSocket(ws as any);
				room.webSocketClose(ws as any, code, reason, true); // TODO wasClean == true ?
			} else {
				console.log(`global:websocket:close`);
				return websocket.close(ws as any, code, reason);
			}
		},
		message(ws, msg) {
			const data = ws.data as {room: string} | undefined;
			if (data?.room) {
				console.log(`websocket:message: ${data.room}`);
				const room = rooms.get(data.room);
				room.webSocketMessage(ws as any, msg.toString());
			} else {
				console.log(`global:websocket:message`);
				return websocket.message(ws as any, msg);
			}
		},
	},
});
