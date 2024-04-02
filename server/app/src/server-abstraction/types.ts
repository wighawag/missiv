import {BetterSQLite3Database} from 'drizzle-orm/better-sqlite3';
import {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite';
import {DrizzleD1Database} from 'drizzle-orm/d1';
import {LibSQLDatabase} from 'drizzle-orm/libsql';
import {Context, Hono} from 'hono';
import {Bindings, MiddlewareHandler} from 'hono/types';
import {UpgradedWebSocketResponseInputJSONType, WSEvents} from 'hono/ws';
import {AbstractServerObject} from '.';

export type Server<Env extends Bindings = Bindings> = Hono<{Bindings: Env}>;

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
	getRoom: (c: Context<{Bindings: Env}>, idOrName: ServerObjectId | string) => AbstractServerObject;
	upgradeWebSocket: (createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => MiddlewareHandler<
		any,
		string,
		{
			in: {
				json: UpgradedWebSocketResponseInputJSONType;
			};
		}
	>;
};
