import type { Readable } from 'svelte/store';
import {
	getConversationID,
	inboxConversationKey,
	ulidAt,
	type Address,
	type KeySet,
	type Message,
	type PublicKeySet,
	type ResponseSendMessage
} from '@missiv/common';
import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { API, MissivAPIError, type FetchFunction } from '$lib/API.js';
import {
	activeStore,
	retryUntilDone,
	toStoreError,
	type StoreError
} from '$lib/utils/lifecycle.js';
import { openInboxChannel, type CreateInboxSocket } from '$lib/inbox/index.js';
import {
	composeIntroduction,
	composeMessage,
	openMessage,
	verifyDomainUser,
	type OpenedMessage
} from '$lib/messages.js';

/** A message the server returned for another scope than the thread asked for: never opened. */
function notThisConversation(message: Message): OpenedMessage {
	const { content: _, ...rest } = message;
	return {
		...rest,
		error: { code: 'unverified', message: 'this message is not from this conversation' }
	};
}

export type OtherUser = {
	address: Address;
	name?: string;
	/** the other user's current key set, set only once its ownership proof is verified */
	keySet?: PublicKeySet;
	/** the server returned a key set whose ownership proof does not verify: nothing is encrypted to it */
	unverifiedKey?: boolean;
};

/** A conversation of two: the account of the registration and `otherUser`. */
export type ConversationState = { error?: StoreError; otherUser: OtherUser } & (
	| // no registered account
	{ step: 'Idle'; conversationID: undefined }
	// fetching the newest messages for the first time
	| { step: 'Fetching'; conversationID: string }
	// fetched, then kept current by the live inbox channel (each new message
	// pushed, what was missed synced by seq after a reconnection); in seq order,
	// newest last; each message opened on its own
	| { step: 'Fetched'; conversationID: string; messages: OpenedMessage[] }
);

export type CurrentConversation = Readable<ConversationState> & {
	/** send encrypted (`pairwise-v1`) to the other user's verified key set; refused when there is none */
	sendMessage(text: string): Promise<void>;
	/** send in clear, readable by the server: only when asked, to reach a user with no verified key set */
	sendIntroduction(text: string): Promise<void>;
};

/**
 * One conversation of two, while subscribed: the newest page over HTTP once,
 * then the live inbox channel (`openInboxChannel`, one socket shared with the
 * account's other stores): every new message is pushed and opened once
 * (`openMessage`, each seq once), and after every (re)connection a `sync` asks
 * for what came after the last seq it has. No polling. A message this store
 * sends is shown from the send's answer, its echo on the socket ignored.
 */
export function openOneConversation(params: {
	registration: MissivRegistrationStore;
	endpoint: string;
	domain: string;
	namespace: string;
	otherUser: { address: Address; name?: string };
	/** accept the conversation (once) and mark it read up to each newer message shown */
	markAsAcceptedAndRead?: boolean;
	/** the fetch the API calls go through (the in-process server in tests) */
	fetch?: FetchFunction;
	/** how the live channel's socket is made (default: `new WebSocket(url, protocols)`) */
	createWebSocket?: CreateInboxSocket;
	/** the first delay before a retry (a failed fetch, a lost socket), doubled up to 30 s (default 1 s) */
	retryDelayMs?: number;
}): CurrentConversation {
	const api = new API(params.endpoint, params.fetch ? { fetch: params.fetch } : undefined);
	const { domain, namespace } = params;
	// a key is only ever the one this store verified
	const initialOther: OtherUser = {
		address: params.otherUser.address,
		name: params.otherUser.name
	};

	/** the account of the current run, and how to show a message it sent */
	let current:
		| {
				address: Address;
				keySet: KeySet;
				conversationID: string;
				add(messages: Message[]): Promise<void>;
		  }
		| undefined;

	const store = activeStore<MissivRegistration, ConversationState>({
		source: params.registration,
		key: (registration) => (registration.step === 'Registered' ? registration.address : ''),
		initial: { step: 'Idle', conversationID: undefined, otherUser: initialOther },
		run(registration, ctx) {
			if (registration.step !== 'Registered') {
				current = undefined;
				ctx.set({ step: 'Idle', conversationID: undefined, otherUser: initialOther });
				return;
			}
			const address = registration.address;
			const keySet = registration.keySet;
			const privateKey = keySet.signing.privateKey;
			const conversationID = getConversationID(address, params.otherUser.address);
			const syncKey = inboxConversationKey({ namespace, conversationID });
			const reader = { address, domain, keySet };
			ctx.set({ step: 'Fetching', conversationID, otherUser: initialOther });
			let lastMarked = 0;
			let accepted = false;
			let marking: Promise<void> = Promise.resolve();
			/** every seq opened or being opened, so each is opened once */
			const known = new Set<number>();
			/** the openings in flight, by seq */
			const opening = new Map<number, Promise<void>>();
			/** seqs whose opening failed (a key set fetch): the sync cursor stays below them */
			const failed = new Set<number>();
			let opened: OpenedMessage[] = [];
			let fetched = false;
			let stopFetch: (() => void) | undefined;

			const setError = (message: string) => (err: unknown) =>
				ctx.update((state) => ({ ...state, error: toStoreError(message, err) }));

			/** the seq a sync asks after: the newest this run has, below any it failed to open */
			function cursor(): number {
				const newest = opened.length ? opened[opened.length - 1].seq : 0;
				return failed.size > 0 ? Math.min(newest, Math.min(...failed) - 1) : newest;
			}

			async function resolveOtherKey() {
				const { otherUser } = ctx.get();
				if (otherUser.keySet) {
					return;
				}
				const { domainUser } = await api.getDomainUser({
					type: 'getDomainUser',
					address: otherUser.address,
					domain
				});
				if (!domainUser) {
					return;
				}
				const verified = await verifyDomainUser(domainUser, { address: otherUser.address, domain });
				ctx.update((state) => ({
					...state,
					otherUser: verified
						? {
								...state.otherUser,
								keySet: domainUser.keySet,
								name: domainUser.name ?? state.otherUser.name,
								unverifiedKey: false
							}
						: { ...state.otherUser, unverifiedKey: true }
				}));
			}

			function publish() {
				if (!fetched || !ctx.active) return;
				ctx.update((state) => ({
					step: 'Fetched',
					conversationID,
					otherUser: state.otherUser,
					messages: opened
				}));
				markIfNeeded();
			}

			function markIfNeeded() {
				const newest = opened[opened.length - 1];
				if (!params.markAsAcceptedAndRead || !newest || newest.seq <= lastMarked) return;
				lastMarked = newest.seq;
				const seq = newest.seq;
				marking = marking
					.then(async () => {
						if (!accepted) {
							await api.accept(
								{ type: 'accept', domain, namespace, conversationID },
								{ privateKey }
							);
							accepted = true;
						}
						await api.markRead(
							{ type: 'markRead', domain, namespace, conversationID, seq },
							{ privateKey }
						);
					})
					.catch(setError('failed to mark the conversation read'));
			}

			/**
			 * Open the messages not yet known and add them in seq order. A message the
			 * server returns for another scope (domain, namespace or conversation) is
			 * not this thread's: shown as unverified, never opened.
			 */
			async function add(messages: Message[]) {
				// a seq being opened (its echo raced the send's answer) is awaited, not opened twice
				const inFlight = messages.flatMap((message) => {
					const promise = opening.get(message.seq);
					return promise ? [promise] : [];
				});
				const fresh = messages.filter((message) => !known.has(message.seq));
				for (const message of fresh) known.add(message.seq);
				if (fresh.length === 0) {
					await Promise.all(inFlight);
					return;
				}
				const settled = Promise.allSettled(
					fresh.map((message) =>
						message.domain === domain &&
						message.namespace === namespace &&
						message.conversationID === conversationID
							? openMessage(message, reader, api)
							: Promise.resolve(notThisConversation(message))
					)
				).then((results) => {
					if (!ctx.active) return;
					const done: OpenedMessage[] = [];
					results.forEach((result, i) => {
						const seq = fresh[i].seq;
						if (result.status === 'fulfilled') {
							failed.delete(seq);
							done.push(result.value);
						} else {
							// opened again when a sync brings it back
							known.delete(seq);
							failed.add(seq);
							setError('failed to open a message')(result.reason);
						}
					});
					opened = [...opened, ...done].sort((a, b) => a.seq - b.seq);
					publish();
				});
				for (const message of fresh) opening.set(message.seq, settled);
				try {
					await Promise.all([settled, ...inFlight]);
				} finally {
					for (const message of fresh) {
						if (opening.get(message.seq) === settled) opening.delete(message.seq);
					}
				}
			}

			async function fetchNewest() {
				await resolveOtherKey();
				const page = await api.listMessages(
					{ type: 'listMessages', domain, namespace, conversationID },
					{ privateKey }
				);
				if (!ctx.active) return;
				await add(page.messages);
				fetched = true;
				publish();
				// what arrived between the page's read and the socket's opening
				await channel.sync({ [syncKey]: cursor() });
			}

			function startFetching() {
				if (stopFetch) return;
				stopFetch = retryUntilDone(
					ctx,
					fetchNewest,
					setError('failed to fetch the messages'),
					params.retryDelayMs
				);
			}

			const channel = openInboxChannel({
				endpoint: params.endpoint,
				domain,
				privateKey,
				api,
				createWebSocket: params.createWebSocket,
				reconnectDelayMs: params.retryDelayMs
			});
			const unsubscribe = channel.subscribe({
				onOpen() {
					ctx.update(({ error: _, ...state }) => state as ConversationState);
					if (fetched) {
						channel.sync({ [syncKey]: cursor() });
					} else {
						startFetching();
					}
				},
				onMessage(message) {
					if (
						message.domain === domain &&
						message.namespace === namespace &&
						message.conversationID === conversationID
					) {
						add([message]).catch(setError('failed to open a message'));
					}
				},
				onError(err) {
					// without the channel, the history still shows
					startFetching();
					setError('the live inbox is not connected')(err);
				}
			});

			const run = { address, keySet, conversationID, add };
			current = run;
			return () => {
				unsubscribe();
				stopFetch?.();
				if (current === run) current = undefined;
			};
		}
	});

	function requireRun() {
		if (!current) {
			throw new Error(`no registered account (or the conversation has no subscriber)`);
		}
		return current;
	}

	/**
	 * Send a composed message; when the server refuses its messageID as `stale`
	 * (this device's clock is off), compose it once more under a messageID of
	 * the server's time.
	 */
	async function send(
		run: NonNullable<typeof current>,
		compose: (messageID?: string) => ReturnType<typeof composeMessage>
	) {
		const options = { privateKey: run.keySet.signing.privateKey };
		let message = await compose();
		let answer: ResponseSendMessage;
		try {
			answer = await api.sendMessage({ type: 'sendMessage', message }, options);
		} catch (err) {
			const serverTime = (err as MissivAPIError)?.details as { serverTime?: number } | undefined;
			if (!(err instanceof MissivAPIError && err.code === 'stale' && serverTime?.serverTime)) {
				throw err;
			}
			message = await compose(ulidAt(serverTime.serverTime));
			answer = await api.sendMessage({ type: 'sendMessage', message }, options);
		}
		// shown at once, whether or not the live channel is connected; its echo is ignored
		await run.add([{ ...message, ...answer }]).catch(() => {});
	}

	async function sendMessage(text: string) {
		const run = requireRun();
		const { otherUser } = store.get();
		const keySet = otherUser.keySet;
		if (!keySet) {
			throw new Error(
				otherUser.unverifiedKey
					? `the other user's key set is not proven by their wallet: nothing is sent`
					: `the other user has no key set yet: send an introduction in clear with sendIntroduction`
			);
		}
		await send(run, (messageID) =>
			composeMessage({
				destination: { domain, namespace },
				sender: run,
				recipient: { address: otherUser.address, keySet },
				text,
				messageID
			})
		);
	}

	async function sendIntroduction(text: string) {
		const run = requireRun();
		await send(run, (messageID) =>
			composeIntroduction({
				destination: { domain, namespace },
				sender: run,
				recipient: { address: params.otherUser.address },
				text,
				messageID
			})
		);
	}

	return { subscribe: store.subscribe, sendMessage, sendIntroduction };
}
