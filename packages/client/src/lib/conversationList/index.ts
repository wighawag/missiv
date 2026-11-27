import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { API, type FetchFunction } from '$lib/API.js';
import {
	activeStore,
	retryUntilDone,
	toStoreError,
	type StoreError
} from '$lib/utils/lifecycle.js';
import { openInboxChannel, type CreateInboxSocket } from '$lib/inbox/index.js';
import { isUnread, type Conversation } from '@missiv/common';

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
	// fetched, then kept current by the live inbox channel while subscribed
	| {
			step: 'Fetched';
			address: string;
			conversations: Conversation[];
			/** accepted conversations with a message newer than their last read (`lastReadSeq`) */
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
		if (conversation.status === 'unaccepted') {
			numUnaccepted++;
		} else if (conversation.status === 'accepted' && isUnread(conversation)) {
			numUnread++;
		}
	}
	return { numUnread, numUnaccepted };
}

/** Newest message first, as `listConversations` orders them. */
function byLastMessage(a: Conversation, b: Conversation) {
	return (
		b.lastMessageAt - a.lastMessageAt ||
		(a.conversationID < b.conversationID ? 1 : a.conversationID > b.conversationID ? -1 : 0)
	);
}

/**
 * The account's conversations in a domain and namespace, while subscribed: the
 * newest page (`listConversations`) each time the live inbox channel opens (the
 * first time and after every reconnection, when conversations may have started
 * or changed unseen), then kept current by the inbox rows the channel pushes
 * (each new message, accept, reject, markRead, from any of the account's
 * devices and stores), applied by `lastSeq` (never back). No polling.
 */
export function openConversationList(params: {
	registration: MissivRegistrationStore;
	endpoint: string;
	domain: string;
	namespace: string;
	/** the fetch the API calls go through (the in-process server in tests) */
	fetch?: FetchFunction;
	/** how the live channel's socket is made (default: `new WebSocket(url, protocols)`) */
	createWebSocket?: CreateInboxSocket;
	/** the first delay before a retry (a failed fetch, a lost socket), doubled up to 30 s (default 1 s) */
	retryDelayMs?: number;
	/** how often the live channel's socket sends its heartbeat `ping` (default 30 s) */
	heartbeatIntervalMs?: number;
	/** how long it waits for an answer before it gives the socket up and reconnects (default 10 s) */
	heartbeatTimeoutMs?: number;
}) {
	const api = new API(params.endpoint, params.fetch ? { fetch: params.fetch } : undefined);
	const { domain, namespace } = params;

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
			const privateKey = keySet.signing.privateKey;
			ctx.set({ step: 'Fetching', address });
			let rows = new Map<string, Conversation>();
			let fetched = false;
			/** the rows pushed while a fetch is in flight, applied over its answer */
			let pushedDuringFetch: Conversation[] | undefined;
			let stopFetch: (() => void) | undefined;

			function apply(map: Map<string, Conversation>, conversation: Conversation) {
				const known = map.get(conversation.conversationID);
				if (!known || conversation.lastSeq >= known.lastSeq) {
					map.set(conversation.conversationID, conversation);
				}
			}

			function publish() {
				if (!fetched || !ctx.active) return;
				const conversations = [...rows.values()].sort(byLastMessage);
				ctx.set({ step: 'Fetched', address, conversations, ...countConversations(conversations) });
			}

			async function fetchList() {
				pushedDuringFetch = [];
				try {
					const { conversations } = await api.listConversations(
						{ type: 'listConversations', domain, namespace },
						{ privateKey }
					);
					if (!ctx.active) return;
					const next = new Map<string, Conversation>();
					for (const conversation of conversations) apply(next, conversation);
					for (const conversation of pushedDuringFetch) apply(next, conversation);
					rows = next;
					fetched = true;
					publish();
				} finally {
					pushedDuringFetch = undefined;
				}
			}

			function refetch() {
				stopFetch?.();
				stopFetch = retryUntilDone(
					ctx,
					fetchList,
					(err) =>
						ctx.update((list) => ({
							...list,
							error: toStoreError('failed to fetch the conversations', err)
						})),
					params.retryDelayMs
				);
			}

			const channel = openInboxChannel({
				endpoint: params.endpoint,
				domain,
				privateKey,
				api,
				createWebSocket: params.createWebSocket,
				reconnectDelayMs: params.retryDelayMs,
				heartbeatIntervalMs: params.heartbeatIntervalMs,
				heartbeatTimeoutMs: params.heartbeatTimeoutMs
			});
			const unsubscribe = channel.subscribe({
				onOpen() {
					refetch();
				},
				onConversation(conversation) {
					if (conversation.domain !== domain || conversation.namespace !== namespace) return;
					pushedDuringFetch?.push(conversation);
					apply(rows, conversation);
					publish();
				},
				onError(err) {
					// without the channel, the list still shows (once)
					if (!fetched && !stopFetch) refetch();
					ctx.update((list) => ({
						...list,
						error: toStoreError('the live inbox is not connected', err)
					}));
				}
			});
			return () => {
				unsubscribe();
				stopFetch?.();
			};
		}
	});

	return { subscribe: store.subscribe };
}

export type ConversationListStore = ReturnType<typeof openConversationList>;
