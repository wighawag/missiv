import { writable, type Readable } from 'svelte/store';
import type { Conversation } from 'missiv';
import { API } from '../../API.js';
import type { User, APIConfig } from '../../types.js';

export type ConversationsViewState = {
	conversations: Conversation[];
	numUnread: number;
	numUnaccepted: number;
	loading: boolean;
};

export type ConversationViews = Readable<ConversationsViewState> & {
	setCurrentUser(user: User | undefined): void;
};

export function openConversationsView(config: APIConfig): ConversationViews {
	function defaultState(): ConversationsViewState {
		return {
			conversations: [],
			numUnread: 0,
			numUnaccepted: 0,
			loading: false
		};
	}
	function reset(fields?: { loading?: boolean }) {
		$store = defaultState();
		$store.loading = fields?.loading || false;
		store.set($store);
	}

	let user: User | undefined;
	const pollingInterval = config.pollingInterval || 20000;
	const api = new API(config.endpoint);
	let $store: ConversationsViewState = defaultState();

	let timeout: 'first' | NodeJS.Timeout | undefined;
	async function fetchConversations() {
		if (user) {
			const conversations = await api.getConversations(
				{
					namespace: config.namespace
				},
				{
					privateKey: user.delegatePrivateKey
				}
			);
			let numUnread = 0;
			let numUnaccepted = 0;
			for (const conversation of conversations) {
				if (conversation.state === 'unaccepted') {
					numUnaccepted++;
				} else if (conversation.state === 'unread') {
					numUnread++;
					// we do not count unaccepted as unread here
				}
			}
			$store.conversations = conversations;
			store.set($store);
		}
	}

	async function fetchConversationsAgainAndAgain() {
		await fetchConversations();
		if (timeout) {
			timeout = setTimeout(fetchConversationsAgainAndAgain, pollingInterval * 1000);
		} // else we stop as we cleared the timeout
	}

	const store = writable<ConversationsViewState>($store, () => {
		fetchConversationsAgainAndAgain();
		return () => timeout && timeout != 'first' && clearTimeout(timeout);
	});

	function setCurrentUser(newUser: User | undefined) {
		if (newUser) {
			user = { ...newUser };

			store.set($store);
			if (newUser.address !== user?.address) {
				reset({ loading: true });
				fetchConversations();
			}
		} else {
			reset();
			user = undefined;
		}
	}

	return {
		subscribe: store.subscribe,
		setCurrentUser
	};
}
