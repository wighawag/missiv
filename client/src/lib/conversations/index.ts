import { writable } from 'svelte/store';
import { openOneConversation } from './single/index.js';
import { openConversationsView } from './list/index.js';
import type { APIConfig, User } from '$lib/types.js';
import { type Address } from 'missiv';
import { API } from '$lib/API.js';
import type { ConversationsState, OtherUser } from './types.js';

const $store: ConversationsState = { registered: { state: 'idle' } };

const store = writable<ConversationsState>($store);

function openConversationsList(config: APIConfig) {
	$store.conversations = openConversationsView(config);
	store.set($store);
}

export function setup(config?: APIConfig) {
	let api: API | undefined;
	if (config) {
		openConversationsList(config);
		api = new API(config.endpoint);
	}

	function setCurrentUser(newUser: User | undefined) {
		const isNewUser = newUser?.address.toLowerCase() != $store.currentUser?.address.toLowerCase();
		if (isNewUser) {
			if (newUser?.address) {
				$store.registered = { state: 'loading' };
			} else {
				$store.registered = { state: 'idle' };
			}
		}
		$store.currentUser = newUser;
		if ($store.conversations) {
			$store.conversations.setCurrentUser(newUser);
		}
		store.set($store);

		if (isNewUser && newUser?.address) {
			if (api && config) {
				api
					.getNamespacedUser({
						address: newUser?.address,
						namespace: config?.namespace
					})
					.then(({ namespacedUser }) => {
						$store.registered = {
							state: 'ready',
							confirmed: namespacedUser ? true : false
						};
						store.set($store);
					});
			}
		}
	}

	async function register(signature: `0x${string}`) {
		if (api && config && $store.currentUser) {
			const user = $store.currentUser;
			$store.registered = { state: 'registering' };
			store.set($store);

			await api.register(
				{
					address: user.address,
					namespace: config.namespace,
					signature
				},
				{
					privateKey: user.delegatePrivateKey
				}
			);

			$store.registered = { state: 'loading' };
			store.set($store);

			const { namespacedUser } = await api.getNamespacedUser({
				address: user.address,
				namespace: config?.namespace
			});

			$store.registered = {
				state: 'ready',
				confirmed: namespacedUser ? true : false
			};
			store.set($store);
		}
	}

	return {
		subscribe: store.subscribe,
		register,
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
