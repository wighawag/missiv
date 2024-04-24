import {keccak_256} from '@noble/hashes/sha3';
import {Signature} from '@noble/secp256k1';
import {Hono} from 'hono';
import {Bindings} from 'hono/types';
import {
	Action,
	Address,
	PublicKey,
	SchemaAction,
	SchemaAddress,
	SchemaPublicKey,
	parse,
	publicKeyAuthorizationMessage,
} from 'missiv';
import {ServerOptions} from '../../types';
import {recoverMessageAddress} from 'viem';
import {RemoteSQLStorage} from '../../storage/RemoteSQLStorage';

export function getPrivateChatAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const {getDB} = options;

	const app = new Hono<{Bindings: Env & {}}>().post('/', async (c) => {
		const storage = new RemoteSQLStorage(getDB(c));
		const rawContent = await c.req.text();
		const action: Action = parse(SchemaAction, JSON.parse(rawContent));
		const timestampMS = Date.now();
		let publicKey: PublicKey | undefined;
		let account: Address | undefined;

		const authentication = c.req.header('SIGNATURE');
		if (authentication) {
			if (authentication.startsWith('FAKE:')) {
				if (c.env?.WORKER_ENV !== 'dev') {
					throw new Error(`FAKE authentication only allowed in dev mode`);
				}
				const splitted = authentication.split(':');
				publicKey = parse(SchemaPublicKey, splitted[1]);
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

			if (domainUser) {
				if ('domain' in action) {
					if (domainUser.domain != action.domain) {
						throw new Error(`the publicKey belongs to domain "${domainUser.domain}" and not "${action.domain}"`);
					}
				}

				account = parse(SchemaAddress, domainUser.user);
			}
		}

		switch (action.type) {
			case 'register': {
				if (!publicKey) {
					throw new Error(`no publicKey authenticated`);
				}

				let address: Address;
				if (action.signature.startsWith('0xFAKE') || action.signature === '0x') {
					if (c.env.WORKER_ENV !== 'dev') {
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
				await storage.register(address, publicKey, timestampMS, action);
				return c.json({success: true});
			}

			case 'sendMessage': {
				if (!account) {
					throw new Error(`no account authenticated`);
				}
				if (!publicKey) {
					throw new Error(`no publicKey authenticated`);
				}

				const result = await storage.sendMessage(publicKey, account, timestampMS, action);
				return c.json(result);
			}

			case 'getConversations': {
				if (!account) {
					throw new Error(`no account authenticated`);
				}
				const result = await storage.getConversations(action.domain, action.namespace, account);
				return c.json(result);
			}

			case 'getAcceptedConversations': {
				if (!account) {
					throw new Error(`no account authenticated`);
				}
				const result = await storage.getAcceptedConversations(action.domain, action.namespace, account);
				return c.json(result);
			}

			case 'getUnacceptedConversations': {
				if (!account) {
					throw new Error(`no account authenticated`);
				}

				const result = await storage.getUnacceptedConversations(action.domain, action.namespace, account);
				return c.json(result);
			}

			case 'markAsRead': {
				if (!account) {
					throw new Error(`no account authenticated`);
				}

				await storage.markAsRead(account, action);
				return c.json({success: true});
			}
			case 'getMessages': {
				const result = await storage.getMessages(action);
				return c.json(result);
			}
			case 'getUser': {
				const result = await storage.getUser(action.address);
				return c.json(result);
			}
			case 'getCompleteUser': {
				const result = await storage.getCompleteUser(action.domain, action.address);
				return c.json(result);
			}
			case 'acceptConversation': {
				if (!account) {
					throw new Error(`no account authenticated`);
				}
				const result = await storage.acceptConversation(account, timestampMS, action);
				return c.json(result);
			}
			case 'db:select': {
				if (c.env.WORKER_ENV !== 'dev') {
					throw new Error(`kv api not available unless in dev mode`);
				}
				// const table = action.table;
				// const SQL_SELECT = env.DB.prepare('SELECT * FROM ?1');
				// const {results} = await SQL_SELECT.bind(table).all();
				// return c.json(results);
				return c.html('Not Implemented', 400);
			}

			case 'db:reset': {
				if (c.env.WORKER_ENV !== 'dev') {
					throw new Error(`kv api not available unless in dev mode`);
				}
				await storage.reset();
				return c.json({success: true});
			}

			default:
				return c.html(`Not Action found for : ${(action as any).type}`, 404);
		}
	});

	return app;
}
