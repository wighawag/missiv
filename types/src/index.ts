import {
	object,
	string,
	literal,
	Output,
	special,
	variant,
	number,
	toLowerCase,
	BaseTransformation,
	BaseValidation,
	Pipe,
} from 'valibot';
export {parse} from 'valibot';

const string0x = (...args: (BaseValidation<`0x${string}`> | BaseTransformation<`0x${string}`>)[]) =>
	special<`0x${string}`>((val) => (typeof val === 'string' ? val.startsWith('0x') : false), 'do not start with 0x', [
		toLowerCase() as BaseTransformation<`0x${string}`>,
		...args,
	]);

export const SchemaPublicKey = string0x();
export type PublicKey = Output<typeof SchemaPublicKey>;

export const SchemaAddress = string0x();
export type Address = Output<typeof SchemaAddress>;

export const SchemaActionSendMessage = object({
	type: literal('sendMessage'),
	namespace: string(),
	to: string0x(),
	toPublicKey: string0x(),
	message: string(),
	signature: string0x(),
});
export type ActionSendMessage = Output<typeof SchemaActionSendMessage>;
export type ResponseSendMessage = {
	timestampMS: number;
};

export const SchemaActionAcceptConversation = object({
	type: literal('acceptConversation'),
	namespace: string(),
	conversationID: string(),
});
export type ActionAcceptConversation = Output<typeof SchemaActionAcceptConversation>;
export type ResponseAcceptConversation = {
	timestampMS: number;
};

export type Conversation = {
	namespace: string;
	first: Address;
	second: Address;
	conversationID: string;
	lastMessage: number;
	state: 'unaccepted' | 'unread' | 'read';
};
export const SchemaActionGetConversations = object({
	type: literal('getConversations'),
	namespace: string(),
});
export type ActionGetConversations = Output<typeof SchemaActionGetConversations>;
export type ResponseGetConversations = Conversation[];

export const SchemaActionGetUnacceptedConversations = object({
	type: literal('getUnacceptedConversations'),
	namespace: string(),
});
export type ActionGetUnacceptedConversations = Output<typeof SchemaActionGetUnacceptedConversations>;
export type ResponseGetUnacceptedConversations = Conversation[];

export const SchemaActionGetAcceptedConversations = object({
	type: literal('getAcceptedConversations'),
	namespace: string(),
});
export type ActionGetAcceptedConversations = Output<typeof SchemaActionGetAcceptedConversations>;
export type ResponseGetAcceptedConversations = Conversation[];

export const SchemaActionMarkAsRead = object({
	type: literal('markAsRead'),
	namespace: string(),
	conversationID: string(),
	lastMessageTimestampMS: number(),
});
export type ActionMarkAsRead = Output<typeof SchemaActionMarkAsRead>;
export type ResponseMarkAsRead = {timestampMS: number};

export type ConversationMessage = {
	namespace: string;
	conversationID: string;
	sender: Address;
	senderPublicKey: PublicKey;
	recipient: Address;
	recipientPublicKey: PublicKey;
	timestamp: number;
	message: string;
	signature: string;
};
export const SchemaActionGetMessages = object({
	namespace: string(),
	type: literal('getMessages'),
	conversationID: string(),
});
export type ActionGetMessages = Output<typeof SchemaActionGetMessages>;
export type ResponseGetMessages = ConversationMessage[];

export type User = {
	address: Address;
	publicKey: PublicKey;
	signature: `0x${string}`;
	lastPresence: number;
	created: number;
};
export const SchemaActionGetUser = object({
	type: literal('getUser'),
	address: string0x(),
});
export type ActionGetUser = Output<typeof SchemaActionGetUser>;
export type ResponseGetUser = User | undefined;

export const SchemaActionRegisterPublicKeys = object({
	type: literal('register'),
	signature: string0x(),
	address: string0x(),
});
export type ActionRegisterPublicKeys = Output<typeof SchemaActionRegisterPublicKeys>;
export type ResponseRegisterPublicKeys = {timestampMS: number};

export const SchemaAction = variant('type', [
	SchemaActionRegisterPublicKeys,
	SchemaActionSendMessage,
	SchemaActionGetConversations,
	SchemaActionGetUnacceptedConversations,
	SchemaActionGetAcceptedConversations,
	SchemaActionMarkAsRead,
	SchemaActionGetMessages,
	SchemaActionAcceptConversation,
	SchemaActionGetUser,

	object({
		type: literal('db:select'),
		table: string(),
	}),
	object({
		type: literal('db:reset'),
	}),
]);

export type Action = Output<typeof SchemaAction>;
