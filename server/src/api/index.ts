import { keccak_256 } from '@noble/hashes/sha3';
import { Signature, verify as verifySignature } from '@noble/secp256k1';
import { recoverMessageAddress } from 'viem';
import { CorsResponse } from '../cors';
import type { Env } from '../env';
import {
	Action,
	ActionAcceptConversation,
	ActionMarkAsRead,
	ActionRegisterNamespacedUser,
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
	ResponseGetNamespacedUser,
	NamespacedUser,
	getConversationID,
	ResponseGetUnacceptedConversations,
	ResponseGetAcceptedConversations,
	publicKeyAuthorizationMessage,
} from 'missiv';
import { toJSONResponse } from '../utils';

const NotImplementedResponse = () => new CorsResponse('Not Implemented', { status: 500 });

type ConversationFromDB = Omit<Conversation, 'read' | 'accepted'> & { read: 0 | 1; accepted: 0 | 1 };

function formatConversation(v: ConversationFromDB): Conversation {
	return { ...v, state: v.accepted == 0 ? 'unaccepted' : v.read === 0 ? 'unread' : 'read' };
}

export async function register(env: Env, publicKey: PublicKey, timestampMS: number, action: ActionRegisterNamespacedUser) {
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

	const insertUser = env.DB.prepare(`INSERT OR IGNORE INTO Users(address,created)
		VALUES(?1,?2)
	`);
	const insertNamespacedUser = env.DB.prepare(`INSERT INTO NamespacedUsers(user,namespace,publicKey,signature,added,lastPresence)
		VALUES(?1,?2,?3,?4,?5,?6)
		ON CONFLICT(user,namespace) DO UPDATE SET publicKey=excluded.publicKey, added=excluded.added, lastPresence=excluded.lastPresence
	`);

	const response = await env.DB.batch([
		insertUser.bind(address, timestampMS),
		insertNamespacedUser.bind(address, action.namespace, publicKey, action.signature, timestampMS, timestampMS),
	]);
	// await insertUser.bind(address, timestampMS, timestampMS).run();
	// const response = insertPublicKey.bind(address, action.namespace, publicKey, action.signature, timestampMS).run();

	return response;
}

export async function getChatMessages(env: Env, conversationID: string): Promise<ResponseGetMessages> {
	const statement = env.DB.prepare(`SELECT * from Messages WHERE conversationID = ?1 ORDER BY timestamp DESC`);
	const { results } = await statement.bind(conversationID).all();
	return { messages: results } as ResponseGetMessages;
}

export async function getUser(env: Env, address: Address): Promise<ResponseGetMissivUser> {
	const response = await env.DB.prepare(`SELECT * from Users WHERE address = ?1`).bind(address).all();

	if (response.results.length === 1) {
		return { user: response.results[0] as MissivUser };
	}
	return { user: undefined };
}

export async function getNamespacedUser(env: Env, namespace: string, address: Address): Promise<ResponseGetNamespacedUser> {
	const response = await env.DB.prepare(`SELECT * from NamespacedUsers WHERE user = ?1 AND namespace = ?2`).bind(address, namespace).all();

	if (response.results.length === 1) {
		return { namespacedUser: response.results[0] as NamespacedUser };
	}
	return { namespacedUser: undefined };
}

export async function getUserAddressByPublicKey(env: Env, publicKey: PublicKey): Promise<ResponseGetNamespacedUser> {
	const response = await env.DB.prepare(`SELECT * from NamespacedUsers WHERE publicKey = ?1`).bind(publicKey).all();

	if (response.results.length === 1) {
		return { namespacedUser: response.results[0] as NamespacedUser };
	}
	return { namespacedUser: undefined };
}

export async function markAsRead(env: Env, publicKey: PublicKey, action: ActionMarkAsRead) {
	const statement = env.DB.prepare(
		`UPDATE Conversations SET read = 1, accepted = 1 WHERE namespace = ?1 AND first = ?2 AND conversationID = ?3`,
	);
	// TODO only if action.lastMessageTimestampMS >= Conversations.lastMessage

	const response = await statement.bind(action.namespace, publicKey, action.conversationID).run();
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
	const upsertConversation = env.DB.prepare(`INSERT INTO Conversations(namespace,first,second,conversationID,lastMessage,accepted,read)
		VALUES(?1,?2,?3,?4,?5,?6,?7)
		ON CONFLICT(namespace,first,conversationID) DO UPDATE SET 
			lastMessage=excluded.lastMessage,
			accepted=1,
			read=excluded.read
	`);

	const insertMessage = env.DB.prepare(
		`INSERT INTO Messages(namespace,conversationID,sender,senderPublicKey,recipient,recipientPublicKey,timestamp,message,signature) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
	);

	const response = await env.DB.batch([
		upsertConversation.bind(action.namespace, action.to, account, conversationID, timestampMS, 0, 0),
		upsertConversation.bind(action.namespace, account, action.to, conversationID, timestampMS, 1, 1),
		insertMessage.bind(
			action.namespace,
			conversationID,
			account,
			publicKey,
			action.to,
			action.toPublicKey,
			timestampMS,
			action.message,
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
	const statement = env.DB.prepare(`UPDATE Conversations SET accepted = 1 WHERE namespace = ?1 AND first = ?2 AND conversationID = ?3`);
	const response = await statement.bind(action.namespace, account, action.conversationID).run();
	return {
		timestampMS,
	};
}

export async function getConversations(env: Env, namespace: string, address: Address): Promise<ResponseGetConversations> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE namespace = ?1 AND first = ?2 ORDER BY accepted DESC, read ASC, lastMessage DESC`,
	);
	const { results } = await statement.bind(namespace, address).all<ConversationFromDB>();
	return { conversations: results.map(formatConversation) };
}

export async function getUnacceptedConversations(
	env: Env,
	namespace: string,
	account: Address,
): Promise<ResponseGetUnacceptedConversations> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE namespace =?1 AND first = ?2 AND accepted = 0 ORDER BY lastMessage DESC`,
	);
	const { results } = await statement.bind(namespace, account).all<ConversationFromDB>();
	return { unacceptedConversations: results.map(formatConversation) };
}

export async function getAcceptedConversations(env: Env, namespace: string, account: Address): Promise<ResponseGetAcceptedConversations> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE namespace =?1 AND first = ?2 AND accepted = 1 ORDER BY read ASC, lastMessage DESC`,
	);
	const { results } = await statement.bind(namespace, account).all<ConversationFromDB>();
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

		const response = await env.DB.prepare(`SELECT * from NamespacedUsers WHERE publicKey = ?1`).bind(publicKey).all();

		if (response.results.length >= 1) {
			const userPublicKey = response.results[0];
			account = parse(SchemaAddress, userPublicKey.user);
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
			return toJSONResponse(getConversations(env, action.namespace, account));
		}

		case 'getAcceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return toJSONResponse(getAcceptedConversations(env, action.namespace, account));
		}

		case 'getUnacceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(getUnacceptedConversations(env, action.namespace, account));
		}

		case 'markAsRead': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(markAsRead(env, account, action));
		}
		case 'getMessages': {
			return toJSONResponse(getChatMessages(env, action.conversationID));
		}
		case 'getUser': {
			return toJSONResponse(getUser(env, action.address));
		}
		case 'getNamespacedUser': {
			return toJSONResponse(getNamespacedUser(env, action.namespace, action.address));
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
					namespace       text       NOT NULL,
					first           text       NOT NULL,
					second          text       NOT NULL,
					conversationID  text       NOT NULL,
					lastMessage     timestamp  NOT NULL,
					accepted        boolean    NOT NULL,
					read            boolean    NOT NULL,
					PRIMARY KEY (namespace, first, conversationID),
					FOREIGN KEY (first) REFERENCES Users (address),
					FOREIGN KEY (second) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Conversations_all_conversations ON Conversations (namespace, first, lastMessage);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Conversations_accepted ON Conversations (namespace, first, accepted, lastMessage);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Conversations_read ON Conversations (namespace, first, read, lastMessage);`),

				env.DB.prepare(`DROP TABLE IF EXISTS Messages;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS  Messages
				(
				  namespace           text       NOT NULL,
				  conversationID      text       NOT NULL,
				  sender              text       NOT NULL,
				  senderPublicKey     text       NOT NULL,
				  recipient           text       NOT NULL,
				  recipientPublicKey  text       NOT NULL,
				  timestamp           timestamp  NOT NULL,
				  message             text       NOT NULL,
				  signature           text       NOT NULL,
				  PRIMARY KEY (namespace, conversationID, sender, timestamp),
				  FOREIGN KEY (sender) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_Messsages ON Messages (namespace, conversationID, timestamp);`),

				env.DB.prepare(`DROP TABLE IF EXISTS NamespacedUsers;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS NamespacedUsers
				(
				  user          text       NOT NULL,
				  namespace     text       NOT NULL,
				  publicKey     text       NOT NULL,
				  signature     text       NOT NULL,
				  added         timestamp  NOT NULL,
				  lastPresence  timestamp  NOT NULL,
				  PRIMARY KEY (user, namespace),
				  FOREIGN KEY (user) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_NamespacedUsers_publicKey ON NamespacedUsers (publicKey);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_NamespacedUsers_lastPresence ON NamespacedUsers (lastPresence);`),

				env.DB.prepare(`DROP TABLE IF EXISTS Users;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS Users
				(
				  address       text       NOT NULL,
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
