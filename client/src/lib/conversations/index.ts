import { writable } from 'svelte/store';
import { openOneConversation } from './single/index.js';
import { openConversationsView } from './list/index.js';
import type { APIConfig, User } from '$lib/types.js';
import { type Address } from 'missiv';
import { API } from '$lib/API.js';
import type { ConversationsState, OtherUser } from './types.js';

const $store: ConversationsState = {};

const store = writable<ConversationsState>($store);

function openConversationsList(config: APIConfig) {
	$store.conversations = openConversationsView(config);
	store.set($store);
}

function setCurrentUser(newUser: User | undefined) {
	$store.currentUser = newUser;
	if ($store.conversations) {
		$store.conversations.setCurrentUser(newUser);
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
		openConversation: (other: Address) => {
			if (!config || !api) {
				throw new Error(`no config provided`);
			}
			if (!$store.currentUser) {
				throw new Error(`no current user`);
			}

			const conversationStore = openOneConversation(
				config,
				$store.currentUser,
				{
					address: other
				},
				store
			);
			return conversationStore;
		}
	};
}
