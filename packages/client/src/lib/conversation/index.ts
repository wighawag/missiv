import { get, writable, type Readable } from 'svelte/store';
import { API } from '$lib/API.js';
import { getSharedSecret } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils';
import { base64 } from '@scure/base';
import {
	getConversationID,
	type ActionSendEncryptedMessage,
	type Address,
	type ConversationMessage,
	type PublicKey
} from 'missiv-common';
import type {
	Account,
	MissivRegistration,
	MissivRegistrationStore
} from '$lib/registration/index.js';
import { derivedWithStartStopNotifier } from '$lib/utils/store.js';

// TODO support group
export type ConversationState = { error?: { message: string; cause?: any } } & {
	conversationID: string;
	otherUser: OtherUser;
	account: LoadedAccount;
} & (
		| {
				step: 'Idle';
				invalidAccount: boolean;
		  }
		| {
				step: 'Fetching';
				conversationID: string;
		  }
		| {
				step: 'Fetched';
				conversationID: string;

				messages: ConversationMessage[];
		  }
	);

export type CurrentConversation = Readable<ConversationState> & {
	sendMessage(text: string): Promise<void>;
};

export type LoadedAccount = {
	address: string;
	signer: {
		address: string;
		privateKey: string;
		publicKey: string;
	};
};

export type OtherUser = {
	publicKey?: PublicKey;
	address: Address;
	name?: string;
};

const sharedKeyCache: { [userAndOtherpublicKey: string]: Uint8Array } = {};
const messageCache: { [idTimestamp: string]: string } = {};

function getSharedKey(
	user: { address: string; signer: { address: string; privateKey: string } },
	otherpublicKey: PublicKey
): Uint8Array {
	const cacheID = user.address.toLowerCase() + ':' + otherpublicKey;
	let sharedKey = sharedKeyCache[cacheID];
	if (!sharedKey) {
		const sharedSecret = getSharedSecret(user.signer.privateKey, otherpublicKey.slice(2));
		sharedKey = keccak_256(sharedSecret);
		sharedKeyCache[cacheID] = sharedKey;
	}

	return sharedKey;
}

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
}): CurrentConversation {
	const conversationID = getConversationID(params.account.address, params.otherUser.address);

	const pollingInterval = params.pollingInterval || 2;
	const api = new API(params.endpoint);

	let $conversation: ConversationState = {
		step: 'Fetching',
		conversationID,
		account: params.account,
		otherUser: params.otherUser
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
		if (fetching && $conversation.step === 'Fetched') {
			startFetching($conversation.address);
		}
	}

	async function startFetching(address: string) {
		fetchMessagesgainAndAgain(address);
	}

	let timeout: NodeJS.Timeout | undefined;
	async function fetchMessagesgainAndAgain() {
		await fetchMessages();
		if (timeout) {
			timeout = setTimeout(fetchMessagesgainAndAgain, pollingInterval * 1000);
		} // else we stop as we cleared the timeout
	}

	async function fetchMessages() {
		if ($conversation.account) {
			if (!$conversation.otherUser.publicKey) {
				const { completeUser } = await api.getCompleteUser({
					address: $conversation.otherUser.address,
					domain: params.domain
				});
				if (completeUser?.publicKey) {
					// $conversation.otherUser.publicKey = completeUser.publicKey;
					// $conversation.otherUser.name = completeUser.domainUsername || completeUser.name;
				}
			}
			const { messages } = await api.getMessages(
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

			for (let i = 0; i < messages.length; i++) {
				const message = messages[i];
				if (message.type === 'encrypted') {
					const cacheID = message.id + ':' + message.timestamp;
					let content = messageCache[cacheID];
					if (!content) {
						const sharedKey =
							message.recipient.toLowerCase() == $conversation.account.address.toLowerCase()
								? getSharedKey($conversation.account, message.senderPublicKey)
								: getSharedKey($conversation.account, message.recipientPublicKey);

						const [nonceb64, ciphertextb64] = message.message.split(/:(.*)/s);
						const nonce = base64.decode(nonceb64);
						const chacha = xchacha20poly1305(sharedKey, nonce);
						const ciphertext = base64.decode(ciphertextb64);
						const contentAsBytes = chacha.decrypt(ciphertext);
						content = bytesToUtf8(contentAsBytes);
						messageCache[cacheID] = content;
					}

					message.message = content;
				}
			}

			// $store.loading = 'done';
			// $store.messages = messages;
			// store.set($store);

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
					step: 'Idle',
					invalidAccount: true,
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

	async function sendMessage(text: string) {
		if ($conversation.step === 'Idle') {
			throw new Error(`Idle`);
		}

		// TODO = signMessage(text);
		const signature = '0x';

		// TODO
		const lastMessageReadTimestampMS = Date.now();

		if (!$conversation.otherUser.publicKey) {
			await api.sendMessage(
				{
					type: 'sendMessage',
					messages: [
						// TODO server optimization: unencrypted: only need one message and a list of recipients
						{
							content: text,

							to: $conversation.otherUser.address,
							toPublicKey: ''
						},
						{
							content: text,
							to: $conversation.account.address,
							toPublicKey: ''
						}
					],
					conversationID: $conversation.conversationID,
					messageType: 'clear',
					domain: params.domain,
					namespace: params.namespace,
					signature,
					lastMessageReadTimestampMS
				},
				{
					privateKey: $conversation.account.signer.privateKey
				}
			);
		} else {
			const sharedKey = getSharedKey($conversation.account, $conversation.otherUser.publicKey);

			const nonce = randomBytes(24);
			const chacha = xchacha20poly1305(sharedKey, nonce);

			const data = utf8ToBytes(text);
			const ciphertext = chacha.encrypt(data);

			const encryptedTo = `${base64.encode(nonce)}:${base64.encode(ciphertext)}`;

			const actionSendEncryptedMessage: ActionSendEncryptedMessage = {
				type: 'sendMessage',
				messages: [
					// TODO server optimization: when encrypted vut only 2 person conversation
					//   only need one message and
					{
						content: encryptedTo,

						to: $conversation.otherUser.address,
						toPublicKey: $conversation.otherUser.publicKey
					},
					{
						content: encryptedTo,
						to: $conversation.account.address,
						toPublicKey: $conversation.otherUser.publicKey // TODO self ?
					}
				],
				conversationID: $conversation.conversationID,
				messageType: 'encrypted',
				domain: params.domain,
				namespace: params.namespace,
				signature,
				lastMessageReadTimestampMS
			};

			await api.sendMessage(actionSendEncryptedMessage, {
				privateKey: $conversation.account.signer.privateKey
			});
		}
	}

	return {
		subscribe,
		sendMessage
	};
}
