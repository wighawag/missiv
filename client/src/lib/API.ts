import type {
	Action,
	ActionAcceptConversation,
	ActionGetAcceptedConversations,
	ActionGetConversations,
	ActionGetMessages,
	ActionGetUnacceptedConversations,
	ActionGetMissivUser,
	ActionRegisterDomainUser,
	ActionSendMessage,
	ResponseAcceptConversation,
	ResponseGetAcceptedConversations,
	ResponseGetConversations,
	ResponseGetMessages,
	ResponseGetUnacceptedConversations,
	ResponseGetMissivUser,
	ResponseRegisterDomainUser,
	ResponseSendMessage,
	ActionGetDomainUser,
	ResponseGetDomainUser,
	ActionSendMessageInClear,
	ActionSendEncryptedMessage
} from 'missiv';
import { signAsync, utils as secpUtils, getSharedSecret } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { randomBytes, bytesToHex } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils';
import { base64 } from '@scure/base';

export type FetchFunction = typeof fetch;

export type APIOptions =
	| { signature: string }
	| { publicKey: string }
	| { privateKey: Uint8Array | string };

export { getPublicKey } from '@noble/secp256k1';

export class API {
	protected fetchFunction: FetchFunction;

	constructor(
		private endpoint: string,
		options?: {
			fetch: FetchFunction;
		}
	) {
		this.fetchFunction = options?.fetch || fetch;
	}

	async call<T>(action: Action, options?: APIOptions): Promise<T> {
		const headers: { [header: string]: string } = {
			'content-type': 'application/json'
		};
		const body = JSON.stringify(action);
		if (options) {
			if ('privateKey' in options) {
				const signature = await signAsync(keccak_256(body), options.privateKey); // Sync methods below
				headers.SIGNATURE = `${signature.toCompactHex()}:${signature.recovery}`;
			} else {
				headers.SIGNATURE =
					'signature' in options ? options.signature : `FAKE:${options.publicKey}`;
			}
		}
		const resp = await this.fetchFunction(this.endpoint, {
			method: 'POST',
			body,
			headers
		});
		if (resp.status !== 200) {
			throw new Error(await resp.text());
		}
		if (resp) {
			return (await resp.json()) as T;
		} else {
			throw new Error(`no response`);
		}
	}

	async register(action: Omit<ActionRegisterDomainUser, 'type'>, options: APIOptions) {
		return this.call<ResponseRegisterDomainUser>(
			{
				type: 'register',
				...action
			},
			options
		);
	}

	async sendMessageInClear(action: Omit<ActionSendMessageInClear, 'type'>, options: APIOptions) {
		return this.call<ResponseSendMessage>(
			{
				type: 'sendMessage',
				...action
			},
			options
		);
	}

	async sendEncryptedMessage(
		action: Omit<ActionSendMessageInClear & { toPublicKey: `0x${string}` }, 'type' | 'messageType'>,
		options: { privateKey: Uint8Array | string }
	) {
		const actionSendEncryptedMessage: ActionSendEncryptedMessage = {
			type: 'sendMessage',
			...action,
			messageType: 'encrypted'
		};

		const sharedKey = getSharedSecret(options.privateKey, action.toPublicKey.slice(2));
		const sharedSecret = keccak_256(sharedKey);

		const nonce = randomBytes(24);
		const chacha = xchacha20poly1305(sharedSecret, nonce);

		const data = utf8ToBytes(action.message);
		const ciphertext = chacha.encrypt(data);
		actionSendEncryptedMessage.message = `${base64.encode(nonce)}:${base64.encode(ciphertext)}`;

		return this.call<ResponseSendMessage>(actionSendEncryptedMessage, options);
	}

	async sendMessage(action: Omit<ActionSendMessage, 'type'>, options: APIOptions) {
		return this.call<ResponseSendMessage>(
			{
				type: 'sendMessage',
				...action
			},
			options
		);
	}

	async getConversations(action: Omit<ActionGetConversations, 'type'>, options: APIOptions) {
		return this.call<ResponseGetConversations>(
			{
				type: 'getConversations',
				...action
			},
			options
		);
	}

	async getAcceptedConversations(
		action: Omit<ActionGetAcceptedConversations, 'type'>,
		options: APIOptions
	) {
		return this.call<ResponseGetAcceptedConversations>(
			{
				type: 'getAcceptedConversations',
				...action
			},
			options
		);
	}

	async getUnacceptedConversations(
		action: Omit<ActionGetUnacceptedConversations, 'type'>,
		options: APIOptions
	) {
		return this.call<ResponseGetUnacceptedConversations>(
			{
				type: 'getUnacceptedConversations',
				...action
			},
			options
		);
	}
	async acceptConversation(
		conversation: Omit<ActionAcceptConversation, 'type'>,
		options: APIOptions
	) {
		return this.call<ResponseAcceptConversation>(
			{
				type: 'acceptConversation',
				...conversation
			},
			options
		);
	}

	async getMessages(chat: Omit<ActionGetMessages, 'type'>, options: APIOptions) {
		return this.call<ResponseGetMessages>(
			{
				type: 'getMessages',
				...chat
			},
			options
		);
	}

	async getUser(action: Omit<ActionGetMissivUser, 'type'>) {
		return this.call<ResponseGetMissivUser>({
			type: 'getUser',
			...action
		});
	}

	async getDomainUser(action: Omit<ActionGetDomainUser, 'type'>) {
		return this.call<ResponseGetDomainUser>({
			type: 'getDomainUser',
			...action
		});
	}

	async clear() {
		return this.call<ResponseAcceptConversation>({
			type: 'db:reset'
		});
	}
}
