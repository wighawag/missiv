import { writable, type Readable } from 'svelte/store';
import { API } from '$lib/API.js';
import type { User, APIConfig } from '$lib/types.js';
import type {
	ConversationState,
	ConversationsState,
	CurrentConversation,
	OtherUser
} from '../types.js';
import { getConversationID, type Address } from 'missiv';

export function openOneConversation(
	config: APIConfig,
	user: User,
	otherUser: OtherUser,
	conversationsStore: Readable<ConversationsState>
): CurrentConversation {
	const conversationID = getConversationID(user.address, otherUser.address);

	function defaultState(): ConversationState {
		return {
			conversationID,
			loading: 'idle',
			user,
			otherUser,
			invalidUser: false,
			messages: undefined
		};
	}

	const pollingInterval = config.pollingInterval || 2;
	const api = new API(config.endpoint);
	let $store: ConversationState = defaultState();

	let timeout: 'first' | NodeJS.Timeout | undefined;
	async function fetchMessages() {
		if ($store.user) {
			if (!$store.otherUser.publicKey) {
				const { namespacedUser } = await api.getNamespacedUser({
					address: otherUser.address,
					namespace: config.namespace
				});
				if (namespacedUser?.publicKey) {
					$store.otherUser.publicKey = namespacedUser.publicKey;
				}
			}
			const { messages } = await api.getMessages(
				{
					namespace: config.namespace,
					conversationID
				},
				{
					privateKey: user.delegatePrivateKey
				}
			);

			$store.loading = 'done';
			$store.messages = messages;
			store.set($store);
		}
	}

	async function fetchMessagesgainAndAgain() {
		await fetchMessages();
		if (timeout) {
			timeout = setTimeout(fetchMessagesgainAndAgain, pollingInterval * 1000);
		} // else we stop as we cleared the timeout
	}

	const store = writable<ConversationState>($store, () => {
		const unsubscribeFromConversationsState = conversationsStore.subscribe(
			onConversationsStateUpdated
		);
		fetchMessagesgainAndAgain();
		return () => {
			unsubscribeFromConversationsState();
			if (timeout && timeout != 'first') {
				clearTimeout(timeout);
			}
		};
	});

	function onConversationsStateUpdated(newState: ConversationsState) {
		if (newState.currentUser) {
			if (newState.currentUser.address == user.address) {
				$store.invalidUser = false;
				store.set($store);
				fetchMessages();
			} else {
				$store.invalidUser = true;
				store.set($store);
			}
		}
	}

	async function sendMessage(text: string) {
		if (!$store.otherUser.publicKey) {
			throw new Error(`cannot send message to player who did not share its public key`);
		}
		if (!$store.user) {
			throw new Error(`no user setup`);
		}

		if ($store.invalidUser) {
			throw new Error(`invalid user`);
		}
		await api.sendMessage(
			{
				message: text,
				namespace: config.namespace,
				signature: '0x',
				to: $store.otherUser.address,
				toPublicKey: $store.otherUser.publicKey
			},
			{
				privateKey: $store.user.delegatePrivateKey
			}
		);
	}

	return {
		subscribe: store.subscribe,
		sendMessage
	};
}
