import {MiddlewareHandler} from 'hono/types';
import {ServerOptions} from './types.js';
import {Env} from './env.js';
import {RemoteSQLStorage} from './storage/RemoteSQLStorage.js';
import {Address, DomainUser, PublicKey} from 'missiv-common';
import {Context} from 'hono';
import {DEFAULT_MAX_REQUEST_AGE_MS, recoverRequestSigner, REQUEST_SIGNATURE_HEADER} from 'delegated-identity';
import {MissivError} from './errors.js';

export type SetupOptions<CustomEnv extends Env = Record<string, any>> = {
	serverOptions: ServerOptions<CustomEnv>;
};

export type Config = {
	storage: RemoteSQLStorage;
	env: Env;
};

declare module 'hono' {
	interface ContextVariableMap {
		config: Config;
		/** the key that signed the request, when one did */
		publicKey?: PublicKey;
		/** the wallet and domain that key is registered for, when it is */
		domainUser?: DomainUser;
		/** the request signature and its timestamp, when the request is signed */
		requestSignature?: {signature: string; timestamp: number};
	}
}

/** The key that signed the request; 401 when none did. */
export function requireSigner(c: Context): PublicKey {
	const publicKey = c.get('publicKey');
	if (!publicKey) {
		throw new MissivError('unauthenticated', 'the request is not signed');
	}
	return publicKey;
}

/**
 * The account of the key that signed the request, which must be registered for
 * `domain`: 401 when the key is registered nowhere, 403 when it is registered
 * for another domain (a key a wallet authorized for one site acts in no other).
 */
export function requireAccount(c: Context, domain: string): {account: Address; publicKey: PublicKey} {
	const publicKey = requireSigner(c);
	const domainUser = c.get('domainUser');
	if (!domainUser) {
		throw new MissivError('unauthenticated', 'the key that signed this request is not registered');
	}
	if (domainUser.domain !== domain) {
		throw new MissivError('forbidden', `the key that signed this request is registered for another domain`);
	}
	return {account: domainUser.user, publicKey};
}

/**
 * Refuse a request whose signature was already accepted: for the routes that must
 * not run twice (a replayed send would store the message again). The signature is
 * kept until its time window has passed; delegated-identity keeps no such store.
 */
export async function refuseReplay(c: Context): Promise<void> {
	const requestSignature = c.get('requestSignature');
	if (!requestSignature) {
		throw new MissivError('unauthenticated', 'the request is not signed');
	}
	const accepted = await c
		.get('config')
		.storage.acceptRequestSignature(
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
	const {getDB} = services;

	return async (c, next) => {
		const env = getEnv(c);
		const storage = new RemoteSQLStorage(getDB(env));
		c.set('config', {storage, env});

		const signature = c.req.header(REQUEST_SIGNATURE_HEADER);
		if (signature) {
			const url = new URL(c.req.url);
			const recovered = recoverRequestSigner({
				serverOrigin: env.SERVER_ORIGIN || url.origin,
				method: c.req.method,
				path: url.pathname + url.search,
				body: await c.req.text(),
				signature,
			});
			if (!recovered.ok) {
				throw new MissivError(
					'unauthenticated',
					recovered.reason === 'expired'
						? 'the request signature is outside its time window'
						: 'malformed request signature',
				);
			}
			c.set('publicKey', recovered.publicKey);
			c.set('requestSignature', {signature, timestamp: recovered.timestamp});
			const {domainUser} = await storage.getDomainUserByPublicKey(recovered.publicKey);
			if (domainUser) {
				c.set('domainUser', domainUser);
			}
		}

		return next();
	};
}
