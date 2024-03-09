import { writable, type Readable } from 'svelte/store';
import { API } from '$lib/API.js';
import type { User, APIConfig } from '$lib/types.js';
import type {
	ConversationState,
	ConversationsState,
	CurrentConversation,
	OtherUser
} from '../types.js';
import { getConversationID, type Address } from 'missiv';
import { getSharedSecret } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hexToBytes, randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils';
import { base64 } from '@scure/base';

// TODO remove: markAsAcceptedAndRead
//   once we handle accepted/naccepted conversation in the UI we do it automatically here
export function openOneConversation(
	config: APIConfig,
	user: User,
	otherUser: OtherUser,
	conversationsStore: Readable<ConversationsState>,
	markAsAcceptedAndRead?: boolean
): CurrentConversation {
	const conversationID = getConversationID(user.address, otherUser.address);

	function defaultState(): ConversationState {
		return {
			conversationID,
			loading: 'idle',
			user,
			otherUser,
			invalidUser: false,
			messages: undefined
		};
	}

	const pollingInterval = config.pollingInterval || 2;
	const api = new API(config.endpoint);
	let $store: ConversationState = defaultState();

	let timeout: 'first' | NodeJS.Timeout | undefined;
	async function fetchMessages() {
		if ($store.user) {
			if (!$store.otherUser.publicKey) {
				const { domainUser } = await api.getDomainUser({
					address: otherUser.address,
					domain: config.domain
				});
				if (domainUser?.publicKey) {
					$store.otherUser.publicKey = domainUser.publicKey;
					$store.otherUser.name = domainUser.domainUsername || domainUser.name;
				}
			}
			const { messages } = await api.getMessages(
				{
					domain: config.domain,
					namespace: config.namespace,
					conversationID
				},
				{
					privateKey: user.delegatePrivateKey
				}
			);

			for (let i = 0; i < messages.length; i++) {
				const message = messages[i];
				if (message.type === 'encrypted') {
					const sharedKey =
						message.recipient.toLowerCase() == user.address.toLowerCase()
							? getSharedSecret(user.delegatePrivateKey, message.senderPublicKey.slice(2))
							: getSharedSecret(user.delegatePrivateKey, message.recipientPublicKey.slice(2));
					const sharedSecret = keccak_256(sharedKey);

					const [nonceb64, ciphertextb64] = message.message.split(/:(.*)/s);
					const nonce = base64.decode(nonceb64);
					const chacha = xchacha20poly1305(sharedSecret, nonce);
					const ciphertext = base64.decode(ciphertextb64);
					const content = chacha.decrypt(ciphertext);
					message.message = bytesToUtf8(content);
				}
			}

			$store.loading = 'done';
			$store.messages = messages;
			store.set($store);

			if (markAsAcceptedAndRead) {
				api.acceptConversation(
					{
						domain: config.domain,
						namespace: config.namespace,
						conversationID
					},
					{
						privateKey: user.delegatePrivateKey
					}
				);
			}
		}
	}

	async function fetchMessagesgainAndAgain() {
		await fetchMessages();
		if (timeout) {
			timeout = setTimeout(fetchMessagesgainAndAgain, pollingInterval * 1000);
		} // else we stop as we cleared the timeout
	}

	const store = writable<ConversationState>($store, () => {
		const unsubscribeFromConversationsState = conversationsStore.subscribe(
			onConversationsStateUpdated
		);
		timeout = 'first';
		fetchMessagesgainAndAgain();
		return () => {
			unsubscribeFromConversationsState();
			if (timeout && timeout != 'first') {
				clearTimeout(timeout);
			}
		};
	});

	function onConversationsStateUpdated(newState: ConversationsState) {
		if (newState.currentUser) {
			if (newState.currentUser.address == user.address) {
				$store.invalidUser = false;
				store.set($store);
				fetchMessages();
			} else {
				$store.invalidUser = true;
				store.set($store);
			}
		}
	}

	async function sendMessage(text: string) {
		if (!$store.user) {
			throw new Error(`no user setup`);
		}

		if ($store.invalidUser) {
			throw new Error(`invalid user`);
		}

		if (!$store.otherUser.publicKey) {
			await api.sendMessageInClear(
				{
					message: text,
					messageType: 'clear',
					domain: config.domain,
					namespace: config.namespace,
					signature: '0x',
					to: $store.otherUser.address
				},
				{
					privateKey: $store.user.delegatePrivateKey
				}
			);
		} else {
			await api.sendEncryptedMessage(
				{
					message: text,
					domain: config.domain,
					namespace: config.namespace,
					signature: '0x',
					to: $store.otherUser.address,
					toPublicKey: $store.otherUser.publicKey
				},
				{
					privateKey: $store.user.delegatePrivateKey
				}
			);
		}
	}

	return {
		subscribe: store.subscribe,
		sendMessage
	};
}
