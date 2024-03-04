import { keccak_256 } from '@noble/hashes/sha3';
import { Signature, verify as verifySignature } from '@noble/secp256k1';
import { recoverMessageAddress } from 'viem';
import { CorsResponse } from '../cors';
import type { Env } from '../env';
import {
	Action,
	ActionAcceptConversation,
	ActionMarkAsRead,
	ActionRegisterPublicKeys,
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
	ResponseGetUser,
	User,
} from 'missiv';
import { toJSONResponse } from '../utils';

export function publicKeyAuthorizationMessage({ address, publicKey }: { address: `0x${string}`; publicKey: `0x${string}` }): string {
	return `I authorize the following Public Key to represent me:\n ${publicKey}\n\n  Others can use this key to write me messages`;
}

const NotImplementedResponse = () => new CorsResponse('Not Implemented', { status: 500 });

type ConversationFromDB = Omit<Conversation, 'state'> & { state: 0 | 1 | 2 };

function formatConversation(v: ConversationFromDB): Conversation {
	return { ...v, state: v.state == 0 ? 'unaccepted' : v.state === 1 ? 'unread' : 'read' };
}

export function getConversationID(accountA: Address, accountB: Address) {
	accountA = accountA.toLowerCase() as PublicKey;
	accountB = accountB.toLowerCase() as PublicKey;
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export async function register(env: Env, publicKey: PublicKey, timestampMS: number, action: ActionRegisterPublicKeys) {
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

	const statement = env.DB.prepare(`INSERT INTO Users(address,publicKey,signature,lastPresence,created)
		VALUES(?1,?2,?3,?4,?5)
		ON CONFLICT(address) DO UPDATE SET publicKey=excluded.publicKey
	`);
	const response = await statement.bind(address, publicKey, action.signature, timestampMS, timestampMS).run();
	return response;
}

export async function getChatMessages(env: Env, conversationID: string): Promise<ResponseGetMessages> {
	const statement = env.DB.prepare(`SELECT * from Messages WHERE conversationID = ?1 ORDER BY timestamp DESC`);
	const { results } = await statement.bind(conversationID).all();
	return results as ResponseGetMessages;
}

export async function getUser(env: Env, address: Address): Promise<ResponseGetUser> {
	const response = await env.DB.prepare(`SELECT * from Users WHERE address = ?1`).bind(address).all();

	if (response.results.length === 1) {
		return response.results[0] as User;
	}
	return undefined;
}

export async function getUserByPublicKey(env: Env, publicKey: PublicKey): Promise<ResponseGetUser> {
	const response = await env.DB.prepare(`SELECT * from Users WHERE publicKey = ?1`).bind(publicKey).all();

	if (response.results.length === 1) {
		return response.results[0] as User;
	}
	return undefined;
}

export async function markAsRead(env: Env, publicKey: PublicKey, action: ActionMarkAsRead) {
	const statement = env.DB.prepare(`UPDATE Conversations SET read = 1 WHERE namespace = ?1 AND first = ?2 AND conversationID = ?3`);
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
	const upsertConversation = env.DB.prepare(`INSERT INTO Conversations(namespace,first,second,conversationID,lastMessage,state)
		VALUES(?1,?2,?3,?4,?5,?6)
		ON CONFLICT(namespace,first,conversationID) DO UPDATE SET 
			lastMessage=excluded.lastMessage,
			state=1
	`);

	const insertMessage = env.DB.prepare(
		`INSERT INTO Messages(namespace,conversationID,sender,senderPublicKey,recipient,recipientPublicKey,timestamp,message,signature) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
	);

	const response = await env.DB.batch([
		upsertConversation.bind(action.namespace, action.to, account, conversationID, timestampMS, 0),
		upsertConversation.bind(action.namespace, account, action.to, conversationID, timestampMS, 2),
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
	const statement = env.DB.prepare(`UPDATE Conversations SET state = 2 WHERE namespace = ?1 AND first = ?2 AND conversationID = ?3`);
	const response = await statement.bind(action.namespace, account, action.conversationID).run();
	return {
		timestampMS,
	};
}

export async function getConversations(env: Env, namespace: string, publicKey: PublicKey): Promise<ResponseGetConversations> {
	const statement = env.DB.prepare(`SELECT * from Conversations WHERE namespace = ?1 AND first = ?2 ORDER BY state ASC, lastMessage DESC`);
	const { results } = await statement.bind(namespace, publicKey).all<ConversationFromDB>();
	return results.map(formatConversation);
}

export async function getUnacceptedConversations(env: Env, namespace: string, account: Address): Promise<Conversation[]> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE namespace =?1 AND first = ?2 AND state = 0 ORDER BY state ASC, lastMessage DESC`,
	);
	const { results } = await statement.bind(namespace, account).all<ConversationFromDB>();
	return results.map(formatConversation);
}

export async function getAcceptedConversations(env: Env, namespace: string, account: Address): Promise<Conversation[]> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE namespace =?1 AND first = ?2 AND state != 0 ORDER BY state ASC, lastMessage DESC`,
	);
	const { results } = await statement.bind(namespace, account).all<ConversationFromDB>();
	return results.map(formatConversation);
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

		const response = await env.DB.prepare(`SELECT * from Users WHERE publicKey = ?1`).bind(publicKey).all();

		if (response.results.length === 1) {
			const user = response.results[0];
			account = parse(SchemaAddress, user.address);
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
					state           integer    NOT NULL, 
					PRIMARY KEY (namespace, first, conversationID),
					FOREIGN KEY (first) REFERENCES Users (address),
					FOREIGN KEY (second) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_state ON Conversations (namespace, first, state, lastMessage);`),

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
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messsages ON Messages (namespace, conversationID, timestamp);`),

				env.DB.prepare(`DROP TABLE IF EXISTS Users;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS Users
				(
				  address       text       NOT NULL,
				  publicKey     text       NOT NULL,
				  signature     text       NOT NULL,
				  lastPresence  timestmap  NOT NULL,
				  created       timestamp  NOT NULL,
				  PRIMARY KEY (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messsages ON Users (lastPresence);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messsages ON Users (address);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messsages ON Messages (publicKey);`),
			]);
			return toJSONResponse(response);
		}

		default:
			return new CorsResponse('Not found', { status: 404 });
	}
}
