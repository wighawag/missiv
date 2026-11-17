import { get, type Readable } from 'svelte/store';
import { getConversationID, type Address, type PublicKey } from 'missiv-common';
import type { MissivRegistration, MissivRegistrationStore } from '$lib/index.js';
import { API, type FetchFunction } from '$lib/index.js';
import { derivedWithStartStopNotifier } from '$lib/utils/store.js';
import {
	clearCopies,
	encryptedCopies,
	openMessage,
	verifyDomainUser,
	type OpenedMessage
} from '$lib/messages.js';

// TODO support group chat
export type ConversationState = { error?: { message: string; cause?: any } } & {
	conversationID: string;
	otherUser: OtherUser;
	account: LoadedAccount;
} & (
		| // start in Idle
		{
				step: 'Idle';
				invalidAccount: boolean;
		  }
		// will then be "Fetching" to fetch the messages
		| {
				step: 'Fetching';
				conversationID: string;
		  }
		// finally it is in "Fetched" step but will still be fetching new messages in the background
		| {
				step: 'Fetched';
				conversationID: string;

				messages: OpenedMessage[];
		  }
	);

export type CurrentConversation = Readable<ConversationState> & {
	/** send encrypted to the other user's verified key; refused when there is none */
	sendMessage(text: string): Promise<void>;
	/** send in clear, readable by the server: only when asked, to reach a user with no verified key */
	sendIntroduction(text: string): Promise<void>;
};

export type LoadedAccount = {
	address: `0x${string}`;
	signer: {
		address: string;
		privateKey: string;
		publicKey: string;
	};
};

export type OtherUser = {
	address: Address;
	name?: string;
	/** the other user's key, set only once its ownership proof is verified */
	publicKey?: PublicKey;
	/** the server returned a key whose ownership proof does not verify: nothing is encrypted to it */
	unverifiedKey?: boolean;
};

// TODO remove: markAsAcceptedAndRead
//   once we handle accepted/naccepted conversation in the UI we do it automatically here
export function openOneConversation(params: {
	registration: MissivRegistrationStore;
	endpoint: string;
	domain: string;
	namespace: string;
	pollingInterval?: number;
	account: LoadedAccount;
	otherUser: OtherUser;
	markAsAcceptedAndRead?: boolean;
	/** the fetch the API calls go through (the in-process server in tests) */
	fetch?: FetchFunction;
}): CurrentConversation {
	const conversationID = getConversationID(params.account.address, params.otherUser.address);

	const pollingInterval = params.pollingInterval || 2;
	const api = new API(params.endpoint, params.fetch ? { fetch: params.fetch } : undefined);

	let $conversation: ConversationState = {
		step: 'Fetching',
		conversationID,
		account: params.account,
		// a key is only ever the one this store verified
		otherUser: { address: params.otherUser.address, name: params.otherUser.name }
	};
	let _set: (value: ConversationState) => void;
	let _registration: MissivRegistration = get(params.registration);

	function set(conversation: ConversationState) {
		$conversation = conversation;
		_set($conversation);
		return $conversation;
	}

	let fetching = true;
	let running = false;
	function onStart() {
		running = true;
		// TODO mixing registration and conversaiton steps
		if (fetching || $conversation.step === 'Fetched') {
			if (_registration.step !== 'Registered') {
				return;
			}
			startFetching(_registration.address);
		}
	}

	async function startFetching(address: string) {
		fetchMessagesgainAndAgain(address);
	}

	let timeout: NodeJS.Timeout | undefined;
	async function fetchMessagesgainAndAgain(address: string) {
		await fetchMessages(address);
		timeout = setTimeout(fetchMessagesgainAndAgain, pollingInterval * 1000, address);
	}

	async function fetchMessages(address: string) {
		if (_registration.step !== 'Registered') {
			return;
		}
		if ($conversation.step === 'Idle') {
			return;
		}
		if (!$conversation.otherUser.publicKey) {
			const { domainUser } = await api.getDomainUser({
				type: 'getDomainUser',
				address: $conversation.otherUser.address,
				domain: params.domain
			});
			if (domainUser) {
				const verified = await verifyDomainUser(domainUser, {
					address: $conversation.otherUser.address,
					domain: params.domain
				});
				set({
					...$conversation,
					otherUser: verified
						? {
								...$conversation.otherUser,
								publicKey: domainUser.publicKey,
								name: domainUser.name ?? undefined,
								unverifiedKey: false
							}
						: { ...$conversation.otherUser, unverifiedKey: true }
				});
			}
		}
		const { messages: copies } = await api.getMessages(
			{
				type: `getMessages`,
				domain: params.domain,
				namespace: params.namespace,
				conversationID
			},
			{
				privateKey: $conversation.account.signer.privateKey
			}
		);

		const reader = {
			address: $conversation.account.address,
			domain: params.domain,
			privateKey: $conversation.account.signer.privateKey
		};
		const messages = await Promise.all(copies.map((copy) => openMessage(copy, reader)));

		if (params.markAsAcceptedAndRead) {
			api.acceptConversation(
				{
					type: 'acceptConversation',
					domain: params.domain,
					namespace: params.namespace,
					conversationID,
					lastMessageReadTimestampMS: Date.now() // TODO ?
				},
				{
					privateKey: $conversation.account.signer.privateKey
				}
			);
		}

		const messageList = messages.reverse();

		if (_registration.address === address) {
			if ($conversation.step === 'Fetching') {
				set({
					...$conversation,
					step: 'Fetched',
					messages: messageList
				});
			} else if ($conversation.step === 'Fetched') {
				set({
					...$conversation,
					messages: messageList
				});
			} else {
				// we ignore
			}
		} else {
			// we ignore
		}
	}

	function stopFetching() {
		if (timeout) {
			clearTimeout(timeout);
		}
	}

	async function onRegistrationChanged(
		oldRegistration: MissivRegistration,
		newRegistration: MissivRegistration
	) {
		const newAddress = newRegistration.step === 'Registered' ? newRegistration.address : undefined;
		const oldAddress = oldRegistration.step === 'Registered' ? oldRegistration.address : undefined;

		const addressChanged =
			(newAddress && !oldAddress) || (!newAddress && oldAddress) || newAddress !== oldAddress;

		if (addressChanged) {
			if (newAddress) {
				set({
					step: 'Fetching',
					account: $conversation.account,
					conversationID: $conversation.conversationID,
					otherUser: $conversation.otherUser
				});
				fetching = true;
				startFetching(newAddress);
			} else {
				set({
					step: 'Idle',
					invalidAccount: true,
					account: $conversation.account,
					conversationID: $conversation.conversationID,
					otherUser: $conversation.otherUser
				});
				fetching = false;
				stopFetching();
			}
		}
	}

	function onStop() {
		running = false;
		if (fetching && $conversation.step === 'Fetched') {
			stopFetching();
		}
	}
	const { subscribe } = derivedWithStartStopNotifier<MissivRegistrationStore, ConversationState>(
		params.registration,
		($registration) => {
			const oldRegistration = _registration;
			_registration = $registration;
			onRegistrationChanged(oldRegistration, $registration);
			return $conversation;
		},
		$conversation,
		(set) => {
			_set = set;
			onStart();
			return onStop;
		}
	);

	function sender() {
		if ($conversation.step === 'Idle') {
			throw new Error(`Idle`);
		}
		return {
			address: $conversation.account.address,
			privateKey: $conversation.account.signer.privateKey
		};
	}

	function common() {
		return {
			type: 'sendMessage' as const,
			domain: params.domain,
			namespace: params.namespace,
			conversationID,
			lastMessageReadTimestampMS: Date.now()
		};
	}

	async function sendMessage(text: string) {
		const from = sender();
		const publicKey = $conversation.otherUser.publicKey;
		if (!publicKey) {
			throw new Error(
				$conversation.otherUser.unverifiedKey
					? `the other user's key is not proven by their wallet: nothing is sent`
					: `the other user has no key yet: send an introduction in clear with sendIntroduction`
			);
		}
		const scope = { domain: params.domain, namespace: params.namespace, conversationID };
		const messages = await encryptedCopies({
			scope,
			sender: from,
			recipient: { address: $conversation.otherUser.address, publicKey },
			text
		});
		await api.sendMessage(
			{ ...common(), messageType: 'encrypted', messages },
			{ privateKey: from.privateKey }
		);
	}

	async function sendIntroduction(text: string) {
		const from = sender();
		const scope = { domain: params.domain, namespace: params.namespace, conversationID };
		const messages = await clearCopies({
			scope,
			sender: from,
			recipients: [$conversation.otherUser.address],
			text
		});
		await api.sendMessage(
			{ ...common(), messageType: 'clear', messages },
			{ privateKey: from.privateKey }
		);
	}

	return {
		subscribe,
		sendMessage,
		sendIntroduction
	};
}
