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
} from '../types';
import { toJSONResponse } from '../utils';

const NotImplementedResponse = () => new CorsResponse('Not Implemented', { status: 500 });

type ConversationFromDB = { read: 0 | 1; conversationID: string };

function formatConversation(v: ConversationFromDB): Conversation {
	return { ...v, read: !!v.read };
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
		address = await recoverMessageAddress({
			message: `Hello`,
			signature: action.signature,
		});
		if (address != action.address) {
			throw new Error(`no matching address from signature`);
		}
	}

	const statement = env.DB.prepare(`INSERT INTO Users(address,publicKey,signature,lastPresence,created)
		VALUES(?1,?2,?3,?4,?5)
		ON CONFLICT(address) DO UPDATE SET publicKey=excluded.publicKey
	`);
	const response = await statement.bind(address, publicKey, action.signature, timestampMS, timestampMS).run();
	return response;
}

export async function getChatMessages(env: Env, conversationID: string): Promise<ResponseGetMessages> {
	const statement = env.DB.prepare(`SELECT * from Messages WHERE conversationID = ?1`);
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

export async function getConversations(env: Env, publicKey: PublicKey): Promise<ResponseGetConversations> {
	const statement = env.DB.prepare(`SELECT * from Conversations WHERE first = ?1 AND accepted = TRUE`);
	const { results } = await statement.bind(publicKey).all<ConversationFromDB>();
	return results.map(formatConversation);
}

export async function markAsRead(env: Env, publicKey: PublicKey, action: ActionMarkAsRead) {
	const statement = env.DB.prepare(`UPDATE Conversations SET read = 1 WHERE first = ?1 AND conversationID = ?2`);
	// TODO only if action.lastMessageTimestampMS >= Conversations.lastMessage

	const response = await statement.bind(publicKey, action.conversationID).run();
	return response;
}

export async function sendMessage(
	env: Env,
	account: Address,
	timestampMS: number,
	action: ActionSendMessage,
): Promise<ResponseSendMessage> {
	const conversationID = getConversationID(action.to, account);
	const upsertConversation = env.DB.prepare(`INSERT INTO Conversations(first,second,conversationID,lastMessage,accepted,read)
		VALUES(?1,?2,?3,?4,?5,?6)
		ON CONFLICT(first,conversationID) DO UPDATE SET 
			lastMessage=excluded.lastMessage,
			read=excluded.read
	`);

	const insertMessage = env.DB.prepare(`INSERT INTO Messages(conversationID,sender,timestamp,message,signature) VALUES(?1,?2,?3,?4,?5)`);
	const response = await env.DB.batch([
		upsertConversation.bind(action.to, account, conversationID, timestampMS, 0, 0),
		upsertConversation.bind(account, action.to, conversationID, timestampMS, 1, 1),
		insertMessage.bind(conversationID, account, timestampMS, action.message, action.signature),
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
	const statement = env.DB.prepare(`UPDATE Conversations SET accepted = 1 WHERE first = ?1 AND conversationID = ?2`);
	const response = await statement.bind(account, action.conversationID).run();
	return {
		timestampMS,
	};
}

export async function getUnacceptedConversations(env: Env, account: Address): Promise<Conversation[]> {
	const statement = env.DB.prepare(`SELECT * from Conversations WHERE first = ?1 AND accepted = FALSE`);
	const { results } = await statement.bind(account).all();
	return results as Conversation[];
}

export async function handleApiRequest(path: string[], request: Request, env: Env): Promise<Response> {
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

			return toJSONResponse(sendMessage(env, account, timestampMS, action));
		}

		case 'getConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}
			return toJSONResponse(getConversations(env, account));
		}

		case 'getUnacceptedConversations': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(getUnacceptedConversations(env, account));
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
					first         text        NOT NULL,
					second        text        NOT NULL,
					conversationID  text        NOT NULL,
					lastMessage   timestamp   NOT NULL, 
					accepted      boolean     NOT NULL,
					read        boolean     NOT NULL,
					PRIMARY KEY (first, conversationID),
					FOREIGN KEY (first) REFERENCES Users (address),
					FOREIGN KEY (second) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_read ON Conversations (first, accepted, read);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_accepted ON Conversations (first, accepted);`),

				env.DB.prepare(`DROP TABLE IF EXISTS Messages;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS  Messages
				(
				  conversationID text      NOT NULL,
				  sender         text      NOT NULL,
				  timestamp      timestamp NOT NULL,
				  message        text      NOT NULL,
				  signature      text      NOT NULL,
				  PRIMARY KEY (conversationID, sender, timestamp),
				  FOREIGN KEY (sender) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messsages ON Messages (conversationID);`),

				env.DB.prepare(`DROP TABLE IF EXISTS Users;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS Users
				(
				  address text            NOT NULL,
				  publicKey text            NOT NULL,
				  signature text          NOT NULL,
				  lastPresence timestmap  NOT NULL,
				  created timestamp       NOT NULL,
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
