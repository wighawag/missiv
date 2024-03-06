import type { ActionGetMessages, Conversation, ConversationMessage, PublicKey } from 'missiv';
import { writable, type Readable } from 'svelte/store';
import { API } from '$lib/API.js';
import type { User, APIConfig } from '$lib/types.js';

export type ConversationState = {
	invalidUser: boolean;
	user: User;
	otherUser: OtherUser;
	conversationID: string;
	// unread: boolean;
	// unaccepted: boolean;
	messages: ConversationMessage[];
	loading: boolean;
};

export type OtherUser = {
	publicKey?: PublicKey;
	address: `0x${string}`;
};

export type CurrentConversation = Readable<ConversationState> & {
	setCurrentUser(user: User | undefined): void;
};

export function openOneConversation(
	config: APIConfig,
	conversationID: string,
	user: User,
	otherUser: OtherUser
): CurrentConversation {
	function defaultState(): ConversationState {
		return {
			invalidUser: false,
			conversationID,
			user,
			otherUser,
			messages: [],
			loading: false
		};
	}
	function reset(fields?: { loading?: boolean }) {
		$store = defaultState();
		$store.loading = fields?.loading || false;
		store.set($store);
	}

	const pollingInterval = config.pollingInterval || 20000;
	const api = new API(config.endpoint);
	let $store: ConversationState = defaultState();

	let timeout: 'first' | NodeJS.Timeout | undefined;
	async function fetchMessages() {
		if (user) {
			const { messages } = await api.getMessages(
				{
					namespace: config.namespace,
					conversationID
				},
				{
					privateKey: user.delegatePrivateKey
				}
			);

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
		fetchMessagesgainAndAgain();
		return () => timeout && timeout != 'first' && clearTimeout(timeout);
	});

	function setCurrentUser(newuser: User | undefined) {
		if (newuser) {
			if (newuser.address == user.address) {
				$store.invalidUser = false;
				store.set($store);
				fetchMessages();
			} else {
				$store.invalidUser = true;
				store.set($store);
			}
		}
	}

	return {
		subscribe: store.subscribe,
		setCurrentUser
	};
}
