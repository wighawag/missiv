import type {Context, MiddlewareHandler} from 'hono';
import {ServerOptions} from '../types.js';
import {RemoteSQLStorage} from '../storage/RemoteSQLStorage.js';
import {Signature} from '@noble/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {Bindings} from 'hono/types';
import {Address, PublicKey} from 'missiv-common';

export type ETHAuthOptions<Env extends Bindings = Bindings> = {
	serverOptions: ServerOptions<Env>;
};

declare module 'hono' {
	interface ContextVariableMap {
		account?: Address;
		publicKey?: PublicKey;
	}
}

export const getAuth = (c: Context) => {
	return {account: c.get('account'), publicKey: c.get('publicKey')};
};

export function eth_auth<Env extends Bindings = Bindings>(options: ETHAuthOptions<Env>): MiddlewareHandler {
	const {getDB} = options.serverOptions;

	return async (c, next) => {
		const storage = new RemoteSQLStorage(getDB(c));
		const rawContent = await c.req.text();
		let publicKey: PublicKey | undefined;
		let account: Address | undefined;

		const authentication = c.req.header('SIGNATURE');
		if (authentication) {
			if (authentication.startsWith('FAKE:')) {
				if (c.env?.WORKER_ENV !== 'dev') {
					throw new Error(`FAKE authentication only allowed in dev mode`);
				}
				const splitted = authentication.split(':');

				// TODO typia validation
				// publicKey = SchemaPublicKey.parse(splitted[1]);
				publicKey = splitted[1] as PublicKey;

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
				publicKey = `0x${recoveredPubKey.toHex()}`;
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
				// TODO typia validation
				// account = SchemaAddress.parse(domainUser.user);
				account = domainUser.user as Address;
			}
		}

		if (account) {
			c.set('account', account);
		}

		if (publicKey) {
			c.set('publicKey', publicKey);
		}

		return next();
	};
}
