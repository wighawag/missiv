import {z} from 'zod';
import {Conversation, ConversationMessage, DomainUser, MissivUser, string0x} from '../types';

export const SchemaActionSendMessageInClear = z.object({
	messageType: z.literal('clear'),
	domain: z.string(),
	namespace: z.string(),
	to: string0x(),
	message: z.string(),
	signature: string0x(),
});
export const SchemaActionSendEncryptedMessage = z.object({
	messageType: z.literal('encrypted'),
	domain: z.string(),
	namespace: z.string(),
	to: string0x(),
	toPublicKey: string0x(),
	message: z.string(),
	signature: string0x(),
});
export const SchemaActionSendMessage = z.discriminatedUnion('messageType', [
	SchemaActionSendEncryptedMessage,
	SchemaActionSendMessageInClear,
]);
export type ActionSendMessage = z.infer<typeof SchemaActionSendMessage>;
export type ActionSendMessageInClear = z.infer<typeof SchemaActionSendMessageInClear>;
export type ActionSendEncryptedMessage = z.infer<typeof SchemaActionSendEncryptedMessage>;
export type ResponseSendMessage = {
	timestampMS: number;
};

export const SchemaActionGetConversations = z.object({
	domain: z.string(),
	namespace: z.string(),
});
export type ActionGetConversations = z.infer<typeof SchemaActionGetConversations>;
export type ResponseGetConversations = {conversations: Conversation[]};

export const SchemaActionAcceptConversation = z.object({
	domain: z.string(),
	namespace: z.string(),
	conversationID: z.string(),
});
export type ActionAcceptConversation = z.infer<typeof SchemaActionAcceptConversation>;
export type ResponseAcceptConversation = {
	timestampMS: number;
};

export const SchemaActionGetUnacceptedConversations = z.object({
	domain: z.string(),
	namespace: z.string(),
});
export type ActionGetUnacceptedConversations = z.infer<typeof SchemaActionGetUnacceptedConversations>;
export type ResponseGetUnacceptedConversations = {unacceptedConversations: Conversation[]};

export const SchemaActionGetAcceptedConversations = z.object({
	domain: z.string(),
	namespace: z.string(),
});
export type ActionGetAcceptedConversations = z.infer<typeof SchemaActionGetAcceptedConversations>;
export type ResponseGetAcceptedConversations = {acceptedConversations: Conversation[]};

export const SchemaActionMarkAsRead = z.object({
	domain: z.string(),
	namespace: z.string(),
	conversationID: z.string(),
	lastMessageTimestampMS: z.number(),
});
export type ActionMarkAsRead = z.infer<typeof SchemaActionMarkAsRead>;
export type ResponseMarkAsRead = {timestampMS: number};

export const SchemaActionGetMessages = z.object({
	domain: z.string(),
	namespace: z.string(),
	conversationID: z.string(),
});
export type ActionGetMessages = z.infer<typeof SchemaActionGetMessages>;
export type ResponseGetMessages = {messages: ConversationMessage[]};
