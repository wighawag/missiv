import { writable } from 'svelte/store';
import { openOneConversation, type CurrentConversation, type OtherUser } from './single/index.js';
import { openConversationsView, type ConversationViews } from './list/index.js';
import type { APIConfig, User } from '$lib/types.js';

const $store: ConversationsState = {};

export type ConversationsState = {
	currentConversation?: CurrentConversation;
	conversations?: ConversationViews;
};

const store = writable<ConversationsState>($store);

function openConversationsList(config: APIConfig) {
	$store.conversations = openConversationsView(config);
	store.set($store);
}

function openConversation(
	config: APIConfig,
	conversationID: string,
	user: User,
	otherUser: OtherUser
) {
	$store.currentConversation = openOneConversation(config, conversationID, user, otherUser);
	store.set($store);
}

function setCurrentUser(newUser: User | undefined) {
	if ($store.conversations) {
		$store.conversations.setCurrentUser(newUser);
	}
	if ($store.currentConversation) {
		$store.currentConversation.setCurrentUser(newUser);
	}
}

export function setup(config: APIConfig) {
	openConversationsList(config);
	return {
		subscribe: store.subscribe,
		setCurrentUser,
		openConversation: (conversationID: string, user: User, otherUser: OtherUser) =>
			openConversation(config, conversationID, user, otherUser)
	};
}
