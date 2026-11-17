// Rooms and rate limiters held in the server's own memory, for the platforms that
// run as one long-lived process (nodejs, bun): what a Durable Object gives
// cf-worker, a Map gives them. Nothing survives a restart but the database: a
// room's recent history lives here, its stored messages live in the database
// only for direct messages.
import type {RemoteSQL} from 'remote-sql';
import type {Env} from './env.js';
import {RateLimiter} from './RateLimiter.js';
import {Room} from './Room.js';
import type {ServerObject, ServerObjectId, ServerObjectStorage} from './types.js';

/** The ServerObjectStorage of a Durable Object, as an insertion-ordered Map (keys are written in time order). */
export class InMemoryObjectStorage implements ServerObjectStorage {
	private data = new Map<string, unknown>();

	constructor(private maxEntries?: number) {}

	get<T = unknown>(key: string): Promise<T | undefined>;
	get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	get<T = unknown>(keys: string[] | string): Promise<T | undefined> | Promise<Map<string, T>> {
		if (Array.isArray(keys)) {
			const result = new Map<string, T>();
			for (const key of keys) {
				if (this.data.has(key)) {
					result.set(key, this.data.get(key) as T);
				}
			}
			return Promise.resolve(result);
		}
		return Promise.resolve(this.data.get(keys) as T | undefined);
	}

	list<T = unknown>(options?: {reverse?: boolean; limit?: number}): Promise<Map<string, T>> {
		const entries = [...this.data.entries()];
		if (options?.reverse) {
			entries.reverse();
		}
		const limited = options?.limit !== undefined ? entries.slice(0, options.limit) : entries;
		return Promise.resolve(new Map(limited as [string, T][]));
	}

	put<T>(key: string, value: T): Promise<void>;
	put<T>(entries: Record<string, T>): Promise<void>;
	put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
		const entries = typeof key === 'string' ? [[key, value] as const] : Object.entries(key);
		for (const [k, v] of entries) {
			this.data.delete(k);
			this.data.set(k, v);
		}
		// a room needs only its recent history: drop the oldest beyond the bound
		while (this.maxEntries !== undefined && this.data.size > this.maxEntries) {
			this.data.delete(this.data.keys().next().value as string);
		}
		return Promise.resolve();
	}

	delete(key: string): Promise<boolean>;
	delete(keys: string[]): Promise<number>;
	delete(keys: string[] | string): Promise<boolean> | Promise<number> {
		if (Array.isArray(keys)) {
			let count = 0;
			for (const key of keys) {
				count += this.data.delete(key) ? 1 : 0;
			}
			return Promise.resolve(count);
		}
		return Promise.resolve(this.data.delete(keys));
	}

	deleteAll(): Promise<void> {
		this.data.clear();
		return Promise.resolve();
	}
}

/** How many messages a room keeps in memory: the 100 its new sessions are sent, with room to spare. */
export const ROOM_HISTORY = 200;

/** A room held in process: its sockets are whatever the platform's WebSocket server hands over. */
export class InMemoryRoom<CustomEnv extends Env> extends Room<CustomEnv> {
	private storage = new InMemoryObjectStorage(ROOM_HISTORY);
	private sockets = new Set<WebSocket>();

	constructor(
		env: CustomEnv,
		private services: {getDB(env: CustomEnv): RemoteSQL; getRateLimiter(env: CustomEnv, name: string): ServerObject},
	) {
		super(env);
		this.instantiate();
	}

	getDB(): RemoteSQL {
		return this.services.getDB(this.env);
	}

	getRateLimiter(_env: Env, idOrName: ServerObjectId | string): ServerObject {
		return this.services.getRateLimiter(this.env, idOrName.toString());
	}

	getStorage(): ServerObjectStorage {
		return this.storage;
	}

	// a process does not hibernate: nothing to attach to a socket
	saveSocketData() {}
	retrieveSocketData() {
		return {};
	}

	getWebSockets(): WebSocket[] {
		return [...this.sockets];
	}

	/** The platform hands over each socket it accepted, and takes it back when it closes. */
	addWebSocket(ws: WebSocket) {
		this.sockets.add(ws);
	}
	removeWebSocket(ws: WebSocket) {
		this.sockets.delete(ws);
	}

	async upgradeWebsocket(): Promise<Response> {
		throw new Error(`an in-process room is upgraded by its platform's WebSocket server`);
	}

	async handleErrors(_request: Request, func: () => Promise<Response>): Promise<Response> {
		try {
			return await func();
		} catch (err) {
			console.error(err);
			return new Response('internal error', {status: 500});
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		this.removeWebSocket(ws);
		return super.webSocketClose(ws, code, reason, wasClean);
	}

	async webSocketError(ws: WebSocket, error: unknown) {
		this.removeWebSocket(ws);
		return super.webSocketError(ws, error);
	}
}

/** A rate limiter held in process. */
export class InMemoryRateLimiter<CustomEnv extends Env> extends RateLimiter<CustomEnv> {
	private storage = new InMemoryObjectStorage();

	constructor(env: CustomEnv) {
		super(env);
		this.instantiate();
	}

	getStorage(): ServerObjectStorage {
		return this.storage;
	}
	saveSocketData() {}
	retrieveSocketData() {
		return {};
	}
	async upgradeWebsocket(): Promise<Response> {
		throw new Error(`no websocket connection expected`);
	}
	getWebSockets(): WebSocket[] {
		return [];
	}
	async handleErrors(_request: Request, func: () => Promise<Response>): Promise<Response> {
		try {
			return await func();
		} catch (err) {
			console.error(err);
			return new Response('internal error', {status: 500});
		}
	}

	// a server object's fetch takes a URL or a request, as a Durable Object stub does
	async fetch(requestInfo: RequestInfo, requestInit?: RequestInit): Promise<Response> {
		return super.fetch(requestInfo instanceof Request ? requestInfo : new Request(requestInfo, requestInit));
	}
}

/**
 * The rooms and rate limiters of one process, one per name, created on first
 * use. Room names are free-form, so the number of rooms is bounded by
 * `maxRooms`: past it, the room with no socket that was used least recently is
 * dropped (its in-memory history with it).
 */
export function createInProcessRooms<CustomEnv extends Env>(options: {
	getDB(env: CustomEnv): RemoteSQL;
	maxRooms?: number;
}) {
	const maxRooms = options.maxRooms ?? 10_000;
	const rooms = new Map<string, InMemoryRoom<CustomEnv>>();
	const limiters = new Map<string, InMemoryRateLimiter<CustomEnv>>();

	function getRateLimiter(env: CustomEnv, idOrName: ServerObjectId | string): ServerObject {
		const name = idOrName.toString();
		let limiter = limiters.get(name);
		if (!limiter) {
			limiter = new InMemoryRateLimiter(env);
			limiters.set(name, limiter);
		}
		return limiter;
	}

	function getRoom(env: CustomEnv, idOrName: ServerObjectId | string): InMemoryRoom<CustomEnv> {
		const name = idOrName.toString();
		let room = rooms.get(name);
		if (room) {
			rooms.delete(name);
		} else {
			room = new InMemoryRoom(env, {getDB: options.getDB, getRateLimiter});
		}
		rooms.set(name, room);
		if (rooms.size > maxRooms) {
			for (const [key, candidate] of rooms) {
				if (candidate.getWebSockets().length === 0) {
					rooms.delete(key);
					break;
				}
			}
		}
		return room;
	}

	return {getRoom, getRateLimiter};
}
