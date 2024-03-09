import { writable, type Readable } from 'svelte/store';
import { API } from '$lib/API.js';
import type { User, APIConfig } from '$lib/types.js';
import type {
	ConversationState,
	ConversationsState,
	CurrentConversation,
	OtherUser
} from '../types.js';
import { getConversationID, type Address, type ActionSendEncryptedMessage } from 'missiv';
import { getSharedSecret } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { hexToBytes, randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils';
import { base64 } from '@scure/base';

const sharedKeyCache: { [userAndOtherpublicKey: string]: Uint8Array } = {};
const messageCache: { [idTimestamp: string]: string } = {};

function getSharedKey(user: User, otherpublicKey: `0x${string}`): Uint8Array {
	const cacheID = user.address.toLowerCase() + ':' + otherpublicKey;
	let sharedKey = sharedKeyCache[cacheID];
	if (!sharedKey) {
		const sharedSecret = getSharedSecret(user.delegatePrivateKey, otherpublicKey.slice(2));
		sharedKey = keccak_256(sharedSecret);
		sharedKeyCache[cacheID] = sharedKey;
	}

	return sharedKey;
}

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
					const cacheID = message.id + ':' + message.timestamp;
					let content = messageCache[cacheID];
					if (!content) {
						const sharedKey =
							message.recipient.toLowerCase() == user.address.toLowerCase()
								? getSharedKey($store.user, message.senderPublicKey)
								: getSharedKey($store.user, message.recipientPublicKey);

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
			await api.sendMessage(
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
			const sharedKey = getSharedKey($store.user, $store.otherUser.publicKey);

			const nonce = randomBytes(24);
			const chacha = xchacha20poly1305(sharedKey, nonce);

			const data = utf8ToBytes(text);
			const ciphertext = chacha.encrypt(data);

			const actionSendEncryptedMessage: ActionSendEncryptedMessage = {
				type: 'sendMessage',
				domain: config.domain,
				namespace: config.namespace,
				signature: '0x', //TODO
				message: `${base64.encode(nonce)}:${base64.encode(ciphertext)}`,
				to: $store.otherUser.address,
				messageType: 'encrypted',
				toPublicKey: $store.otherUser.publicKey
			};

			await api.sendMessage(actionSendEncryptedMessage, {
				privateKey: $store.user.delegatePrivateKey
			});
		}
	}

	return {
		subscribe: store.subscribe,
		sendMessage
	};
}
