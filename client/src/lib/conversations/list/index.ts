import { writable } from 'svelte/store';
import { API } from '../../API.js';
import type { User, APIConfig } from '../../types.js';
import type { ConversationViews, ConversationsViewState } from '../types.js';

export function openConversationsView(config: APIConfig): ConversationViews {
	function defaultState(): ConversationsViewState {
		return {
			conversations: [],
			numUnread: 0,
			numUnaccepted: 0,
			loading: false
		};
	}
	function reset(fields?: { loading?: boolean; currentUser: User | undefined }) {
		$store = defaultState();
		$store.currentUser = fields?.currentUser;
		$store.loading = fields?.loading || false;
		store.set($store);
	}

	const pollingInterval = config.pollingInterval || 20;
	const api = new API(config.endpoint);
	let $store: ConversationsViewState = defaultState();

	let timeout: 'first' | NodeJS.Timeout | undefined;
	async function fetchConversations() {
		if ($store.currentUser) {
			const { conversations } = await api.getConversations(
				{
					domain: config.domain,
					namespace: config.namespace
				},
				{
					privateKey: $store.currentUser.delegatePrivateKey
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
			$store.loading = false;
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
		timeout = 'first';
		fetchConversationsAgainAndAgain();
		return () => timeout && timeout != 'first' && clearTimeout(timeout);
	});

	function setCurrentUser(newUser: User | undefined) {
		if (newUser) {
			if (newUser.address !== $store.currentUser?.address) {
				reset({ loading: true, currentUser: { ...newUser } });
				fetchConversations();
			}
		} else {
			reset();
		}
	}

	return {
		subscribe: store.subscribe,
		setCurrentUser
	};
}
