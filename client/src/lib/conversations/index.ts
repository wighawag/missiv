import { writable } from 'svelte/store';
import { openOneConversation, type CurrentConversation, type OtherUser } from './single/index.js';
import { openConversationsView, type ConversationViews } from './list/index.js';
import type { APIConfig, User } from '$lib/types.js';
import { getConversationID, type Address } from 'missiv';
import { API } from '$lib/API.js';

export type ConversationsState = {
	currentConversation?: CurrentConversation;
	conversations?: ConversationViews;
	currentUser?: User;
};

const $store: ConversationsState = {};

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
	$store.currentUser = newUser;
	if ($store.conversations) {
		$store.conversations.setCurrentUser(newUser);
	}
	if ($store.currentConversation) {
		$store.currentConversation.setCurrentUser(newUser);
	}
	store.set($store);
}

export function setup(config?: APIConfig) {
	let api: API | undefined;
	if (config) {
		openConversationsList(config);
		api = new API(config.endpoint);
	}

	return {
		subscribe: store.subscribe,
		setCurrentUser,
		openConversation: async (other: Address) => {
			if (!config || !api) {
				throw new Error(`no config provided`);
			}
			if (!$store.currentUser) {
				throw new Error(`no current user`);
			}
			const conversationID = getConversationID($store.currentUser.address, other);
			const { namespacedUser: otherUser } = await api.getNamespacedUser({
				address: other,
				namespace: config.namespace
			});

			return openConversation(config, conversationID, $store.currentUser, {
				address: other,
				publicKey: otherUser?.publicKey
			});
		}
	};
}
