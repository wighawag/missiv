import { keccak_256 } from '@noble/hashes/sha3';
import { Signature, verify as verifySignature } from '@noble/secp256k1';
import { recoverMessageAddress } from 'viem';
import { CorsResponse } from '../cors';
import type { Env } from '../env';
import {
	Action,
	ActionAcceptConversation,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionSendMessage,
	PublicKey,
	Conversation,
	ResponseAcceptConversation,
	ResponseGetConversations,
	ResponseGetMessages,
	ResponseSendMessage,
	SchemaAction,
	SchemaPublicKey,
	parse,
	Address,
	SchemaAddress,
	ResponseGetMissivUser,
	MissivUser,
	ResponseGetDomainUser,
	DomainUser,
	getConversationID,
	ResponseGetUnacceptedConversations,
	ResponseGetAcceptedConversations,
	publicKeyAuthorizationMessage,
	ActionGetMessages,
} from 'missiv';
import { toJSONResponse } from '../utils';

const NotImplementedResponse = () => new CorsResponse('Not Implemented', { status: 500 });

type ConversationFromDB = Omit<Conversation, 'read' | 'accepted'> & { read: 0 | 1; accepted: 0 | 1 };

function formatConversation(v: ConversationFromDB): Conversation {
	return { ...v, state: v.accepted == 0 ? 'unaccepted' : v.read === 0 ? 'unread' : 'read' };
}

export async function register(env: Env, publicKey: PublicKey, timestampMS: number, action: ActionRegisterDomainUser) {
	let address: Address;
	if (action.signature.startsWith('0xFAKE') || action.signature === '0x') {
		if (env.WORKER_ENV !== 'dev') {
			throw new Error(`FAKE authentication only allowed in dev mode`);
		}
		address = action.address;
	} else {
		const message = publicKeyAuthorizationMessage({ address: action.address, publicKey });
		address = await recoverMessageAddress({
			message,
			signature: action.signature,
		});
		if (address.toLowerCase() != action.address.toLowerCase()) {
			throw new Error(`no matching address from signature: ${message}, ${address} != ${action.address}`);
		}
	}

	address = address.toLowerCase() as Address;

	// const insertUser = env.DB.prepare(`INSERT OR IGNORE INTO Users(address,name,created)
	// 	VALUES(?1,?2,?3)
	// `);
	const insertUser = env.DB.prepare(`INSERT INTO Users(address,name,created)
		VALUES(?1,?2,?3)
		ON CONFLICT(address) DO UPDATE SET name=coalesce(excluded.name,name)
	`);
	const insertDomainUser = env.DB.prepare(`INSERT INTO DomainUsers(user,domain,domainUsername,publicKey,signature,added,lastPresence)
		VALUES(?1,?2,?3,?4,?5,?6,?7)
		ON CONFLICT(user,domain) DO UPDATE SET domainUsername=coalesce(excluded.domainUsername,domainUsername), added=excluded.added, lastPresence=excluded.lastPresence
	`);
	// currently not possible to update publicKey: else  publicKey=excluded.publicKey,

	const response = await env.DB.batch([
		insertUser.bind(address, action.name || null, timestampMS),
		insertDomainUser.bind(address, action.domain, action.domainUsername || null, publicKey, action.signature, timestampMS, timestampMS),
	]);

	return response;
}

export async function getMessages(env: Env, action: ActionGetMessages): Promise<ResponseGetMessages> {
	const statement = env.DB.prepare(
		`SELECT * from Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 ORDER BY timestamp DESC`,
	);
	const { results } = await statement.bind(action.domain, action.namespace, action.conversationID).all();
	return { messages: results } as ResponseGetMessages;
}

export async function getUser(env: Env, address: Address): Promise<ResponseGetMissivUser> {
	const response = await env.DB.prepare(`SELECT * from Users WHERE address = ?1`).bind(address).all();

	if (response.results.length === 1) {
		return { user: response.results[0] as MissivUser };
	}
	return { user: undefined };
}

export async function getDomainUser(env: Env, domain: string, address: Address): Promise<ResponseGetDomainUser> {
	const response = await env.DB.prepare(`SELECT * from DomainUsers INNER JOIN Users on Users.address = ?1 AND user = ?1 AND domain = ?2;`)
		.bind(address, domain)
		.all();

	if (response.results.length === 1) {
		return { domainUser: response.results[0] as DomainUser & MissivUser };
	}
	return { domainUser: undefined };
}

export async function getUserAddressByPublicKey(env: Env, publicKey: PublicKey): Promise<ResponseGetDomainUser> {
	// const response = await env.DB.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();
	const response = await env.DB.prepare(
		`SELECT * from DomainUsers INNER JOIN Users on Users.address = DomainUsers.user AND publicKey = ?1;`,
	)
		.bind(publicKey)
		.all();

	if (response.results.length === 1) {
		return { domainUser: response.results[0] as DomainUser & MissivUser };
	}
	return { domainUser: undefined };
}

export async function markAsRead(env: Env, publicKey: PublicKey, action: ActionMarkAsRead) {
	const statement = env.DB.prepare(
		`UPDATE Conversations SET read = 1, accepted = 1 WHERE domain = ?1 AND namespace = ?2 AND first = ?3 AND conversationID = ?4`,
	);
	// TODO only if action.lastMessageTimestampMS >= Conversations.lastMessage

	const response = await statement.bind(action.domain, action.namespace, publicKey, action.conversationID).run();
	return response;
}

export async function sendMessage(
	env: Env,
	publicKey: PublicKey,
	account: Address,
	timestampMS: number,
	action: ActionSendMessage,
): Promise<ResponseSendMessage> {
	const conversationID = getConversationID(action.to, account);
	const upsertConversation = env.DB
		.prepare(`INSERT INTO Conversations(domain,namespace,first,second,conversationID,lastMessage,accepted,read)
		VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
		ON CONFLICT(domain,namespace,first,conversationID) DO UPDATE SET 
			lastMessage=excluded.lastMessage,
			accepted=1,
			read=excluded.read
	`);

	const insertMessage = env.DB.prepare(
		`INSERT INTO Messages(domain,namespace,conversationID,sender,senderPublicKey,recipient,recipientPublicKey,timestamp,message,type,signature) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
	);

	const response = await env.DB.batch([
		upsertConversation.bind(action.domain, action.namespace, action.to, account, conversationID, timestampMS, 0, 0),
		upsertConversation.bind(action.domain, action.namespace, account, action.to, conversationID, timestampMS, 1, 1),
		insertMessage.bind(
			action.domain,
			action.namespace,
			conversationID,
			account,
			publicKey,
			action.to,
			action.toPublicKey ? action.toPublicKey : null,
			timestampMS,
			action.message,
			action.messageType,
			action.signature,
		),
	]);
	return {
		timestampMS,
	};
}

export async function acceptConversation(
	env: Env,
	account: Address,
	timestampMS: number,
	action: ActionAcceptConversation,
): Promise<ResponseAcceptConversation> {
	const statement = env.DB.prepare(
		`UPDATE Conversations SET accepted = 1, read = 1 WHERE domain = ?1 AND namespace = ?2 AND first = ?3 AND conversationID = ?4`,
	);
	const response = await statement.bind(action.domain, action.namespace, account, action.conversationID).run();
	return {
		timestampMS,
	};
}

export async function getConversations(env: Env, domain: string, namespace: string, address: Address): Promise<ResponseGetConversations> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE domain = ?1 AND namespace = ?2 AND first = ?3 ORDER BY accepted DESC, read ASC, lastMessage DESC`,
	);
	const { results } = await statement.bind(domain, namespace, address).all<ConversationFromDB>();
	return { conversations: results.map(formatConversation) };
}

export async function getUnacceptedConversations(
	env: Env,
	domain: string,
	namespace: string,
	account: Address,
): Promise<ResponseGetUnacceptedConversations> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE domain = ?1 AND namespace =?2 AND first = ?3 AND accepted = 0 ORDER BY lastMessage DESC`,
	);
	const { results } = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
	return { unacceptedConversations: results.map(formatConversation) };
}

export async function getAcceptedConversations(
	env: Env,
	domain: string,
	namespace: string,
	account: Address,
): Promise<ResponseGetAcceptedConversations> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE domain = ?1 AND namespace =?2 AND first = ?3 AND accepted = 1 ORDER BY read ASC, lastMessage DESC`,
	);
	const { results } = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
	return { acceptedConversations: results.map(formatConversation) };
}

export async function handleComversationsApiRequest(path: string[], request: Request, env: Env): Promise<Response> {
	if (request.method == 'POST') {
	} else {
		return new CorsResponse('Method not allowed', { status: 405 });
	}
	const rawContent = await request.text();
	const action: Action = parse(SchemaAction, JSON.parse(rawContent));
	const timestampMS = Date.now();
	let publicKey: PublicKey | undefined;
	let account: Address | undefined;

	const authentication = request.headers.get('SIGNATURE');
	if (authentication) {
		if (authentication.startsWith('FAKE:')) {
			if (env.WORKER_ENV !== 'dev') {
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

		const response = await env.DB.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();

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

	switch (action.type) {
		case 'register': {
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			return toJSONResponse(register(env, publicKey, timestampMS, action));
		}

		case 'sendMessage': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			if (!publicKey) {
				throw new Error(`no publicKey authenticated`);
			}

			return toJSONResponse(sendMessage(env, publicKey, account, timestampMS, action));
		}

		case 'getConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return toJSONResponse(getConversations(env, action.domain, action.namespace, account));
		}

		case 'getAcceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return toJSONResponse(getAcceptedConversations(env, action.domain, action.namespace, account));
		}

		case 'getUnacceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(getUnacceptedConversations(env, action.domain, action.namespace, account));
		}

		case 'markAsRead': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(markAsRead(env, account, action));
		}
		case 'getMessages': {
			return toJSONResponse(getMessages(env, action));
		}
		case 'getUser': {
			return toJSONResponse(getUser(env, action.address));
		}
		case 'getDomainUser': {
			return toJSONResponse(getDomainUser(env, action.domain, action.address));
		}
		case 'acceptConversation': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return toJSONResponse(acceptConversation(env, account, timestampMS, action));
		}
		case 'db:select': {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`kv api not available unless in dev mode`);
			}
			const table = action.table;
			const SQL_SELECT = env.DB.prepare('SELECT * FROM ?1');
			const { results } = await SQL_SELECT.bind(table).all();
			return toJSONResponse(results);
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

				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Conversations_all_conversations ON Conversations (namespace, first, lastMessage);`),
				env.DB.prepare(
					`CREATE INDEX IF NOT EXISTS idx_Conversations_accepted ON Conversations (domain, namespace, first, accepted, lastMessage);`,
				),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Conversations_read ON Conversations (domain, namespace, first, read, lastMessage);`),

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

				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Messsages_list ON Messages (domain, namespace, conversationID, timestamp);`),
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
			return toJSONResponse(response);
		}

		default:
			return new CorsResponse('Not found', { status: 404 });
	}
}
