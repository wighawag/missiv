#!/usr/bin/env bun
import 'named-logs-context';
import {Room, ServerObject, ServerObjectId, ServerObjectStorage, createServer, type Env} from 'missiv-server';
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

type Entry<Key, Value> = {
	prev: Entry<Key, Value> | null;
	next: Entry<Key, Value> | null;
	key: Key;
	value: Value;
};
class BidirectionalMap<Key, Value> {
	map: Map<Key, Entry<Key, Value>>;
	first: Entry<Key, Value> | null;
	last: Entry<Key, Value> | null;
	constructor() {
		this.map = new Map();
		this.first = null;
		this.last = null;
	}

	set(key: Key, value: Value) {
		const entry: Entry<Key, Value> = {key, value, prev: this.last, next: null};

		if (this.last) {
			this.last.next = entry;
		} else {
			this.first = entry;
		}

		this.last = entry;
		this.map.set(key, entry);
		return this;
	}

	get(key: Key) {
		const entry = this.map.get(key);
		return entry ? entry.value : undefined;
	}

	delete(key: Key) {
		if (!this.map.has(key)) {
			return false;
		}

		const entry = this.map.get(key) as Entry<Key, Value>;

		// Update the links of adjacent entries
		if (entry.prev) {
			entry.prev.next = entry.next;
		} else {
			// This was the first entry
			this.first = entry.next;
		}

		if (entry.next) {
			entry.next.prev = entry.prev;
		} else {
			// This was the last entry
			this.last = entry.prev;
		}

		this.map.delete(key);
		return true;
	}

	clear() {
		this.map.clear();
		this.first = null;
		this.last = null;
	}

	// Forward iterator
	*[Symbol.iterator](): IterableIterator<[Key, Value]> {
		let current = this.first;
		while (current) {
			yield [current.key, current.value];
			current = current.next;
		}
	}

	// Reverse iterator
	*reverseIterator(): IterableIterator<[Key, Value]> {
		let current = this.last;
		while (current) {
			yield [current.key, current.value];
			current = current.prev;
		}
	}
}

class SimpleObjectStorage implements ServerObjectStorage {
	data: BidirectionalMap<string, unknown>;
	constructor() {
		this.data = new BidirectionalMap();
	}

	delete(key: string): Promise<boolean>;
	delete(keys: string[]): Promise<number>;
	delete(keys: string[] | string): Promise<boolean> | Promise<number> {
		if (Array.isArray(keys)) {
			for (const key of keys) {
				this.data.delete(key);
			}
			return Promise.resolve(keys.length);
		}
		this.data.delete(keys);
		return Promise.resolve(true);
	}

	deleteAll(): Promise<void> {
		this.data.clear();
		return Promise.resolve();
	}

	get<T = unknown>(key: string): Promise<T | undefined>;
	get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	get<T = unknown>(keys: string[] | string): Promise<T | undefined> | Promise<Map<string, T>> {
		if (Array.isArray(keys)) {
			const result = new Map<string, T>();
			for (const key of keys) {
				const value = this.data.get(key) as T | undefined;
				if (value) {
					result.set(key, value);
				}
			}
			return Promise.resolve(result);
		}
		const result = this.data.get(keys) as T | undefined;
		return Promise.resolve(result);
	}

	list<T = unknown>(options?: {reverse?: boolean; limit?: number}): Promise<Map<string, T>> {
		const result = new Map<string, T>();

		let count = 0;
		for (const item of options?.reverse ? this.data.reverseIterator() : this.data) {
			if (options?.limit && count >= options.limit) break;
			result.set(item[0], item[1] as T);
			count++;
		}
		return Promise.resolve(result);
	}

	put<T>(key: string, value: T): Promise<void>;
	put<T>(entries: Record<string, T>): Promise<void>;
	put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
		if (typeof key === 'string') {
			console.log({key, value});
			this.data.set(key, value);

			this.list({reverse: true});
			this.list();
			return Promise.resolve();
		}
		const entries = Object.entries(key);
		for (const [key, value] of entries) {
			this.data.set(key, value);
		}
		return Promise.resolve();
	}
}

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

	class BunRoom extends Room {
		websockets: WebSocket[] = [];
		counter: number = 1;
		storage: ServerObjectStorage;

		constructor(private name: string) {
			console.log(`creating room ${name} on Bun`);
			super();
			this.storage = new SimpleObjectStorage();
			this.instantiate();
		}

		getStorage(): ServerObjectStorage {
			return this.storage;
		}

		saveSocketData(ws: WebSocket, data: any) {
			console.log(`can't save data, but don't need as if server stop all stop`);
		}

		retrieveSocketData(ws: WebSocket) {
			console.log(`can't retreve data, but don't need as if server stop all stop`);
			return {};
		}

		async upgradeWebsocket(request: Request): Promise<Response> {
			if ((request as any).server) {
				const upgraded = (request as any).server.upgrade(request, {
					data: {
						room: this.name,
						id: this.counter++,
					},
				});
				console.log('upgraded', upgraded);
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
			new Request('http://localhost/api/user/getUser?_initDB=true', {
				method: 'POST',
				body: JSON.stringify({
					type: 'getUser',
					address: '0xffffffffffffffffffffffffffffffffffffffff',
				}),
				headers: {
					'content-type': 'application/json',
				},
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
					const room = roomInstances.get(data.room) as (Room & BunRoom) | undefined;
					if (!room) {
						throw new Error(`np room for ${data.room}`);
					}
					room._addWebSocket(ws as any);
					// TODO ip with x-forwarded-for if available and if checked
					room.webSocketOpen(ws as any, {ip: ws.remoteAddress});
				} else {
					console.log(`global:websocket:open`);
					return websocket.open(ws as any);
				}
			},
			close(ws, code, reason) {
				const data = ws.data as {room: string} | undefined;
				if (data?.room) {
					console.log(`websocket:close: ${data.room}`);
					const room = roomInstances.get(data.room) as (Room & BunRoom) | undefined;
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
					console.log(`room ${data.room}`);
					const room = roomInstances.get(data.room) as (Room & BunRoom) | undefined;
					if (!room) {
						throw new Error(`no room for ${data.room}`);
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
