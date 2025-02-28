import { writable } from 'svelte/store';
import { openOneConversation } from './single/index.js';
import { openConversationsView } from './list/index.js';
import type { APIConfig, User } from '$lib/types.js';
import { API } from '$lib/API.js';
import type { ConversationsState } from './types.js';
import type { ActionGetCompleteUser, Address } from 'missiv-common';

const $store: ConversationsState = { registered: { state: 'idle' } };

const store = writable<ConversationsState>($store);

function openConversationsList(config: APIConfig) {
	$store.conversations = openConversationsView(config, $store.currentUser);
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

		if (isNewUser && newUser) {
			if (api && config) {
				console.log(`new: api.getCompleteUser...`);
				api
					.getCompleteUser({
						address: newUser.address,
						domain: config.domain
					})
					.then(({ completeUser }) => {
						console.log(`api.getCompleteUser`);
						$store.registered = {
							state: 'ready',
							user: completeUser
						};
						store.set($store);
					});
			}
		}
	}

	async function register(
		signature: Address,
		options?: {
			name?: string;
			domainUsername?: string;
			domainDescription?: string;
			description?: string;
		}
	) {
		if (api && config && $store.currentUser) {
			const user = $store.currentUser;
			$store.registered = { state: 'registering' };
			store.set($store);

			await api.register(
				{
					type: 'register',
					address: user.address,
					domain: config.domain,
					signature,
					domainUsername: options?.domainUsername,
					name: options?.name,
					domainDescription: options?.domainDescription,
					description: options?.description
				},
				{
					privateKey: user.delegatePrivateKey
				}
			);

			$store.registered = { state: 'loading' };
			store.set($store);

			console.log(`api.getCompleteUser...`);
			const { completeUser } = await api.getCompleteUser({
				address: user.address,
				domain: config.domain
			});

			$store.registered = {
				state: 'ready',
				user: completeUser
			};
			store.set($store);
		}
	}

	async function editUser(options?: {
		name?: string;
		domainUsername?: string;
		domainDescription?: string;
		description?: string;
	}) {
		if (api && config && $store.currentUser) {
			const user = $store.currentUser;

			await api.editUser(
				{
					type: 'editUser',
					domain: config.domain,
					domainUsername: options?.domainUsername,
					name: options?.name,
					domainDescription: options?.domainDescription,
					description: options?.description
				},
				{
					privateKey: user.delegatePrivateKey
				}
			);

			console.log(`api.getCompleteUser...`);
			const { completeUser } = await api.getCompleteUser({
				address: user.address,
				domain: config.domain
			});

			$store.registered = {
				state: 'ready',
				user: completeUser
			};
			store.set($store);
		}
	}

	function getUser(action: ActionGetCompleteUser) {
		return api?.getCompleteUser(action);
	}

	return {
		subscribe: store.subscribe,
		register,
		editUser,
		setCurrentUser,
		getUser,
		// TODO remove: markAsAcceptedAndRead
		//   once we handle accepted/naccepted conversation in the UI we do it automatically here
		openConversation: (other: Address, markAsAcceptedAndRead?: boolean) => {
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
				store,
				markAsAcceptedAndRead
			);
			return conversationStore;
		}
	};
}
