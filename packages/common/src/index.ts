// missiv's protocol: every request and response of the HTTP API as a zod schema,
// with its TypeScript type inferred from it, so the server validates exactly what
// the client is typed against. One source; nothing here is declared twice.
import {z} from 'zod';

// ------------------------------------------------------------------------------------------------
// primitives
// ------------------------------------------------------------------------------------------------

export type String0x = `0x${string}`;
export type PublicKey = String0x;
export type Address = String0x;

/** lowercase 0x-prefixed hex */
export const String0xSchema = z.custom<String0x>(
	(v) => typeof v === 'string' && v.length <= 1024 && /^0x[a-f0-9]+$/.test(v),
	{message: 'expected lowercase 0x-prefixed hex'},
);
export const AddressSchema = String0xSchema;
export const PublicKeySchema = String0xSchema;

const DomainSchema = z.string().min(1).max(253);
const NamespaceSchema = z.string().max(64);
const ConversationIDSchema = z.string().min(1).max(256);

// ------------------------------------------------------------------------------------------------
// errors
// ------------------------------------------------------------------------------------------------

/** The error codes the API answers with, each with its HTTP status. */
export const ERROR_STATUS = {
	invalid_request: 400,
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	rate_limited: 429,
	internal: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

/** The body of every error response: `{error: {code, message}}`, under the code's status. */
export type ErrorResponse = {error: {code: ErrorCode; message: string; details?: unknown}};

// ------------------------------------------------------------------------------------------------
// users
// ------------------------------------------------------------------------------------------------

export const ActionRegisterDomainUserSchema = z.object({
	type: z.literal('register'),
	domain: DomainSchema,
	signature: String0xSchema,
	address: AddressSchema,
	name: z.string().max(64).optional(),
	domainUsername: z.string().max(64).optional(),
	description: z.string().max(512).optional(),
	domainDescription: z.string().max(512).optional(),
});
export type ActionRegisterDomainUser = z.infer<typeof ActionRegisterDomainUserSchema>;
export type ResponseRegisterDomainUser = {ok: true; message: string};

export const ActionEditDomainUserSchema = z.object({
	type: z.literal('editUser'),
	domain: DomainSchema,
	name: z.string().max(64).optional(),
	domainUsername: z.string().max(64).optional(),
	description: z.string().max(512).optional(),
	domainDescription: z.string().max(512).optional(),
});
export type ActionEditDomainUser = z.infer<typeof ActionEditDomainUserSchema>;
export type ResponseEditDomainUser = {ok: true; message: string};

export type MissivUser = {
	address: Address;
	name: string;
	created: number;
};
export const ActionGetMissivUserSchema = z.object({
	type: z.literal('getUser'),
	address: AddressSchema,
});
export type ActionGetMissivUser = z.infer<typeof ActionGetMissivUserSchema>;
export type ResponseGetMissivUser = {user: MissivUser | undefined};

export type DomainUser = {
	user: Address;
	domain: string;
	domainUsername: string;
	publicKey: PublicKey;
	signature: String0x;
	lastPresence: number;
	added: number;
};
export type ResponseGetDomainUser = {domainUser: DomainUser | undefined};

export const ActionGetCompleteUserSchema = z.object({
	type: z.literal('getCompleteUser').optional(),
	domain: DomainSchema,
	address: AddressSchema,
});
export type ActionGetCompleteUser = z.infer<typeof ActionGetCompleteUserSchema>;
export type ResponseGetCompleteUser = {completeUser: (DomainUser & MissivUser) | undefined};

// ------------------------------------------------------------------------------------------------
// conversations
// ------------------------------------------------------------------------------------------------

export type Conversation = {
	domain: string;
	namespace: string;
	user: Address;
	conversationID: string;
	members: Address[];
	lastMessage: number;
	lastRead: number;
	accepted: boolean;
};

const conversationScope = {
	domain: DomainSchema,
	namespace: NamespaceSchema,
};

export const ActionGetConversationsSchema = z.object({type: z.literal('getConversations'), ...conversationScope});
export type ActionGetConversations = z.infer<typeof ActionGetConversationsSchema>;
export type ResponseGetConversations = {conversations: Conversation[]};

export const ActionGetUnacceptedConversationsSchema = z.object({
	type: z.literal('getUnacceptedConversations'),
	...conversationScope,
});
export type ActionGetUnacceptedConversations = z.infer<typeof ActionGetUnacceptedConversationsSchema>;
export type ResponseGetUnacceptedConversations = {unacceptedConversations: Conversation[]};

export const ActionGetAcceptedConversationsSchema = z.object({
	type: z.literal('getAcceptedConversations'),
	...conversationScope,
});
export type ActionGetAcceptedConversations = z.infer<typeof ActionGetAcceptedConversationsSchema>;
export type ResponseGetAcceptedConversations = {acceptedConversations: Conversation[]};

export const ActionAcceptConversationSchema = z.object({
	type: z.literal('acceptConversation'),
	...conversationScope,
	conversationID: ConversationIDSchema,
	lastMessageReadTimestampMS: z.number(),
});
export type ActionAcceptConversation = z.infer<typeof ActionAcceptConversationSchema>;
export type ResponseAcceptConversation = {timestampMS: number};

export const ActionMarkAsReadSchema = z.object({
	type: z.literal('markAsRead'),
	...conversationScope,
	conversationID: ConversationIDSchema,
	lastMessageReadTimestampMS: z.number(),
});
export type ActionMarkAsRead = z.infer<typeof ActionMarkAsReadSchema>;
export type ResponseMarkAsRead = {success: true};

export const ActionRejectConversationSchema = z.object({
	type: z.literal('rejectConversation'),
	...conversationScope,
	conversationID: ConversationIDSchema,
});
export type ActionRejectConversation = z.infer<typeof ActionRejectConversationSchema>;
export type ResponseRejectConversation = {success: true};

// ------------------------------------------------------------------------------------------------
// messages
// ------------------------------------------------------------------------------------------------

const sendMessageFields = {
	type: z.literal('sendMessage'),
	...conversationScope,
	conversationID: ConversationIDSchema,
	lastMessageReadTimestampMS: z.number(),
	messages: z
		.array(
			z.object({
				to: AddressSchema,
				toPublicKey: PublicKeySchema,
				content: z.string().max(16384),
			}),
		)
		.min(1)
		.max(32),
	signature: String0xSchema,
};

export const ActionSendMessageSchema = z.discriminatedUnion('messageType', [
	z.object({...sendMessageFields, messageType: z.literal('encrypted')}),
	z.object({...sendMessageFields, messageType: z.literal('clear')}),
]);
export type ActionSendMessage = z.infer<typeof ActionSendMessageSchema>;
export type ActionSendEncryptedMessage = Extract<ActionSendMessage, {messageType: 'encrypted'}>;
export type ActionSendInClearMessage = Extract<ActionSendMessage, {messageType: 'clear'}>;
export type ResponseSendMessage = {timestampMS: number};

export type ConversationMessage = {
	domain: string;
	namespace: string;
	conversationID: string;
	id: number;
	recipient: Address;
	sender: Address;
	senderPublicKey: PublicKey;
	recipientPublicKey: PublicKey;
	content: string;
	timestamp: number;
	messageType: 'encrypted' | 'clear';
	signature: String0x;
};

export const ActionGetMessagesSchema = z.object({
	type: z.literal('getMessages'),
	...conversationScope,
	conversationID: ConversationIDSchema,
});
export type ActionGetMessages = z.infer<typeof ActionGetMessagesSchema>;
export type ResponseGetMessages = {messages: ConversationMessage[]};

// ------------------------------------------------------------------------------------------------
// admin
// ------------------------------------------------------------------------------------------------

export const ActionResetSchema = z.object({reset: z.boolean()});
export type ActionReset = z.infer<typeof ActionResetSchema>;

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

export function getConversationID(accountA: Address, accountB: Address) {
	accountA = accountA.toLowerCase() as PublicKey;
	accountB = accountB.toLowerCase() as PublicKey;
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

// ------------------------------------------------------------------------------------------------
// rooms (WebSocket messages)
// ------------------------------------------------------------------------------------------------

export type ClientMessageType =
	| {address: `0x${string}`; signature: `0x${string}`}
	| {message: string; signature: `0x${string}`}
	| {logout: true};

export type ServerMessageType =
	| {challenge: string; id: string}
	| {joined: `0x${string}`; id: string; publicKey: `0x${string}`}
	| {message: string; from: string; timestamp: number; signature: `0x${string}`}
	| {quit: string; id: string}
	| {error: string; code?: ErrorCode};

// The ownership proof's message and origin live in delegated-identity, shared with
// the services that check the same proof; re-exported here for missiv's callers.
export {fromDomainToOrigin, originPublicKeyPublicationMessage} from 'delegated-identity';
