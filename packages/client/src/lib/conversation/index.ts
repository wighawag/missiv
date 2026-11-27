import type { Readable } from 'svelte/store';
import {
	getConversationID,
	ulidAt,
	type Address,
	type KeySet,
	type PublicKeySet
} from '@missiv/common';
import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { API, MissivAPIError, type FetchFunction } from '$lib/API.js';
import { activeStore, poll, toStoreError, type StoreError } from '$lib/utils/lifecycle.js';
import {
	composeIntroduction,
	composeMessage,
	openMessage,
	verifyDomainUser,
	type OpenedMessage
} from '$lib/messages.js';

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
	// fetching the messages for the first time
	| { step: 'Fetching'; conversationID: string }
	// fetched, and polled again while subscribed for what is new (by seq); in seq
	// order, newest last; each message opened on its own
	| { step: 'Fetched'; conversationID: string; messages: OpenedMessage[] }
);

export type CurrentConversation = Readable<ConversationState> & {
	/** send encrypted (`pairwise-v1`) to the other user's verified key set; refused when there is none */
	sendMessage(text: string): Promise<void>;
	/** send in clear, readable by the server: only when asked, to reach a user with no verified key set */
	sendIntroduction(text: string): Promise<void>;
};

/**
 * One conversation of two, while subscribed: the newest page first, then every
 * poll fetches only the messages after the last seq it has (`listMessages`
 * with `after`), opening each new one once (`openMessage`). Polling stays until
 * the live inbox channel (task `live-inbox-channel`).
 */
export function openOneConversation(params: {
	registration: MissivRegistrationStore;
	endpoint: string;
	domain: string;
	namespace: string;
	/** seconds between two fetches (default 2) */
	pollingInterval?: number;
	otherUser: { address: Address; name?: string };
	/** accept the conversation (once) and mark it read up to each newer message shown */
	markAsAcceptedAndRead?: boolean;
	/** the fetch the API calls go through (the in-process server in tests) */
	fetch?: FetchFunction;
}): CurrentConversation {
	const pollingInterval = params.pollingInterval || 2;
	const api = new API(params.endpoint, params.fetch ? { fetch: params.fetch } : undefined);
	const { domain, namespace } = params;
	// a key is only ever the one this store verified
	const initialOther: OtherUser = {
		address: params.otherUser.address,
		name: params.otherUser.name
	};

	/** the account of the current run, and how to refresh it */
	let current:
		| { address: Address; keySet: KeySet; conversationID: string; refresh(): Promise<void> }
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
			const reader = { address, domain, keySet };
			ctx.set({ step: 'Fetching', conversationID, otherUser: initialOther });
			let lastMarked = 0;
			let accepted = false;
			/** the newest seq this run has, the cursor of the next fetch */
			let lastSeq: number | undefined;
			let opened: OpenedMessage[] = [];

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

			async function fetchMessages() {
				await resolveOtherKey();
				// the first fetch is the newest page (older ones are not paged in here);
				// every later one each page after the newest seq this run has, so a burst
				// larger than a page is not skipped
				let more = true;
				while (more) {
					const page = await api.listMessages(
						{
							type: 'listMessages',
							domain,
							namespace,
							conversationID,
							...(lastSeq !== undefined ? { after: lastSeq } : {})
						},
						{ privateKey }
					);
					// a key set fetch that fails throws here: the cursor stays, the next poll retries
					const fresh = await Promise.all(
						page.messages.map((message) => openMessage(message, reader, api))
					);
					if (!ctx.active) {
						return;
					}
					more = lastSeq !== undefined && page.hasMore;
					// a refresh after a send may overlap a poll: each seq once, in order
					const known = new Set(opened.map((message) => message.seq));
					opened = [...opened, ...fresh.filter((message) => !known.has(message.seq))].sort(
						(a, b) => a.seq - b.seq
					);
					lastSeq = Math.max(lastSeq ?? 0, ...page.messages.map((message) => message.seq));
				}
				ctx.update((state) => ({
					step: 'Fetched',
					conversationID,
					otherUser: state.otherUser,
					messages: opened
				}));
				const newest = opened[opened.length - 1];
				if (params.markAsAcceptedAndRead && newest && newest.seq > lastMarked) {
					lastMarked = newest.seq;
					if (!accepted) {
						await api.accept({ type: 'accept', domain, namespace, conversationID }, { privateKey });
						accepted = true;
					}
					await api.markRead(
						{ type: 'markRead', domain, namespace, conversationID, seq: newest.seq },
						{ privateKey }
					);
				}
			}

			const run = { address, keySet, conversationID, refresh: fetchMessages };
			current = run;
			const stop = poll(ctx, pollingInterval * 1000, fetchMessages, (err) =>
				ctx.update((state) => ({
					...state,
					error: toStoreError('failed to fetch the messages', err)
				}))
			);
			return () => {
				stop();
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
		try {
			await api.sendMessage({ type: 'sendMessage', message: await compose() }, options);
		} catch (err) {
			const serverTime = (err as MissivAPIError)?.details as { serverTime?: number } | undefined;
			if (!(err instanceof MissivAPIError && err.code === 'stale' && serverTime?.serverTime)) {
				throw err;
			}
			await api.sendMessage(
				{ type: 'sendMessage', message: await compose(ulidAt(serverTime.serverTime)) },
				options
			);
		}
		await run.refresh().catch(() => {});
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
