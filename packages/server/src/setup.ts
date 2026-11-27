import {MiddlewareHandler} from 'hono/types';
import {ServerOptions} from './types.js';
import {Env} from './env.js';
import {createSQLStores} from './stores/sql/index.js';
import type {Stores} from './stores/ports.js';
import {Address, DomainUser, PublicKey, String0x} from '@missiv/common';
import {Context} from 'hono';
import {
	DEFAULT_MAX_REQUEST_AGE_MS,
	parseRequestSignature,
	REQUEST_SIGNATURE_HEADER,
	verifyRequestSignature,
} from 'delegated-identity';
import {MissivError} from './errors.js';
import {verifySessionToken, type SessionClaims, type SessionRefusal} from './session.js';

export type SetupOptions<CustomEnv extends Env = Record<string, any>> = {
	serverOptions: ServerOptions<CustomEnv>;
};

export type Config = {
	/** the KeyDirectory, ConversationStore and Inbox of this request (ADR-0005) */
	stores: Stores;
	env: Env;
};

declare module 'hono' {
	interface ContextVariableMap {
		config: Config;
		/** the Ed25519 signing key that signed the request, when one did */
		publicKey?: PublicKey;
		/** the wallet and domain whose current key set that key signs for, when there is one */
		domainUser?: DomainUser;
		/** the request signature and its timestamp, when the request is signed */
		requestSignature?: {signature: string; timestamp: number};
		/** the claims of the request's session token, when it presents one the server accepts */
		session?: SessionClaims;
		/** why the request's session token was not accepted, when it presents one */
		sessionRefusal?: SessionRefusal;
	}
}

/**
 * The secrets a session token may be signed with: `SESSION_SECRET`, then
 * `SESSION_SECRET_PREVIOUS` while a rotation lets old tokens run out. Every
 * route that authenticates its caller (a session, a registration, a send, any
 * route taking a token) is refused while `SESSION_SECRET` is unset, as the admin
 * API is without `ADMIN_TOKEN`: a misconfigured server says so on the first
 * call instead of accepting only some of them.
 */
export function sessionSecrets(env: Env): string[] {
	if (!env.SESSION_SECRET) {
		throw new MissivError('forbidden', 'authenticated routes are disabled (no SESSION_SECRET)');
	}
	return env.SESSION_SECRET_PREVIOUS ? [env.SESSION_SECRET, env.SESSION_SECRET_PREVIOUS] : [env.SESSION_SECRET];
}

/** The Ed25519 signing key that signed the request; 401 when none did. */
export function requireSigner(c: Context): PublicKey {
	sessionSecrets(c.get('config').env);
	const publicKey = c.get('publicKey');
	if (!publicKey) {
		throw new MissivError('unauthenticated', 'the request is not signed');
	}
	return publicKey;
}

/**
 * The account of the key that signed the request, which must be the signing key
 * of its current key set in `domain`: 401 when the key is the current one of no
 * account (unregistered, or replaced), 403 when it is registered for another
 * domain (a key a wallet authorized for one site acts in no other). For the
 * routes a request signature authenticates: opening a session, and `sendMessage`
 * until the message signature replaces it (ADR-0004 decision 4).
 */
export function requireSignedAccount(
	c: Context,
	domain: string,
): {account: Address; publicKey: PublicKey; domainUser: DomainUser} {
	const publicKey = requireSigner(c);
	const domainUser = c.get('domainUser');
	if (!domainUser) {
		throw new MissivError('unauthenticated', 'the key that signed this request is not registered');
	}
	if (domainUser.domain !== domain) {
		throw new MissivError('forbidden', `the key that signed this request is registered for another domain`);
	}
	return {account: domainUser.user, publicKey, domainUser};
}

/**
 * The account of the request's session token, which must be for `domain`: 401
 * (`unauthenticated`) when the request presents no token, an invalid or expired
 * one, or one for another domain, so the client opens a new session. A request
 * signature is no authentication here; the token's check reads nothing.
 */
export function requireAccount(c: Context, domain: string): {account: Address; keyRef: String0x} {
	sessionSecrets(c.get('config').env);
	const session = c.get('session');
	if (!session) {
		const refusal = c.get('sessionRefusal');
		throw new MissivError(
			'unauthenticated',
			refusal === 'expired'
				? 'the session token has expired'
				: refusal
					? 'the session token is not valid'
					: 'a session token is required',
		);
	}
	if (session.domain !== domain) {
		throw new MissivError('unauthenticated', 'the session token is for another domain');
	}
	return {account: session.account, keyRef: session.keyRef};
}

/**
 * Refuse a request whose signature was already accepted: for the routes that must
 * not run twice (a replayed session request would hand out a second token, a
 * replayed registration could make a replaced key set current again). A send
 * needs none: its messageID is its replay guard (ADR-0006). The signature is kept until its time
 * window has passed; delegated-identity keeps no such store.
 */
export async function refuseReplay(c: Context): Promise<void> {
	const requestSignature = c.get('requestSignature');
	if (!requestSignature) {
		throw new MissivError('unauthenticated', 'the request is not signed');
	}
	const accepted = await c
		.get('config')
		.stores.keys.acceptRequestSignature(
			requestSignature.signature,
			requestSignature.timestamp + DEFAULT_MAX_REQUEST_AGE_MS,
			Date.now(),
		);
	if (!accepted) {
		throw new MissivError('conflict', 'this signed request was already accepted');
	}
}

export function setup<CustomEnv extends Env>(options: SetupOptions<CustomEnv>): MiddlewareHandler {
	const {services, getEnv} = options.serverOptions;
	const {getDB, getStores} = services;

	return async (c, next) => {
		const env = getEnv(c);
		const stores = getStores ? getStores(env) : createSQLStores(getDB(env));
		c.set('config', {stores, env});

		// a session token: an HMAC and a comparison, nothing read. A route that needs
		// it refuses the request (`requireAccount`); one that does not ignores it
		// (the admin API's bearer token is not a session token).
		const authorization = c.req.header('Authorization');
		if (authorization?.startsWith('Bearer ') && env.SESSION_SECRET) {
			const checked = verifySessionToken(authorization.slice(7), sessionSecrets(env), Date.now());
			if (checked.ok) {
				c.set('session', checked.claims);
			} else {
				c.set('sessionRefusal', checked.reason);
			}
		}

		const signature = c.req.header(REQUEST_SIGNATURE_HEADER);
		if (signature) {
			// delegated-identity's Ed25519 envelope: the header names its key (Ed25519
			// has no recovery), which signs this request or the request is refused
			const parsed = parseRequestSignature(signature);
			if (!parsed) {
				throw new MissivError('unauthenticated', 'malformed request signature');
			}
			const url = new URL(c.req.url);
			const checked = await verifyRequestSignature({
				serverOrigin: env.SERVER_ORIGIN || url.origin,
				method: c.req.method,
				path: url.pathname + url.search,
				body: await c.req.text(),
				signature,
				publicKey: parsed.publicKey,
			});
			if (!checked.ok) {
				throw new MissivError(
					'unauthenticated',
					checked.reason === 'expired'
						? 'the request signature is outside its time window'
						: 'the request signature does not verify for this request',
				);
			}
			c.set('publicKey', checked.publicKey);
			c.set('requestSignature', {signature, timestamp: checked.timestamp});
			const {domainUser} = await stores.keys.getDomainUserBySigningKey(checked.publicKey);
			if (domainUser) {
				c.set('domainUser', domainUser);
			}
		}

		return next();
	};
}
