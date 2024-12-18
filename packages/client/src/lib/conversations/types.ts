import type { User } from '$lib/types.js';
import type {
	Address,
	Conversation,
	ConversationMessage,
	DomainUser,
	MissivUser,
	PublicKey
} from 'missiv-common';
import type { Readable } from 'svelte/store';

export type ConversationState = {
	conversationID: string;
	user?: User;
	otherUser: OtherUser;
} & (
	| {
			loading: 'idle';
			invalidUser: boolean;
			messages: undefined;
	  }
	| {
			conversationID: string;
			loading: 'messages';
			invalidUser: boolean;
			messages: undefined;
	  }
	| {
			conversationID: string;
			loading: 'done';
			invalidUser: boolean;
			messages: ConversationMessage[];
	  }
);

export type OtherUser = {
	publicKey?: PublicKey;
	address: Address;
	name?: string;
};

export type CurrentConversation = Readable<ConversationState> & {
	sendMessage(text: string): Promise<void>;
};

export type ConversationsViewState = {
	currentUser?: User;
	conversations: Conversation[];
	numUnread: number;
	numUnaccepted: number;
	loading: boolean;
};

export type ConversationViews = Readable<ConversationsViewState> & {
	setCurrentUser(user: User | undefined): void;
};

export type ConversationsState = {
	conversations?: ConversationViews;
	currentUser?: User;
	registered:
		| { state: 'idle' }
		| { state: 'loading' }
		| { state: 'ready'; user?: DomainUser & MissivUser }
		| { state: 'registering' };
};
