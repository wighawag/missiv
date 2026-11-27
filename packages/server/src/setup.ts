import {MiddlewareHandler} from 'hono/types';
import {ServerOptions} from './types.js';
import {Env} from './env.js';
import {RemoteSQLStorage} from './storage/RemoteSQLStorage.js';
import {Address, DomainUser, PublicKey} from '@missiv/common';
import {Context} from 'hono';
import {
	DEFAULT_MAX_REQUEST_AGE_MS,
	parseRequestSignature,
	REQUEST_SIGNATURE_HEADER,
	verifyRequestSignature,
} from 'delegated-identity';
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
		/** the Ed25519 signing key that signed the request, when one did */
		publicKey?: PublicKey;
		/** the wallet and domain whose current key set that key signs for, when there is one */
		domainUser?: DomainUser;
		/** the request signature and its timestamp, when the request is signed */
		requestSignature?: {signature: string; timestamp: number};
	}
}

/** The Ed25519 signing key that signed the request; 401 when none did. */
export function requireSigner(c: Context): PublicKey {
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
 * domain (a key a wallet authorized for one site acts in no other).
 */
export function requireAccount(
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
			const {domainUser} = await storage.getDomainUserBySigningKey(checked.publicKey);
			if (domainUser) {
				c.set('domainUser', domainUser);
			}
		}

		return next();
	};
}
