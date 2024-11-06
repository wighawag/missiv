import {keccak_256} from '@noble/hashes/sha3';
import {Signature} from '@noble/secp256k1';
import {Action, PublicKey, Conversation, Address, publicKeyAuthorizationMessage} from 'missiv-common';
import {Bindings} from 'hono/types';
import {ServerOptions} from '../types.js';
import {Hono} from 'hono';
import {createErrorObject} from '../utils/response.js';
import {Config} from '../setup.js';
import {recoverMessageAddress} from 'viem';
import {Env} from '../env.js';

export type ConversationFromDB = Omit<Conversation, 'read' | 'accepted'> & {read: 0 | 1; accepted: 0 | 1};

export function formatConversation(v: ConversationFromDB): Conversation {
	return {...v, state: v.accepted == 0 ? 'unaccepted' : v.read === 0 ? 'unread' : 'read'};
}

export function getPublicAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const {getDB, getEnv} = options;

	return new Hono<{Bindings: Env & {}}>().post('/', async (c) => {
		const env = getEnv(c);
		const db = getDB(c);
		try {
			const config = c.get('config');

			const rawContent = await c.req.text();
			// TODO typia validate
			const action: Action = JSON.parse(rawContent);

			let publicKey: PublicKey | undefined;
			let account: Address | undefined;

			const authentication = c.req.header('SIGNATURE');
			if (authentication) {
				if (authentication.startsWith('FAKE:')) {
					if (!(env as any).DEV) {
						throw new Error(`FAKE authentication only allowed in dev mode`);
					}
					const splitted = authentication.split(':');
					// TODO typia validate
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

				// TODO move to storage
				const response = await db.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();

				if (response.results.length >= 1) {
					const domainUser = response.results[0];
					if ('domain' in action) {
						if (domainUser.domain != action.domain) {
							throw new Error(`the publicKey belongs to domain "${domainUser.domain}" and not "${action.domain}"`);
						}
					}
					// TODO typia validate
					account = domainUser.user as Address;
				}
			}

			const result = handleComversationsApiRequest(config, env, publicKey, account, action);
			return c.json({success: true, result}, 200);
		} catch (err) {
			return c.json(createErrorObject(err), 500);
		}
	});
}

export async function handleComversationsApiRequest(
	config: Config,
	env: Env,
	publicKey: PublicKey | undefined,
	account: Address | undefined,
	action: Action,
) {
	const storage = config.storage;
	const timestampMS = Math.floor(Date.now());
	switch (action.type) {
		case 'register': {
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			let address: Address;
			if (action.signature.startsWith('0xFAKE') || action.signature === '0x') {
				if (!env.DEV) {
					throw new Error(`FAKE authentication only allowed in dev mode`);
				}
				address = action.address;
			} else {
				const message = publicKeyAuthorizationMessage({address: action.address, publicKey});
				address = await recoverMessageAddress({
					message,
					signature: action.signature,
				});
				if (address.toLowerCase() != action.address.toLowerCase()) {
					throw new Error(`no matching address from signature: ${message}, ${address} != ${action.address}`);
				}
			}

			address = address.toLowerCase() as Address;
			return storage.register(address, publicKey, timestampMS, action);
		}

		case 'sendMessage': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			return storage.sendMessage(publicKey, account, timestampMS, action);
		}

		case 'getConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return storage.getConversations(action.domain, action.namespace, account);
		}

		case 'getAcceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return storage.getAcceptedConversations(action.domain, action.namespace, account);
		}

		case 'getUnacceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return storage.getUnacceptedConversations(action.domain, action.namespace, account);
		}

		case 'markAsRead': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return storage.markAsRead(account, action);
		}
		case 'getMessages': {
			return storage.getMessages(action);
		}
		case 'getUser': {
			return storage.getUser(action.address);
		}
		case 'getDomainUser': {
			return storage.getDomainUser(action.domain, action.address);
		}
		case 'acceptConversation': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return storage.acceptConversation(account, timestampMS, action);
		}
		// case 'db:select': {
		// 	if (env.DEV) {
		// 		throw new Error(`kv api not available unless in dev mode`);
		// 	}
		// 	const table = action.table;
		// 	const SQL_SELECT = db.prepare('SELECT * FROM ?1');
		// 	const {results} = await SQL_SELECT.bind(table).all();
		// 	return results;
		// }
	}
}
