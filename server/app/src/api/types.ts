import {z} from 'zod';

export const string0x = () =>
	z
		.custom<`0x${string}`>((val) => {
			return typeof val === 'string' ? val.startsWith('0x') : false;
		}, 'do not start with 0x')
		.transform((v) => v.toLowerCase() as `0x${string}`);

export const SchemaPublicKey = string0x();
export type PublicKey = z.infer<typeof SchemaPublicKey>;

export const SchemaAddress = string0x();
export type Address = z.infer<typeof SchemaAddress>;

export type Conversation = {
	domain: string;
	namespace: string;
	first: Address;
	second: Address;
	conversationID: string;
	lastMessage: number;
	state: 'unaccepted' | 'unread' | 'read';
};

export type MissivUser = {
	address: Address;
	name: string;
	created: number;
};

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

export type DomainUser = {
	user: Address;
	domain: string;
	domainUsername: string;
	publicKey: PublicKey;
	signature: `0x${string}`;
	lastPresence: number;
	added: number;
};
