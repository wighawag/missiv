import { REQUEST_SIGNATURE_HEADER, signRequest } from 'delegated-identity';
import type {
	ActionAcceptConversation,
	ActionEditDomainUser,
	ActionGetAcceptedConversations,
	ActionGetConversations,
	ActionGetDomainUser,
	ActionGetKeySet,
	ActionGetMessages,
	ActionGetUnacceptedConversations,
	ActionMarkAsRead,
	ActionOpenSession,
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
	ResponseGetKeySet,
	ResponseGetMessages,
	ResponseGetUnacceptedConversations,
	ResponseMarkAsRead,
	ResponseOpenSession,
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

/** The key that signs a request: the Ed25519 signing private key of the account's key set. */
export type APIOptions = { privateKey: Uint8Array | string };

/** A private key as delegated-identity takes it: bytes, or 0x-prefixed hex. */
export function toPrivateKey(privateKey: Uint8Array | string): Uint8Array | `0x${string}` {
	if (typeof privateKey !== 'string') {
		return privateKey;
	}
	return (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
}

/**
 * How long before its expiry a session is renewed: a call made later opens a new
 * session first, so a token is never presented in its last minutes (a slow
 * request, or a client clock a little behind the server's, would otherwise
 * arrive with an expired one).
 */
export const SESSION_RENEWAL_MARGIN_MS = 5 * 60 * 1000;

/**
 * The typed HTTP API. A call that needs an account takes its signing key
 * (`APIOptions`): `register` and `sendMessage` are signed with it (delegated-
 * identity's Ed25519 envelope); every other call presents a session token
 * (ADR-0006), which this API opens with one signed `POST /api/session` per
 * domain and key, reuses, renews before it expires, and opens again once when
 * the server refuses it (`unauthenticated`: a rotated secret, a replaced key set).
 */
export class API {
	protected fetchFunction: FetchFunction;
	/** the session of each (domain, signing key), or the opening in flight */
	private sessions = new Map<string, Promise<ResponseOpenSession>>();

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
			// delegated-identity's Ed25519 envelope: this server, this route, now, this body
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

	/** Open a session in `action.domain` with one signed request; most callers let the API do it. */
	async openSession(action: ActionOpenSession, options: APIOptions) {
		try {
			return await this.call<ResponseOpenSession>('/session', action, options);
		} catch (err) {
			// delegated-identity's signatures are deterministic: two openings by the
			// same key in the same millisecond are the same request, and the server
			// refuses the second as a replay. A millisecond later it is another one.
			if (err instanceof MissivAPIError && err.code === 'conflict') {
				await new Promise((resolve) => setTimeout(resolve, 2));
				return this.call<ResponseOpenSession>('/session', action, options);
			}
			throw err;
		}
	}

	private session(domain: string, options: APIOptions, renew?: Promise<ResponseOpenSession>) {
		const key = `${domain}\n${typeof options.privateKey === 'string' ? options.privateKey.toLowerCase() : Array.from(options.privateKey).join(',')}`;
		const current = this.sessions.get(key);
		if (current && current !== renew) {
			return current;
		}
		const opening = this.openSession({ domain }, options);
		this.sessions.set(key, opening);
		opening.catch(() => {
			if (this.sessions.get(key) === opening) {
				this.sessions.delete(key);
			}
		});
		return opening;
	}

	/** A call authenticated by the session of `options`' key in `action.domain`. */
	async authenticatedCall<T>(
		path: string,
		action: { domain: string },
		options: APIOptions
	): Promise<T> {
		let opening = this.session(action.domain, options);
		let session = await opening;
		if (session.expiresAt - SESSION_RENEWAL_MARGIN_MS <= Date.now()) {
			opening = this.session(action.domain, options, opening);
			session = await opening;
		}
		try {
			return await this.call<T>(path, action, undefined, {
				Authorization: `Bearer ${session.token}`
			});
		} catch (err) {
			if (!(err instanceof MissivAPIError && err.code === 'unauthenticated')) {
				throw err;
			}
			// once: a token refused twice is not a stale session
			session = await this.session(action.domain, options, opening);
			return this.call<T>(path, action, undefined, { Authorization: `Bearer ${session.token}` });
		}
	}

	async register(action: ActionRegisterDomainUser, options: APIOptions) {
		return this.call<ResponseRegisterDomainUser>('/user/register', action, options);
	}

	async editUser(action: ActionEditDomainUser, options: APIOptions) {
		return this.authenticatedCall<ResponseEditDomainUser>('/user/editUser', action, options);
	}

	async getDomainUser(action: ActionGetDomainUser) {
		return this.call<ResponseGetDomainUser>('/user/getDomainUser', action);
	}

	/** A key set registered in a domain, current or replaced, by its reference (`keySetRef`). */
	async getKeySet(action: ActionGetKeySet) {
		return this.call<ResponseGetKeySet>('/user/getKeySet', action);
	}

	async sendMessage(action: ActionSendMessage, options: APIOptions) {
		return this.call<ResponseSendMessage>('/private/sendMessage', action, options);
	}

	async getConversations(action: ActionGetConversations, options: APIOptions) {
		return this.authenticatedCall<ResponseGetConversations>(
			'/private/getConversations',
			action,
			options
		);
	}

	async getAcceptedConversations(action: ActionGetAcceptedConversations, options: APIOptions) {
		return this.authenticatedCall<ResponseGetAcceptedConversations>(
			'/private/getAcceptedConversations',
			action,
			options
		);
	}

	async getUnacceptedConversations(action: ActionGetUnacceptedConversations, options: APIOptions) {
		return this.authenticatedCall<ResponseGetUnacceptedConversations>(
			'/private/getUnacceptedConversations',
			action,
			options
		);
	}

	async acceptConversation(action: ActionAcceptConversation, options: APIOptions) {
		return this.authenticatedCall<ResponseAcceptConversation>(
			'/private/acceptConversation',
			action,
			options
		);
	}

	async rejectConversation(action: ActionRejectConversation, options: APIOptions) {
		return this.authenticatedCall<ResponseRejectConversation>(
			'/private/rejectConversation',
			action,
			options
		);
	}

	/** Let a member you blocked (by rejecting their conversation) reach you again. */
	async unblock(action: ActionUnblock, options: APIOptions) {
		return this.authenticatedCall<ResponseUnblock>('/private/unblock', action, options);
	}

	async markAsRead(action: ActionMarkAsRead, options: APIOptions) {
		return this.authenticatedCall<ResponseMarkAsRead>('/private/markAsRead', action, options);
	}

	async getMessages(action: ActionGetMessages, options: APIOptions) {
		return this.authenticatedCall<ResponseGetMessages>('/private/getMessages', action, options);
	}

	/** Drop every table and migrate again; needs the server's ADMIN_TOKEN. */
	async adminReset(adminToken: string) {
		return this.call<{ success: boolean }>('/admin/db-reset', { reset: true }, undefined, {
			Authorization: `Bearer ${adminToken}`
		});
	}
}
