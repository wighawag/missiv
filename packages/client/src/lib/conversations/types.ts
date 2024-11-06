import type { User } from '$lib/types.js';
import type { Conversation, ConversationMessage, PublicKey } from 'missiv-server-app';
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
	address: `0x${string}`;
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
		| { state: 'ready'; confirmed: boolean }
		| { state: 'registering' };
};
