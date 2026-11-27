import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { API, type FetchFunction } from '$lib/API.js';
import { activeStore, poll, toStoreError, type StoreError } from '$lib/utils/lifecycle.js';
import type { Conversation } from '@missiv/common';

export type ConversationList = { error?: StoreError } & (
	| // no registered account
	{
			step: 'Idle';
	  }
	// fetching the account's conversations for the first time
	| {
			step: 'Fetching';
			address: string;
	  }
	// fetched, and polled again while subscribed
	| {
			step: 'Fetched';
			address: string;
			conversations: Conversation[];
			/** accepted conversations with a message newer than their last read */
			numUnread: number;
			/** conversation requests: not accepted yet */
			numUnaccepted: number;
	  }
);

/** The counts a conversation list shows. */
export function countConversations(conversations: Conversation[]) {
	let numUnread = 0;
	let numUnaccepted = 0;
	for (const conversation of conversations) {
		if (!conversation.accepted) {
			numUnaccepted++;
		} else if (conversation.lastRead < conversation.lastMessage) {
			numUnread++;
		}
	}
	return { numUnread, numUnaccepted };
}

export function openConversationList(params: {
	registration: MissivRegistrationStore;
	endpoint: string;
	domain: string;
	namespace: string;
	/** seconds between two fetches (default 20) */
	pollingInterval?: number;
	/** the fetch the API calls go through (the in-process server in tests) */
	fetch?: FetchFunction;
}) {
	const pollingInterval = params.pollingInterval || 20;
	const api = new API(params.endpoint, params.fetch ? { fetch: params.fetch } : undefined);

	const store = activeStore<MissivRegistration, ConversationList>({
		source: params.registration,
		key: (registration) => (registration.step === 'Registered' ? registration.address : ''),
		initial: { step: 'Idle' },
		run(registration, ctx) {
			if (registration.step !== 'Registered') {
				ctx.set({ step: 'Idle' });
				return;
			}
			const { address, keySet } = registration;
			ctx.set({ step: 'Fetching', address });
			return poll(
				ctx,
				pollingInterval * 1000,
				async () => {
					const { conversations } = await api.getConversations(
						{ type: 'getConversations', domain: params.domain, namespace: params.namespace },
						{ privateKey: keySet.signing.privateKey }
					);
					ctx.set({
						step: 'Fetched',
						address,
						conversations,
						...countConversations(conversations)
					});
				},
				(err) =>
					ctx.update((list) => ({
						...list,
						error: toStoreError('failed to fetch the conversations', err)
					}))
			);
		}
	});

	return { subscribe: store.subscribe };
}

export type ConversationListStore = ReturnType<typeof openConversationList>;
