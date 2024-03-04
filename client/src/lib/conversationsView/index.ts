import { writable } from 'svelte/store';
import type { ActionGetConversations, Conversation } from 'missiv';
import { API } from '$lib/utils/API.js';

export type ConversationsViewState = {
	conversations: Conversation[];
	numUnread: number;
	numUnaccepted: number;
};

export function openComversationsView(config: {
	privateKey: `0x${string}`;
	endpoint: string;
	namespace: string;
	pollingInterval?: number;
}) {
	const pollingInterval = config.pollingInterval || 20000;
	const api = new API(config.endpoint);
	const $store: ConversationsViewState = {
		conversations: [],
		numUnread: 0,
		numUnaccepted: 0
	};
	const store = writable<ConversationsViewState>($store, (set, update) => {
		let timeout: 'first' | NodeJS.Timeout | undefined;
		async function fetchConversations() {
			const action: ActionGetConversations = {
				type: 'getConversations',
				namespace: config.namespace
			};
			const conversations = await api.getConversations(
				{
					namespace: config.namespace
				},
				{
					privateKey: config.privateKey
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
			if (timeout) {
				$store.conversations = conversations;
				set($store);
				timeout = setTimeout(fetchConversations, pollingInterval * 1000);
			}
			// else we stop as we cleared the timeout
		}
		fetchConversations();
		return () => timeout && timeout != 'first' && clearTimeout(timeout);
	});

	function setAccount(account: `0x${string}`) {}

	return {
		subscribe: store.subscribe,
		setAccount
	};
}
