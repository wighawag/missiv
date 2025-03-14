import { signAsync } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import type {
	ActionAcceptConversation,
	ActionEditDomainUser,
	ActionGetAcceptedConversations,
	ActionGetCompleteUser,
	ActionGetConversations,
	ActionGetMessages,
	ActionGetMissivUser,
	ActionGetUnacceptedConversations,
	ActionRegisterDomainUser,
	ActionRejectConversation,
	ActionSendMessage,
	ResponseRejectConversation,
	ResponseAcceptConversation,
	ResponseEditDomainUser,
	ResponseGetAcceptedConversations,
	ResponseGetCompleteUser,
	ResponseGetConversations,
	ResponseGetMessages,
	ResponseGetMissivUser,
	ResponseGetUnacceptedConversations,
	ResponseRegisterDomainUser,
	ResponseSendMessage
} from 'missiv-common';

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
		this.fetchFunction =
			options?.fetch || (typeof window !== 'undefined' ? window.fetch.bind(window) : fetch);
	}

	async call<T>(path: string, action: any, options?: APIOptions): Promise<T> {
		const headers: { [header: string]: string } = {
			'content-type': 'application/json'
		};
		const body = JSON.stringify(action);
		if (options) {
			if ('privateKey' in options) {
				const privateKey =
					typeof options.privateKey == 'string' && options.privateKey.startsWith('0x')
						? options.privateKey.slice(2)
						: options.privateKey;

				const signature = await signAsync(keccak_256(body), privateKey); // Sync methods below
				headers.SIGNATURE = `${signature.toCompactHex()}:${signature.recovery}`;
			} else {
				headers.SIGNATURE =
					'signature' in options ? options.signature : `FAKE:${options.publicKey}`;
			}
		}
		const url = this.endpoint + '/api' + path;
		// console.log({ url });
		const resp = await this.fetchFunction(url, {
			method: 'POST',
			body,
			headers
		});
		if (resp.status !== 200 && resp.status !== 201) {
			const text = await resp.text();
			console.error(`failed`, text);
			throw new Error(text);
		}

		if (resp) {
			const json = (await resp.json()) as T;
			// console.log({ json });
			return json;
		} else {
			console.error(`failed with no response`);
			throw new Error(`no response`);
		}
	}

	async register(action: ActionRegisterDomainUser, options: APIOptions) {
		return this.call<ResponseRegisterDomainUser>('/user/register', action, options);
	}

	async editUser(action: ActionEditDomainUser, options: APIOptions) {
		return this.call<ResponseEditDomainUser>('/user/editUser', action, options);
	}

	async sendMessage(action: ActionSendMessage, options: APIOptions) {
		return this.call<ResponseSendMessage>('/private/sendMessage', action, options);
	}

	async getConversations(action: ActionGetConversations, options: APIOptions) {
		return this.call<ResponseGetConversations>('/private/getConversations', action, options);
	}

	async getAcceptedConversations(action: ActionGetAcceptedConversations, options: APIOptions) {
		return this.call<ResponseGetAcceptedConversations>(
			'/private/getAcceptedConversations',
			action,
			options
		);
	}

	async getUnacceptedConversations(action: ActionGetUnacceptedConversations, options: APIOptions) {
		return this.call<ResponseGetUnacceptedConversations>(
			'/private/getUnacceptedConversations',
			action,
			options
		);
	}
	async acceptConversation(conversation: ActionAcceptConversation, options: APIOptions) {
		return this.call<ResponseAcceptConversation>(
			'/private/acceptConversation',
			conversation,
			options
		);
	}

	async rejectConversation(conversation: ActionRejectConversation, options: APIOptions) {
		return this.call<ResponseRejectConversation>(
			'/private/rejectConversation',
			conversation,
			options
		);
	}

	async getMessages(chat: ActionGetMessages, options: APIOptions) {
		return this.call<ResponseGetMessages>('/private/getMessages', chat, options);
	}

	async getUser(action: ActionGetMissivUser) {
		return this.call<ResponseGetMissivUser>('/user/getUser', action);
	}

	async getCompleteUser(action: ActionGetCompleteUser) {
		return this.call<ResponseGetCompleteUser>('/user/getCompleteUser', action);
	}

	async clear() {
		return this.call<{ success: boolean }>('/admin/db-reset', { reset: true });
	}
}
