import {MiddlewareHandler} from 'hono/types';
import {ServerOptions} from './types.js';
import {Env} from './env.js';
import {RemoteSQLStorage} from './storage/RemoteSQLStorage.js';
import {Address, PublicKey} from 'missiv-common';
import {keccak_256} from '@noble/hashes/sha3';
import {Signature} from '@noble/secp256k1';
import {Context} from 'hono';
import {assert} from 'typia';

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
	const {getDB, getEnv} = options.serverOptions;

	return async (c, next) => {
		const env = getEnv(c);

		const db = getDB(c);
		const storage = new RemoteSQLStorage(db);

		const rawContent = await c.req.text();
		let publicKey: PublicKey | undefined;
		let account: Address | undefined;

		const authentication = c.req.header('SIGNATURE');
		if (authentication) {
			if (authentication.startsWith('FAKE:')) {
				if (!env.DEV) {
					throw new Error(`FAKE authentication only allowed in dev mode`);
				}
				const splitted = authentication.split(':');

				publicKey = assert<PublicKey>(splitted[1].toLowerCase());

				if (!publicKey) {
					throw new Error(`no publicKey provided in FAKE mode`);
				}
			} else {
				const signatureString = authentication;
				const splitted = signatureString.split(':');
				const recoveryBit = Number(splitted[1]);
				const signature = Signature.fromCompact(splitted[0]).addRecoveryBit(recoveryBit);
				const msgHash = keccak_256(rawContent);
				const recoveredPubKey = signature.recoverPublicKey(msgHash);
				publicKey = `0x${recoveredPubKey.toHex().toLowerCase()}` as PublicKey;
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
				account = assert<Address>(domainUser.user);
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
