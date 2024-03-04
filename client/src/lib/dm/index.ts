import { writable } from 'svelte/store';

export type DMState = {
	conversactions: {
		other: `0x${string}`;
		unread: boolean;
	}[];
	numUnread: number;
};

export type ConversationState = {
	other: `0x${string}`;
	unread: boolean;
	messages: { content: string; timestampMS: number }[];
};

export function openDM(config: { endpoint: string }) {
	const $store = {
		conversactions: [],
		numUnread: 0
	};
	const store = writable<DMState>($store, (set, update) => {
		let timeout: 'first' | NodeJS.Timeout | undefined;
		async function fetchConversations() {
			const conversations = await fetch(config.endpoint);
			if (timeout) {
				$store.conversactions = [];
				set($store);
				timeout = setTimeout(fetchConversations, 20000);
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

export function openConversation(other: `0x${string}`) {
	const store = writable<ConversationState>({
		other,
		messages: [],
		unread: false
	});
}
