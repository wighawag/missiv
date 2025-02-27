import {Context} from 'hono';
import {Bindings, MiddlewareHandler} from 'hono/types';
import {WSEvents} from 'hono/ws';
import {RemoteSQL} from 'remote-sql';

export type ServerObjectStorage = {
	get<T = unknown>(key: string): Promise<T | undefined>;
	get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
	list<T = unknown>(options?: {reverse?: boolean; limit?: number}): Promise<Map<string, T>>;
	put<T>(key: string, value: T): Promise<void>;
	put<T>(entries: Record<string, T>): Promise<void>;
	delete(key: string): Promise<boolean>;
	delete(keys: string[]): Promise<number>;
	deleteAll(): Promise<void>;
	//   transaction<T>(
	// 	closure: (txn: DurableObjectTransaction) => Promise<T>,
	//   ): Promise<T>;
	//   sync(): Promise<void>;
	//   sql: SqlStorage;
	//   transactionSync<T>(closure: () => T): T;
};

export abstract class AbstractServerObject {
	abstract instantiate(): void;
	abstract getStorage(): ServerObjectStorage;
	abstract upgradeWebsocket(request: Request): Promise<Response>;
	abstract getWebSockets(): WebSocket[];
	abstract saveSocketData(ws: WebSocket, data: Record<string, unknown>): void;
	abstract retrieveSocketData(ws: WebSocket): Record<string, unknown>;
}

export type ServerObjectId = {
	toString(): string;
	equals(other: ServerObjectId): boolean;
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

export type ServerOptions<Env extends Bindings = Bindings> = {
	getDB: (c: Context<{Bindings: Env}>) => RemoteSQL;
	getEnv: (c: Context<{Bindings: Env}>) => Env;
	getRoom: (c: Context<{Bindings: Env}>, idOrName: ServerObjectId | string) => ServerObject;
	upgradeWebSocket: (createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => MiddlewareHandler<
		any,
		string,
		{
			outputFormat: 'ws';
		}
	>;
};

// export type UpgradeWebSocket = (createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => MiddlewareHandler<any, string, {
//     in: {
//         json: UpgradedWebSocketResponseInputJSONType;
//     };
// }>;

export type ServerObject = {
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
};
