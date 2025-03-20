import {MiddlewareHandler} from 'hono/types';
import {AddressSchema, PublicKeySchema, ServerOptions} from './types.js';
import {Env} from './env.js';
import {RemoteSQLStorage} from './storage/RemoteSQLStorage.js';
import {Address, PublicKey} from 'missiv-common';
import {Context} from 'hono';
import {recoverPublicKey} from './utils/signature.js';

// used to be hono Bindings but its type is now `object` which break compilation here
type Bindings = Record<string, any>;

export type SetupOptions<Env extends Bindings = Record<string, any>> = {
	serverOptions: ServerOptions<Env>;
};

export type Config = {
	storage: RemoteSQLStorage;
	env: Env;
};

declare module 'hono' {
	interface ContextVariableMap {
		config: Config;
		account?: Address;
		publicKey?: PublicKey;
	}
}

export const getAuth = (c: Context) => {
	return {account: c.get('account'), publicKey: c.get('publicKey')};
};

export function setup<Env extends Bindings = Bindings>(options: SetupOptions<Env>): MiddlewareHandler {
	const {services, getEnv} = options.serverOptions;
	const {getDB} = services;

	return async (c, next) => {
		const env = getEnv(c);

		const db = getDB(env);
		const storage = new RemoteSQLStorage(db);

		const rawContent = await c.req.text();
		let publicKey: PublicKey | undefined;
		let account: Address | undefined;

		const authentication = c.req.header('SIGNATURE');
		if (authentication) {
			if (authentication.startsWith('FAKE:')) {
				if (!env.DEV) {
					const message = `FAKE authentication only allowed in dev mode`;
					console.error(message);
					throw new Error(message);
				}
				const splitted = authentication.split(':');

				publicKey = PublicKeySchema.parse(splitted[1].toLowerCase());

				if (!publicKey) {
					throw new Error(`no publicKey provided in FAKE mode`);
				}
			} else {
				publicKey = recoverPublicKey(authentication, rawContent);
			}

			const {domainUser} = await storage.getDomainUserByPublicKey(publicKey);

			// TODO
			// if (domainUser) {
			// 	if ('domain' in action) {
			// 		if (domainUser.domain != action.domain) {
			// 			throw new Error(`the publicKey belongs to domain "${domainUser.domain}" and not "${action.domain}"`);
			// 		}
			// 	}

			if (domainUser) {
				account = AddressSchema.parse(domainUser.user);
			}
		}

		if (account) {
			c.set('account', account);
		}

		if (publicKey) {
			c.set('publicKey', publicKey);
		}

		c.set('config', {
			storage,
			env,
		});

		// auto setup
		if (c.req.query('_initDB') == 'true') {
			await storage.setup();
		}

		return next();
	};
}
