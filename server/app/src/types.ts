import {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {DrizzleD1Database} from 'drizzle-orm/d1';
import {LibSQLDatabase} from 'drizzle-orm/libsql';
import {Context, Hono} from 'hono';
import {Bindings} from 'hono/types';
import {WSEvents} from 'hono/ws';

export type Server<Env extends Bindings = Bindings> = {
	app: Hono<{Bindings: Env}>;
	handleWebsocket(c: Context<{Bindings: Env}>): WSEvents | Promise<WSEvents>;
};

export type ServerObjetInstance = {
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
	upgradeWebsocket(request: Request): Promise<Response>;
	getWebSockets(tag?: string): WebSocket[];
};

export type ServerObjetHandler = {
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> | void;
	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> | void;
};

export type ServerObjectId = {
	toString(): string;
	equals(other: DurableObjectId): boolean;
	readonly name?: string;
};

// export type ServerObjectState = {
// 	//   waitUntil(promise: Promise<any>): void;
// 	readonly id: ServerObjectId;
// 	//   readonly storage: DurableObjectStorage;
// 	//   blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
// 	acceptWebSocket(ws: WebSocket, tags?: string[]): void;
// 	getWebSockets(tag?: string): WebSocket[];
// 	//   setWebSocketAutoResponse(maybeReqResp?: WebSocketRequestResponsePair): void;
// 	//   getWebSocketAutoResponse(): WebSocketRequestResponsePair | null;
// 	//   getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null;
// 	//   setHibernatableWebSocketEventTimeout(timeoutMs?: number): void;
// 	//   getHibernatableWebSocketEventTimeout(): number | null;
// 	//   getTags(ws: WebSocket): string[];
// };

export type ServerOptions<
	Env extends Bindings = Bindings,
	TSchema extends Record<string, unknown> = Record<string, never>,
> = {
	getDB: (
		c: Context<{Bindings: Env}>,
	) =>
		| BetterSQLite3Database<TSchema>
		| DrizzleD1Database<TSchema>
		| BunSQLiteDatabase<TSchema>
		| LibSQLDatabase<TSchema>;
	getServerObject: (
		c: Context<{Bindings: Env}>,
		idOrName: ServerObjectId | string,
		implementation: (instance: ServerObjetInstance) => ServerObjetHandler,
	) => ServerObjetInstance;
};
