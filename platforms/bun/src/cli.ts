#!/usr/bin/env bun
import 'named-logs-context';
import {Room, ServerObject, ServerObjectId, createServer, type Env} from 'missiv-server';
import {createBunWebSocket} from 'hono/bun';
import {Database} from 'bun:sqlite';
import {Context} from 'hono';
import {RemoteBunSQL} from './remote-sql-bun/index.js';
import fs from 'node:fs';
import path from 'node:path';
import {Command} from 'commander';
import {loadEnv} from 'ldenv';

const __dirname = import.meta.dirname;

loadEnv({
	defaultEnvFile: path.join(__dirname, '../.env.default'),
});

type BunEnv = Env & {
	DB: string;
};

type Options = {
	port?: string;
	processInterval?: string;
};

async function main() {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'));
	const program = new Command();

	program
		.name('missiv-server-bun')
		.version(pkg.version)
		.usage(`missiv-server-bun [--port 2000] [--sql <sql-folder>]`)
		.description('run missiv-server-bun as a node process')
		.option('-p, --port <port>');

	program.parse(process.argv);

	const options: Options = program.opts();
	const port = options.port ? parseInt(options.port) : 2000;

	const env = process.env as BunEnv;

	const dbURL = env.DB;
	const db = new RemoteBunSQL(new Database(dbURL, {strict: true}));

	function getDB() {
		return db;
	}

	function getEnv(): BunEnv {
		return env;
	}

	const {upgradeWebSocket, websocket} = createBunWebSocket();

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
					return new Response(); // TODO  ?
				}
			}

			return new Response('Upgrade failed :(', {status: 500});
		}
		getWebSockets(): WebSocket[] {
			return this.websockets; // TODO
		}
		_addWebSocket(ws: WebSocket) {
			this.websockets.push(ws);
			console.log(`one ws added: ${this.websockets.length} total`);
		}
		_removeWebSocket(ws: WebSocket) {
			const index = this.websockets.indexOf(ws);
			if (index >= 0) {
				this.websockets.splice(index, 1);
				console.log(`one ws removed at index (${index}): ${this.websockets.length} total`);
			}
		}
	}

	const roomInstances: Map<string, ServerObject> = new Map();

	function getRoom(c: Context<{Bindings: BunEnv}>, idOrName: ServerObjectId | string): ServerObject {
		const name = idOrName.toString(); // TODO check toString for ServerObjectId
		if (roomInstances.has(name)) {
			return roomInstances.get(name)!;
		}
		const newRoom = new BunRoom(name);
		roomInstances.set(name, newRoom);
		return newRoom;
	}

	const app = createServer<BunEnv>({getDB, getRoom, getEnv, upgradeWebSocket});

	if (dbURL === ':memory:') {
		console.log(`executing setup...`);
		await app.fetch(
			new Request('http://localhost/api/admin/setup', {
				// headers: {
				// 	Authorization: `Basic ${btoa(`admin:${TOKEN_ADMIN}`)}`,
				// },
			}),
		);
	}

	Bun.serve({
		port,
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
					if (!room) {
						throw new Error(`np room for ${data.room}`);
					}
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
					if (!room) {
						throw new Error(`np room for ${data.room}`);
					}
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
					if (!room) {
						throw new Error(`np room for ${data.room}`);
					}
					room.webSocketMessage(ws as any, msg.toString());
				} else {
					console.log(`global:websocket:message`);
					return websocket.message(ws as any, msg);
				}
			},
		},
	});
	console.log(`Server is running on :${port}`);
}

main();
