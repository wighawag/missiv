import {Context} from 'hono';
import {Bindings, MiddlewareHandler} from 'hono/types';
import {WSEvents} from 'hono/ws';
import {
	ActionAcceptConversation,
	ActionEditDomainUser,
	ActionGetAcceptedConversations,
	ActionGetCompleteUser,
	ActionGetConversations,
	ActionGetMessages,
	ActionGetMissivUser,
	ActionGetUnacceptedConversations,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionRejectConversation,
	ActionSendMessage,
} from 'missiv-common';
import {RemoteSQL} from 'remote-sql';
import {z, ZodType} from 'zod';

export type Assert<T extends true> = T;
export type IsExactly<T, U> = (<G>() => G extends T ? 1 : 2) extends <G>() => G extends U ? 1 : 2 ? true : false;
export type IsZodExactly<Z extends ZodType, U> =
	(<G>() => G extends z.infer<Z> ? 1 : 2) extends <G>() => G extends U ? 1 : 2 ? true : false;

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
	getEnv: (c: Context<{Bindings: Env}>) => Env;
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

// Define String0x schema - must match the String0x type in missiv-common
const String0xSchema = z
	.string()
	.regex(/^0x[a-f0-9]+$/)
	.and(z.custom<`0x${string}`>());

// Define PublicKey and Address schemas
export const PublicKeySchema = String0xSchema;
export const AddressSchema = String0xSchema;

// Action Accept Conversation
export const ActionAcceptConversationSchema = z.object({
	type: z.literal('acceptConversation'),
	domain: z.string(),
	namespace: z.string(),
	conversationID: z.string(),
	lastMessageReadTimestampMS: z.number(),
});

// Action Get Accepted Conversations
export const ActionGetAcceptedConversationsSchema = z.object({
	type: z.literal('getAcceptedConversations'),
	domain: z.string(),
	namespace: z.string(),
});

// Action Get Conversations
export const ActionGetConversationsSchema = z.object({
	type: z.literal('getConversations'),
	domain: z.string(),
	namespace: z.string(),
});

// Action Get Messages
export const ActionGetMessagesSchema = z.object({
	type: z.literal('getMessages'),
	domain: z.string(),
	namespace: z.string(),
	conversationID: z.string(),
});

// Action Get Unaccepted Conversations
export const ActionGetUnacceptedConversationsSchema = z.object({
	type: z.literal('getUnacceptedConversations'),
	domain: z.string(),
	namespace: z.string(),
});

// Action Mark As Read
export const ActionMarkAsReadSchema = z.object({
	type: z.literal('markAsRead'),
	domain: z.string(),
	namespace: z.string(),
	conversationID: z.string(),
	lastMessageReadTimestampMS: z.number(),
});

// Action Send Message Schema
export const ActionSendMessageSchema = z.discriminatedUnion('messageType', [
	z.object({
		type: z.literal('sendMessage'),
		domain: z.string(),
		namespace: z.string(),
		conversationID: z.string(),
		lastMessageReadTimestampMS: z.number(),
		messages: z.array(
			z.object({
				to: AddressSchema,
				toPublicKey: PublicKeySchema,
				content: z.string(),
			}),
		),
		signature: String0xSchema,
		messageType: z.literal('encrypted'),
	}),
	z.object({
		type: z.literal('sendMessage'),
		domain: z.string(),
		namespace: z.string(),
		conversationID: z.string(),
		lastMessageReadTimestampMS: z.number(),
		messages: z.array(
			z.object({
				to: AddressSchema,
				toPublicKey: PublicKeySchema,
				content: z.string(),
			}),
		),
		signature: String0xSchema,
		messageType: z.literal('clear'),
	}),
]);

// Action Reject Conversation
export const ActionRejectConversationSchema = z.object({
	type: z.literal('rejectConversation'),
	domain: z.string(),
	namespace: z.string(),
	conversationID: z.string(),
});

// Action Get Missiv User
export const ActionGetMissivUserSchema = z.object({
	type: z.literal('getUser'),
	address: AddressSchema,
});

// Action Get Complete User
export const ActionGetCompleteUserSchema = z.object({
	// TODO: add type field when implemented in missiv-common
	domain: z.string(),
	address: AddressSchema,
});

// Action Register Domain User
export const ActionRegisterDomainUserSchema = z.object({
	type: z.literal('register'),
	domain: z.string(),
	signature: String0xSchema,
	address: AddressSchema,
	name: z.string().optional(),
	domainUsername: z.string().optional(),
	description: z.string().optional(),
	domainDescription: z.string().optional(),
});

// Action Edit Domain User
export const ActionEditDomainUserSchema = z.object({
	type: z.literal('editUser'),
	domain: z.string(),
	name: z.string().optional(),
	domainUsername: z.string().optional(),
	description: z.string().optional(),
	domainDescription: z.string().optional(),
});

type ZodMatchActionAcceptConversation = Assert<
	IsZodExactly<typeof ActionAcceptConversationSchema, ActionAcceptConversation>
>;
type ZodMatchActionGetAcceptedConversations = Assert<
	IsZodExactly<typeof ActionGetAcceptedConversationsSchema, ActionGetAcceptedConversations>
>;
type ZodMatchActionGetConversations = Assert<IsZodExactly<typeof ActionGetConversationsSchema, ActionGetConversations>>;
type ZodMatchActionGetMessages = Assert<IsZodExactly<typeof ActionGetMessagesSchema, ActionGetMessages>>;
type ZodMatchActionGetUnacceptedConversations = Assert<
	IsZodExactly<typeof ActionGetUnacceptedConversationsSchema, ActionGetUnacceptedConversations>
>;
type ZodMatchActionMarkAsRead = Assert<IsZodExactly<typeof ActionMarkAsReadSchema, ActionMarkAsRead>>;

// TODO ? type ZodMatchActionSendMessage = Assert<IsZodExactly<typeof ActionSendMessageSchema, ActionSendMessage>>;
type ZodMatchActionRejectConversation = Assert<
	IsZodExactly<typeof ActionRejectConversationSchema, ActionRejectConversation>
>;

type ZodMatchActionEditDomainUser = Assert<IsZodExactly<typeof ActionEditDomainUserSchema, ActionEditDomainUser>>;

type ZodMatchActionGetCompleteUser = Assert<IsZodExactly<typeof ActionGetCompleteUserSchema, ActionGetCompleteUser>>;

type ZodMatchActionGetMissivUser = Assert<IsZodExactly<typeof ActionGetMissivUserSchema, ActionGetMissivUser>>;

type ZodMatchActionRegisterDomainUser = Assert<
	IsZodExactly<typeof ActionRegisterDomainUserSchema, ActionRegisterDomainUser>
>;
