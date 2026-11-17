import { REQUEST_SIGNATURE_HEADER, signRequest } from 'delegated-identity';
import type {
	ActionAcceptConversation,
	ActionEditDomainUser,
	ActionGetAcceptedConversations,
	ActionGetConversations,
	ActionGetDomainUser,
	ActionGetMessages,
	ActionGetUnacceptedConversations,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionRejectConversation,
	ActionSendMessage,
	ActionUnblock,
	ErrorCode,
	ErrorResponse,
	ResponseAcceptConversation,
	ResponseEditDomainUser,
	ResponseGetAcceptedConversations,
	ResponseGetConversations,
	ResponseGetDomainUser,
	ResponseGetMessages,
	ResponseGetUnacceptedConversations,
	ResponseMarkAsRead,
	ResponseRegisterDomainUser,
	ResponseRejectConversation,
	ResponseSendMessage,
	ResponseUnblock
} from '@missiv/common';

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

/** The delegate key that signs a request. */
export type APIOptions = { privateKey: Uint8Array | string };

export { getPublicKey } from '@noble/secp256k1';

/** A delegate private key as delegated-identity takes it: bytes, or 0x-prefixed hex. */
export function toPrivateKey(privateKey: Uint8Array | string): Uint8Array | `0x${string}` {
	if (typeof privateKey !== 'string') {
		return privateKey;
	}
	return (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
}

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

	async call<T>(
		path: string,
		action: unknown,
		options?: APIOptions,
		extraHeaders?: Record<string, string>
	): Promise<T> {
		const headers: { [header: string]: string } = {
			'content-type': 'application/json',
			...extraHeaders
		};
		const body = JSON.stringify(action);
		const url = new URL(this.endpoint + '/api' + path);
		if (options) {
			// delegated-identity's envelope: this server, this route, now, this body
			headers[REQUEST_SIGNATURE_HEADER] = await signRequest(
				{ serverOrigin: url.origin, method: 'POST', path: url.pathname + url.search, body },
				toPrivateKey(options.privateKey)
			);
		}
		const resp = await this.fetchFunction(url.toString(), {
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

	async getDomainUser(action: ActionGetDomainUser) {
		return this.call<ResponseGetDomainUser>('/user/getDomainUser', action);
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

	async acceptConversation(action: ActionAcceptConversation, options: APIOptions) {
		return this.call<ResponseAcceptConversation>('/private/acceptConversation', action, options);
	}

	async rejectConversation(action: ActionRejectConversation, options: APIOptions) {
		return this.call<ResponseRejectConversation>('/private/rejectConversation', action, options);
	}

	/** Let a member you blocked (by rejecting their conversation) reach you again. */
	async unblock(action: ActionUnblock, options: APIOptions) {
		return this.call<ResponseUnblock>('/private/unblock', action, options);
	}

	async markAsRead(action: ActionMarkAsRead, options: APIOptions) {
		return this.call<ResponseMarkAsRead>('/private/markAsRead', action, options);
	}

	async getMessages(action: ActionGetMessages, options: APIOptions) {
		return this.call<ResponseGetMessages>('/private/getMessages', action, options);
	}

	/** Drop every table and migrate again; needs the server's ADMIN_TOKEN. */
	async adminReset(adminToken: string) {
		return this.call<{ success: boolean }>('/admin/db-reset', { reset: true }, undefined, {
			Authorization: `Bearer ${adminToken}`
		});
	}
}
