import {keccak_256} from '@noble/hashes/sha3';
import {Signature} from '@noble/secp256k1';
import {Action, PublicKey, Conversation, SchemaAction, SchemaPublicKey, parse, Address, SchemaAddress} from 'missiv';
import {Bindings} from 'hono/types';
import {ServerOptions} from '../types.js';
import {Hono} from 'hono';
import {createErrorObject} from '../utils/response.js';
import {Config} from '../setup.js';

type ConversationFromDB = Omit<Conversation, 'read' | 'accepted'> & {read: 0 | 1; accepted: 0 | 1};

export function getPublicAPI<Env extends Bindings = Bindings>(options: ServerOptions<Env>) {
	const {getDB, getEnv} = options;

	return new Hono<{Bindings: Env & {}}>().post('/', async (c) => {
		const env = getEnv(c);
		const db = getDB(c);
		try {
			const config = c.get('config');

			const rawContent = await c.req.text();
			const action: Action = parse(SchemaAction, JSON.parse(rawContent));

			let publicKey: PublicKey | undefined;
			let account: Address | undefined;

			const authentication = c.req.header('SIGNATURE');
			if (authentication) {
				if (authentication.startsWith('FAKE:')) {
					if (!(env as any).DEV) {
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

				// TODO move to storage
				const response = await db.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();

				if (response.results.length >= 1) {
					const domainUser = response.results[0];
					if ('domain' in action) {
						if (domainUser.domain != action.domain) {
							throw new Error(`the publicKey belongs to domain "${domainUser.domain}" and not "${action.domain}"`);
						}
					}

					account = parse(SchemaAddress, domainUser.user);
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
	env: any, // TODO
	publicKey: string,
	account: string,
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
				if (!(env as any).DEV) {
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
			return storage.register(env, address, publicKey, timestampMS, action);
		}

		case 'sendMessage': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			return storage.sendMessage(env, publicKey, account, timestampMS, action);
		}

		case 'getConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return storage.getConversations(env, action.domain, action.namespace, account);
		}

		case 'getAcceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return storage.getAcceptedConversations(env, action.domain, action.namespace, account);
		}

		case 'getUnacceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return storage.getUnacceptedConversations(env, action.domain, action.namespace, account);
		}

		case 'markAsRead': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return storage.markAsRead(env, account, action);
		}
		case 'getMessages': {
			return storage.getMessages(env, action);
		}
		case 'getUser': {
			return storage.getUser(env, action.address);
		}
		case 'getDomainUser': {
			return storage.getDomainUser(env, action.domain, action.address);
		}
		case 'acceptConversation': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return storage.acceptConversation(env, account, timestampMS, action);
		}
		case 'db:select': {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`kv api not available unless in dev mode`);
			}
			const table = action.table;
			const SQL_SELECT = env.DB.prepare('SELECT * FROM ?1');
			const {results} = await SQL_SELECT.bind(table).all();
			return results;
		}

		case 'db:reset': {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`kv api not available unless in dev mode`);
			}
			const response = await env.DB.batch([
				env.DB.prepare(`DROP TABLE IF EXISTS Conversations;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS Conversations (
					domain          text       NOT NULL,
					namespace       text       NOT NULL,
					first           text       NOT NULL,
					second          text       NOT NULL,
					conversationID  text       NOT NULL,
					lastMessage     timestamp  NOT NULL,
					accepted        boolean    NOT NULL,
					read            boolean    NOT NULL,
					PRIMARY KEY (domain, namespace, first, conversationID)
				);`),

				// we do not set these foreign key as we want to be able to send message to unregistered users
				// FOREIGN KEY (first) REFERENCES Users (address),
				// FOREIGN KEY (second) REFERENCES Users (address)

				env.DB.prepare(
					`CREATE INDEX IF NOT EXISTS idx_Conversations_all_conversations ON Conversations (namespace, first, lastMessage);`,
				),
				env.DB.prepare(
					`CREATE INDEX IF NOT EXISTS idx_Conversations_accepted ON Conversations (domain, namespace, first, accepted, lastMessage);`,
				),
				env.DB.prepare(
					`CREATE INDEX IF NOT EXISTS idx_Conversations_read ON Conversations (domain, namespace, first, read, lastMessage);`,
				),

				env.DB.prepare(`DROP TABLE IF EXISTS Messages;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS  Messages
				(
				  id                  integer    PRIMARY KEY,
				  domain              text       NOT NULL,
				  namespace           text       NOT NULL,
				  conversationID      text       NOT NULL,
				  sender              text       NOT NULL,
				  senderPublicKey     text       NOT NULL,
				  recipient           text       NOT NULL,
				  recipientPublicKey  text       NULL,
				  timestamp           timestamp  NOT NULL,
				  message             text       NOT NULL,
				  type				  text       NOT NULL,
				  signature           text       NOT NULL
				);`),
				// we do not set these foreign key as we want to be able to send message to unregistered users
				// FOREIGN KEY (sender) REFERENCES Users (address)
				// FOREIGN KEY (recipient) REFERENCES Users (address),

				env.DB.prepare(
					`CREATE INDEX IF NOT EXISTS idx_Messsages_list ON Messages (domain, namespace, conversationID, timestamp);`,
				),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Messsages_id ON Messages (id, timestamp);`),

				env.DB.prepare(`DROP TABLE IF EXISTS DomainUsers;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS DomainUsers
				(
				  user            text       NOT NULL,
				  domain          text       NOT NULL,
				  domainUsername  text       NULL,
				  publicKey       text       NOT NULL,
				  signature       text       NOT NULL,
				  added           timestamp  NOT NULL,
				  lastPresence    timestamp  NOT NULL,
				  PRIMARY KEY (user, domain),
				  UNIQUE(publicKey),
				  FOREIGN KEY (user) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_DomainUsers_publicKey ON DomainUsers (publicKey);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_DomainUsers_lastPresence ON DomainUsers (lastPresence);`),

				env.DB.prepare(`DROP TABLE IF EXISTS Users;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS Users
				(
				  address       text       NOT NULL,
				  name			text       NULL,
				  created       timestamp  NOT NULL,
				  PRIMARY KEY (address)
				);`),
				// env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Users ON Users (address);`),
			]);
			return response;
		}
	}
}
