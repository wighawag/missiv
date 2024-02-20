import { object, string, literal, Output, special, variant, number, toLowerCase, BaseTransformation, BaseValidation, Pipe } from 'valibot';
export { parse } from 'valibot';

const string0x = (...args: (BaseValidation<`0x${string}`> | BaseTransformation<`0x${string}`>)[]) =>
	special<`0x${string}`>((val) => (typeof val === 'string' ? val.startsWith('0x') : false), 'do not start with 0x', [
		toLowerCase() as BaseTransformation<`0x${string}`>,
		...args,
	]);

export const SchemaAddress = string0x();
export type Address = Output<typeof SchemaAddress>;

export const SchemaActionSendMessage = object({
	type: literal('sendMessage'),
	to: string0x(),
	message: string(),
});
export type ActionSendMessage = Output<typeof SchemaActionSendMessage>;
export type ResponseSendMessage = {
	timestampMS: number;
};

export const SchemaActionAcceptConversation = object({
	type: literal('acceptConversation'),
	with: string0x(),
	unacceptedTimestampMS: number(),
});
export type ActionAcceptConversation = Output<typeof SchemaActionAcceptConversation>;
export type ResponseAcceptConversation = {
	deleted: number;
};

export type Conversation = { account: Address; last: number; unread: boolean };
export const SchemaActionGetConversations = object({
	type: literal('getConversations'),
});
export type ActionGetConversations = Output<typeof SchemaActionGetConversations>;
export type ResponseGetConversations = Conversation[];

export type ConversationRequest = { account: Address; timestampMS: number };
export const SchemaActionGetConversationRequests = object({
	type: literal('getConversationRequests'),
});
export type ActionGetConversationRequests = Output<typeof SchemaActionGetConversationRequests>;
export type ResponseGetConversationRequests = ConversationRequest[];

export const SchemaActionMarkAsRead = object({
	type: literal('markAsRead'),
	lastMessageTimestampMS: number(),
});
export type ActionMarkAsRead = Output<typeof SchemaActionMarkAsRead>;
export type ResponseMarkAsRead = { read: number };

export type ComversationMessage = { message: string; from: `0x${string}` };
export const SchemaActionGetMessages = object({
	type: literal('getMessages'),
	with: string0x(),
});
export type ActionGetMessages = Output<typeof SchemaActionGetMessages>;
export type ResponseGetMessages = ComversationMessage[];

export const SchemaAction = variant('type', [
	SchemaActionSendMessage,
	SchemaActionGetConversations,
	SchemaActionGetConversationRequests,
	SchemaActionMarkAsRead,
	SchemaActionGetMessages,
	SchemaActionAcceptConversation,
	object({
		type: literal('kv:list'),
	}),
	object({
		type: literal('kv:delete'),
	}),
]);

export type Action = Output<typeof SchemaAction>;
