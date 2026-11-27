import { REQUEST_SIGNATURE_HEADER, signRequest } from 'delegated-identity';
import type {
	ActionAccept,
	ActionEditDomainUser,
	ActionGetDomainUser,
	ActionGetKeySet,
	ActionListConversations,
	ActionListMessages,
	ActionMarkRead,
	ActionOpenSession,
	ActionRegisterDomainUser,
	ActionReject,
	ActionSendMessage,
	ActionUnblock,
	ErrorCode,
	ErrorResponse,
	ResponseAccept,
	ResponseEditDomainUser,
	ResponseGetDomainUser,
	ResponseGetKeySet,
	ResponseListConversations,
	ResponseListMessages,
	ResponseMarkRead,
	ResponseOpenSession,
	ResponseRegisterDomainUser,
	ResponseReject,
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
 * (`APIOptions`): `register` is signed with it (delegated-identity's Ed25519
 * envelope); every other call, `sendMessage` included (whose message carries
 * its own signature), presents a session token
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

	/** A call authenticated by the session of `options`' key in `domain` (by default `action.domain`). */
	async authenticatedCall<T>(
		path: string,
		action: object,
		options: APIOptions,
		domain: string = (action as { domain: string }).domain
	): Promise<T> {
		let opening = this.session(domain, options);
		let session = await opening;
		if (session.expiresAt - SESSION_RENEWAL_MARGIN_MS <= Date.now()) {
			opening = this.session(domain, options, opening);
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
			session = await this.session(domain, options, opening);
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

	/**
	 * Send a message (`composeMessage` / `composeIntroduction`): on the session
	 * of its sender's key, authorized by its own signature. Answers its `seq`; a
	 * retry of the same message (same messageID and signature) answers the same.
	 * Refused `stale` (its `details.serverTime`) when its messageID is too far
	 * from the server's clock: compose it again with a fresh messageID.
	 */
	async sendMessage(action: ActionSendMessage, options: APIOptions) {
		return this.authenticatedCall<ResponseSendMessage>(
			'/messages/send',
			action,
			options,
			action.message.domain
		);
	}

	/** A conversation's messages by seq: `after` what the client has, `before` to page back. */
	async listMessages(action: ActionListMessages, options: APIOptions) {
		return this.authenticatedCall<ResponseListMessages>('/private/listMessages', action, options);
	}

	/** The account's conversations, newest message first, optionally by status. */
	async listConversations(action: ActionListConversations, options: APIOptions) {
		return this.authenticatedCall<ResponseListConversations>(
			'/private/listConversations',
			action,
			options
		);
	}

	async accept(action: ActionAccept, options: APIOptions) {
		return this.authenticatedCall<ResponseAccept>('/private/accept', action, options);
	}

	/** Reject a conversation, which blocks its other member in the domain. */
	async reject(action: ActionReject, options: APIOptions) {
		return this.authenticatedCall<ResponseReject>('/private/reject', action, options);
	}

	/** Let a member you blocked (by rejecting their conversation) reach you again. */
	async unblock(action: ActionUnblock, options: APIOptions) {
		return this.authenticatedCall<ResponseUnblock>('/private/unblock', action, options);
	}

	/** Mark a conversation read up to `seq`. */
	async markRead(action: ActionMarkRead, options: APIOptions) {
		return this.authenticatedCall<ResponseMarkRead>('/private/markRead', action, options);
	}

	/** Drop every table and migrate again; needs the server's ADMIN_TOKEN. */
	async adminReset(adminToken: string) {
		return this.call<{ success: boolean }>('/admin/db-reset', { reset: true }, undefined, {
			Authorization: `Bearer ${adminToken}`
		});
	}
}
