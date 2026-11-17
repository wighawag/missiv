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
	ResponseSendMessage,
	ErrorCode,
	ErrorResponse
} from 'missiv-common';

export type FetchFunction = typeof fetch;

/** A refusal or failure answered by the server: its HTTP status and missiv's error code. */
export class MissivAPIError extends Error {
	constructor(
		readonly status: number,
		readonly code: ErrorCode | string,
		message: string,
		readonly details?: unknown
	) {
		super(message);
		this.name = 'MissivAPIError';
	}
}

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
		if (!resp.ok) {
			const text = await resp.text();
			let error: ErrorResponse['error'] | undefined;
			try {
				error = (JSON.parse(text) as ErrorResponse).error;
			} catch {}
			throw new MissivAPIError(
				resp.status,
				error?.code || 'internal',
				error?.message || text || resp.statusText,
				error?.details
			);
		}
		return (await resp.json()) as T;
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
