import { writable } from 'svelte/store';

export type ConversationState = {
	other: `0x${string}`;
	unread: boolean;
	messages: { content: string; timestampMS: number }[];
};

export function openConversation(other: `0x${string}`) {
	const store = writable<ConversationState>({
		other,
		messages: [],
		unread: false
	});
}
