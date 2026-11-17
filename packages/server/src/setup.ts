import {MiddlewareHandler} from 'hono/types';
import {ServerOptions} from './types.js';
import {Env} from './env.js';
import {RemoteSQLStorage} from './storage/RemoteSQLStorage.js';
import {Address, DomainUser, PublicKey} from 'missiv-common';
import {Context} from 'hono';
import {recoverPublicKey} from './utils/signature.js';
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

export function setup<CustomEnv extends Env>(options: SetupOptions<CustomEnv>): MiddlewareHandler {
	const {services, getEnv} = options.serverOptions;
	const {getDB} = services;

	return async (c, next) => {
		const env = getEnv(c);
		const storage = new RemoteSQLStorage(getDB(env));
		c.set('config', {storage, env});

		const authentication = c.req.header('SIGNATURE');
		if (authentication) {
			let publicKey: PublicKey;
			try {
				publicKey = recoverPublicKey(authentication, await c.req.text());
			} catch {
				throw new MissivError('unauthenticated', 'malformed request signature');
			}
			c.set('publicKey', publicKey);
			const {domainUser} = await storage.getDomainUserByPublicKey(publicKey);
			if (domainUser) {
				c.set('domainUser', domainUser);
			}
		}

		return next();
	};
}
