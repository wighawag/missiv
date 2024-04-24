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
	union,
	optional,
	forward,
	custom,
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

export const SchemaActionSendMessage = object(
	{
		type: literal('sendMessage'),
		domain: string(),
		namespace: string(),
		to: string0x(),
		toPublicKey: optional(string0x()),
		message: string(),
		messageType: union([literal('clear'), literal('encrypted')]),
		signature: string0x(),
	},
	[
		forward(
			custom(({toPublicKey, messageType}) => {
				if (messageType === 'clear') {
					return toPublicKey ? false : true;
				} else {
					return toPublicKey ? true : false;
				}
			}, 'toPublicKey is required when message is encrypted and forbidden when message is clear'),
			['toPublicKey'],
		),
	],
);

export type ActionSendMessage = Output<typeof SchemaActionSendMessage>;

export type ActionSendMessageInClear = {
	type: 'sendMessage';
	domain: string;
	namespace: string;
	to: `0x${string}`;
	message: string;
	messageType: 'clear';
	signature: `0x${string}`;
};

export type ActionSendEncryptedMessage = {
	type: 'sendMessage';
	domain: string;
	namespace: string;
	to: `0x${string}`;
	toPublicKey: `0x${string}`;
	message: string;
	messageType: 'encrypted';
	signature: `0x${string}`;
};

export type ResponseSendMessage = {
	timestampMS: number;
};

export const SchemaActionAcceptConversation = object({
	type: literal('acceptConversation'),
	domain: string(),
	namespace: string(),
	conversationID: string(),
});
export type ActionAcceptConversation = Output<typeof SchemaActionAcceptConversation>;
export type ResponseAcceptConversation = {
	timestampMS: number;
};

export type Conversation = {
	domain: string;
	namespace: string;
	first: Address;
	second: Address;
	conversationID: string;
	lastMessage: number;
	state: 'unaccepted' | 'unread' | 'read';
};
export const SchemaActionGetConversations = object({
	type: literal('getConversations'),
	domain: string(),
	namespace: string(),
});
export type ActionGetConversations = Output<typeof SchemaActionGetConversations>;
export type ResponseGetConversations = {conversations: Conversation[]};

export const SchemaActionGetUnacceptedConversations = object({
	type: literal('getUnacceptedConversations'),
	domain: string(),
	namespace: string(),
});
export type ActionGetUnacceptedConversations = Output<typeof SchemaActionGetUnacceptedConversations>;
export type ResponseGetUnacceptedConversations = {unacceptedConversations: Conversation[]};

export const SchemaActionGetAcceptedConversations = object({
	type: literal('getAcceptedConversations'),
	domain: string(),
	namespace: string(),
});
export type ActionGetAcceptedConversations = Output<typeof SchemaActionGetAcceptedConversations>;
export type ResponseGetAcceptedConversations = {acceptedConversations: Conversation[]};

export const SchemaActionMarkAsRead = object({
	type: literal('markAsRead'),
	domain: string(),
	namespace: string(),
	conversationID: string(),
	lastMessageTimestampMS: number(),
});
export type ActionMarkAsRead = Output<typeof SchemaActionMarkAsRead>;
export type ResponseMarkAsRead = {timestampMS: number};

export type ConversationMessage = {
	id: number;
	donmain: string;
	namespace: string;
	conversationID: string;
	sender: Address;
	senderPublicKey: PublicKey;
	recipient: Address;
	recipientPublicKey: PublicKey;
	timestamp: number;
	message: string;
	type: 'encrypted' | 'clear';
	signature: string;
};
export const SchemaActionGetMessages = object({
	domain: string(),
	namespace: string(),
	type: literal('getMessages'),
	conversationID: string(),
});
export type ActionGetMessages = Output<typeof SchemaActionGetMessages>;
export type ResponseGetMessages = {messages: ConversationMessage[]};

export type MissivUser = {
	address: Address;
	name: string;
	created: number;
};
export const SchemaActionGetMissivUser = object({
	type: literal('getUser'),
	address: string0x(),
});
export type ActionGetMissivUser = Output<typeof SchemaActionGetMissivUser>;
export type ResponseGetMissivUser = {user: MissivUser | undefined};

export type DomainUser = {
	user: Address;
	domain: string;
	domainUsername: string;
	publicKey: PublicKey;
	signature: `0x${string}`;
	lastPresence: number;
	added: number;
};
// export const SchemaActionGetDomainUser = object({
// 	type: literal('getDomainUser'),
// 	domain: string(),
// 	address: string0x(),
// });
// export type ActionGetDomainUser = Output<typeof SchemaActionGetDomainUser>;
export type ResponseGetDomainUser = {domainUser: DomainUser | undefined};

export const SchemaActionGetCompleteUser = object({
	type: literal('getCompleteUser'),
	domain: string(),
	address: string0x(),
});
export type ActionGetCompleteUser = Output<typeof SchemaActionGetCompleteUser>;
export type ResponseGetCompleteUser = {completeUser: (DomainUser & MissivUser) | undefined};

export const SchemaActionRegisterDomainUser = object({
	type: literal('register'),
	domain: string(),
	signature: string0x(),
	address: string0x(),
	name: optional(string()),
	domainUsername: optional(string()),
});
export type ActionRegisterDomainUser = Output<typeof SchemaActionRegisterDomainUser>;
export type ResponseRegisterDomainUser = {timestampMS: number};

export const SchemaAction = variant('type', [
	SchemaActionRegisterDomainUser,
	SchemaActionSendMessage,
	SchemaActionGetConversations,
	SchemaActionGetUnacceptedConversations,
	SchemaActionGetAcceptedConversations,
	SchemaActionMarkAsRead,
	SchemaActionGetMessages,
	SchemaActionAcceptConversation,
	SchemaActionGetMissivUser,
	SchemaActionGetCompleteUser,

	object({
		type: literal('db:select'),
		table: string(),
	}),
	object({
		type: literal('db:reset'),
	}),
]);

export type Action = Output<typeof SchemaAction>;

export function getConversationID(accountA: Address, accountB: Address) {
	accountA = accountA.toLowerCase() as PublicKey;
	accountB = accountB.toLowerCase() as PublicKey;
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export function publicKeyAuthorizationMessage({
	address,
	publicKey,
}: {
	address: `0x${string}`;
	publicKey: `0x${string}`;
}): string {
	return `I authorize the following Public Key to represent me:\n ${publicKey}\n\n  Others can use this key to write me messages`;
}
