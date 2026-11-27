import {Context} from 'hono';
import {Bindings, MiddlewareHandler} from 'hono/types';
import {WSEvents} from 'hono/ws';
import {RemoteSQL} from 'remote-sql';
import type {PushNotifier} from './push.js';

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
	abstract handleErrors(request: Request, func: () => Promise<Response>): Promise<Response>;
	abstract fetch(request: Request): Promise<Response>;
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

export type Services<Env extends Bindings = Bindings> = {
	getDB: (env: Env) => RemoteSQL;
	getRoom: (env: Env, idOrName: ServerObjectId | string) => ServerObject;
	getRateLimiter: (env: Env, idOrName: ServerObjectId | string) => ServerObject;
};

export type ServerOptions<Env extends Bindings = Bindings> = {
	services: Services<Env>;
	/**
	 * Rooms held in this process (nodejs, bun), upgraded through `upgradeWebSocket`
	 * rather than a Durable Object's fetch: see `createInProcessRooms`.
	 */
	inProcessRooms?: {
		getRoom(env: Env, name: string): InProcessRoom;
		/** the client's IP, for the rate limiter */
		getIP?(c: Context): string | undefined;
	};
	getEnv: (c: Context<{Bindings: Env}>) => Env;
	/**
	 * The notifier of new direct messages; by default the one PUSH_SERVER_URL and
	 * PUSH_TOKENS configure, none when they are unset.
	 */
	getPushNotifier?: (env: Env) => PushNotifier | undefined;
	/** keep the request's runtime alive for work after the response (cf-worker: `executionCtx.waitUntil`) */
	waitUntil?: (c: Context, promise: Promise<unknown>) => void;
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

/** What the public API needs of a room held in process. */
export type InProcessRoom = {
	prepareConnection(request: Request): Response | undefined;
	addWebSocket(ws: WebSocket): void;
	webSocketOpen(ws: WebSocket, metadata: {ip?: string}): Promise<void>;
	webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void>;
	webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
	webSocketError(ws: WebSocket, error: unknown): Promise<void>;
};

export type ServerObject = {
	fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
};

// The request schemas are @missiv/common's (one source for the server and the client).
export {
	ActionAcceptConversationSchema,
	ActionEditDomainUserSchema,
	ActionGetAcceptedConversationsSchema,
	ActionGetDomainUserSchema,
	ActionGetKeySetSchema,
	ActionGetConversationsSchema,
	ActionGetMessagesSchema,
	ActionGetUnacceptedConversationsSchema,
	ActionMarkAsReadSchema,
	ActionOpenSessionSchema,
	ActionRegisterDomainUserSchema,
	ActionRejectConversationSchema,
	ActionResetSchema,
	ActionSendMessageSchema,
	ActionUnblockSchema,
	AddressSchema,
	KeySchema,
	PublicKeySchema,
	PublicKeySetSchema,
} from '@missiv/common';
