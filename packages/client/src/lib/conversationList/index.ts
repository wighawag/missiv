import { API } from '$lib/API.js';
import type { MissivRegistration, MissivRegistrationStore } from '$lib/registration/index.js';
import { derivedWithStartStopNotifier } from '$lib/utils/store.js';
import type { Conversation } from 'missiv-common';
import { get } from 'svelte/store';

export type ConversationList = { error?: { message: string; cause?: any } } & (
	| // start in Idle
	{
			step: 'Idle';
	  }

	// will then be "Fetching" to fetch the conversations
	| {
			step: 'Fetching';
			address: string;
	  }
	// finally it is in "Fetched" step but will still be fetching new conversations in the background
	| {
			step: 'Fetched';
			address: string;
			conversations: Conversation[];
			numUnread: number;
			numUnaccepted: number;
	  }
);

export function openConversationList(params: {
	registration: MissivRegistrationStore;
	endpoint: string;
	domain: string;
	namespace: string;
	pollingInterval?: number;
}) {
	const pollingInterval = params.pollingInterval || 20;
	const api = new API(params.endpoint);

	let $conversationList: ConversationList = {
		step: 'Idle'
	};
	let _set: (value: ConversationList) => void;
	let _registration: MissivRegistration = get(params.registration);

	function set(conversationList: ConversationList) {
		$conversationList = conversationList;
		_set($conversationList);
		return $conversationList;
	}

	let fetching = true;
	let running = false;
	function onStart() {
		running = true;
		if (fetching && $conversationList.step === 'Fetched') {
			startFetching($conversationList.address);
		}
	}

	async function startFetching(address: string) {
		fetchConversationsAgainAndAgain(address);
	}

	let timeout: NodeJS.Timeout | undefined;
	async function fetchConversationsAgainAndAgain(address: string) {
		await fetchConversations(address);
		if (timeout) {
			timeout = setTimeout(fetchConversationsAgainAndAgain, pollingInterval * 1000, address);
		} // else we stop as we cleared the timeout
	}

	async function fetchConversations(address: string) {
		if (_registration.step !== 'Registered') {
			return;
		}

		const { conversations } = await api.getConversations(
			{
				type: 'getConversations',
				domain: params.domain,
				namespace: params.namespace
			},
			{
				privateKey: _registration.signer.privateKey
			}
		);

		let numUnread = 0;
		let numUnaccepted = 0;
		for (const conversation of conversations) {
			// TODO remake
			if (conversation.accepted) {
				numUnaccepted++;
			} else if (conversation.lastRead < conversation.lastMessage) {
				numUnread++;
				// what about accepted
			}
		}

		if (_registration.address === address) {
			if ($conversationList.step === 'Fetching') {
				set({
					step: 'Fetched',
					address,
					conversations,
					numUnread,
					numUnaccepted
				});
			} else if ($conversationList.step === 'Fetched') {
				set({
					...$conversationList,
					conversations,
					numUnread,
					numUnaccepted
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
					address: newAddress
				});
				fetching = true;
				startFetching(newAddress);
			} else {
				set({
					step: 'Idle'
				});
				fetching = false;
				stopFetching();
			}
		}
	}

	function onStop() {
		running = false;
		if (fetching && $conversationList.step === 'Fetched') {
			stopFetching();
		}
	}

	const { subscribe } = derivedWithStartStopNotifier<MissivRegistrationStore, ConversationList>(
		params.registration,
		($registration) => {
			const oldRegistration = _registration;
			_registration = $registration;
			onRegistrationChanged(oldRegistration, $registration);
			return $conversationList;
		},
		$conversationList,
		(set) => {
			_set = set;
			onStart();
			return onStop;
		}
	);

	return {
		subscribe
	};
}

export type ConversationListStore = ReturnType<typeof openConversationList>;
