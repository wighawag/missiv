import type { Readable } from 'svelte/store';
import { getConversationID, type Address, type PublicKey } from 'missiv-common';
import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { API, type FetchFunction } from '$lib/API.js';
import { activeStore, poll, toStoreError, type StoreError } from '$lib/utils/lifecycle.js';
import {
	clearCopies,
	encryptedCopies,
	openMessage,
	verifyDomainUser,
	type OpenedMessage
} from '$lib/messages.js';

export type OtherUser = {
	address: Address;
	name?: string;
	/** the other user's key, set only once its ownership proof is verified */
	publicKey?: PublicKey;
	/** the server returned a key whose ownership proof does not verify: nothing is encrypted to it */
	unverifiedKey?: boolean;
};

/** A conversation of two: the account of the registration and `otherUser`. */
export type ConversationState = { error?: StoreError; otherUser: OtherUser } & (
	| // no registered account
	{ step: 'Idle'; conversationID: undefined }
	// fetching the messages for the first time
	| { step: 'Fetching'; conversationID: string }
	// fetched, and polled again while subscribed; newest last; each copy opened on its own
	| { step: 'Fetched'; conversationID: string; messages: OpenedMessage[] }
);

export type CurrentConversation = Readable<ConversationState> & {
	/** send encrypted to the other user's verified key; refused when there is none */
	sendMessage(text: string): Promise<void>;
	/** send in clear, readable by the server: only when asked, to reach a user with no verified key */
	sendIntroduction(text: string): Promise<void>;
};

export function openOneConversation(params: {
	registration: MissivRegistrationStore;
	endpoint: string;
	domain: string;
	namespace: string;
	/** seconds between two fetches (default 2) */
	pollingInterval?: number;
	otherUser: { address: Address; name?: string };
	/** accept the conversation and mark it read each time a newer message is shown */
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
		| { address: Address; privateKey: string; conversationID: string; refresh(): Promise<void> }
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
			const privateKey = registration.signer.privateKey;
			const conversationID = getConversationID(address, params.otherUser.address);
			const reader = { address, domain, privateKey };
			ctx.set({ step: 'Fetching', conversationID, otherUser: initialOther });
			let lastMarked = 0;

			async function resolveOtherKey() {
				const { otherUser } = ctx.get();
				if (otherUser.publicKey) {
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
								publicKey: domainUser.publicKey,
								name: domainUser.name ?? state.otherUser.name,
								unverifiedKey: false
							}
						: { ...state.otherUser, unverifiedKey: true }
				}));
			}

			async function fetchMessages() {
				await resolveOtherKey();
				const { messages: copies } = await api.getMessages(
					{ type: 'getMessages', domain, namespace, conversationID },
					{ privateKey }
				);
				const messages = (
					await Promise.all(copies.map((copy) => openMessage(copy, reader)))
				).reverse();
				if (!ctx.active) {
					return;
				}
				ctx.update((state) => ({
					step: 'Fetched',
					conversationID,
					otherUser: state.otherUser,
					messages
				}));
				const newest = messages[messages.length - 1];
				if (params.markAsAcceptedAndRead && newest && newest.timestamp > lastMarked) {
					lastMarked = newest.timestamp;
					await api.acceptConversation(
						{
							type: 'acceptConversation',
							domain,
							namespace,
							conversationID,
							lastMessageReadTimestampMS: newest.timestamp
						},
						{ privateKey }
					);
				}
			}

			const run = { address, privateKey, conversationID, refresh: fetchMessages };
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

	function action(conversationID: string) {
		return {
			type: 'sendMessage' as const,
			domain,
			namespace,
			conversationID,
			lastMessageReadTimestampMS: Date.now()
		};
	}

	async function sendMessage(text: string) {
		const run = requireRun();
		const { otherUser } = store.get();
		if (!otherUser.publicKey) {
			throw new Error(
				otherUser.unverifiedKey
					? `the other user's key is not proven by their wallet: nothing is sent`
					: `the other user has no key yet: send an introduction in clear with sendIntroduction`
			);
		}
		const messages = await encryptedCopies({
			scope: { domain, namespace, conversationID: run.conversationID },
			sender: run,
			recipient: { address: otherUser.address, publicKey: otherUser.publicKey },
			text
		});
		await api.sendMessage(
			{ ...action(run.conversationID), messageType: 'encrypted', messages },
			{ privateKey: run.privateKey }
		);
		await run.refresh().catch(() => {});
	}

	async function sendIntroduction(text: string) {
		const run = requireRun();
		const messages = await clearCopies({
			scope: { domain, namespace, conversationID: run.conversationID },
			sender: run,
			recipients: [params.otherUser.address],
			text
		});
		await api.sendMessage(
			{ ...action(run.conversationID), messageType: 'clear', messages },
			{ privateKey: run.privateKey }
		);
		await run.refresh().catch(() => {});
	}

	return { subscribe: store.subscribe, sendMessage, sendIntroduction };
}
