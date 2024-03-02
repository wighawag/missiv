import { CorsResponse } from '../cors';
import type { Env } from '../env';
import {
	Action,
	ActionAcceptConversation,
	ActionMarkAsRead,
	ActionRegisterPublicKeys,
	ActionSendMessage,
	Address,
	Conversation,
	ConversationRequest,
	ResponseAcceptConversation,
	ResponseGetConversations,
	ResponseGetMessages,
	ResponseSendMessage,
	SchemaAction,
	SchemaAddress,
	parse,
} from '../types';
import { toJSONResponse } from '../utils';

const NotImplementedResponse = () => new CorsResponse('Not Implemented', { status: 500 });

type ConversationFromDB = { account: Address; last: number; read: 0 | 1 };

function formatConversation(v: ConversationFromDB): Conversation {
	return { ...v, read: !!v.read };
}

export function getConversationID(accountA: Address, accountB: Address) {
	accountA = accountA.toLowerCase() as Address;
	accountB = accountB.toLowerCase() as Address;
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export async function registerPublicKeys(env: Env, account: Address, timestampMS: number, action: ActionRegisterPublicKeys) {
	const statement = env.DB.prepare(`INSERT INTO Users(address,keys,created)
		VALUES(?1,?2,?3)
		ON CONFLICT(address) DO UPDATE SET keys=excluded.keys
	`);
	const response = await statement.bind(account, action.signingKey, timestampMS).run();
	return response;
}

export async function getChatMessages(env: Env, accountA: Address, accountB: Address): Promise<ResponseGetMessages> {
	// TODO authenticate before
	// encrypted means it should be fine, but still
	const statement = env.DB.prepare(`SELECT * from Messages WHERE conversation = ?1`);
	const conversation = getConversationID(accountA, accountB);
	const { results } = await statement.bind(conversation).all();
	return results as ResponseGetMessages;
}
export async function getConversations(env: Env, account: Address): Promise<ResponseGetConversations> {
	// TODO authenticate before
	const statement = env.DB.prepare(`SELECT * from ConversationViews WHERE first = ?1 AND accepted = TRUE`);
	const { results } = await statement.bind(account).all<ConversationFromDB>();
	return results.map(formatConversation);
}

export async function markAsRead(env: Env, account: Address, action: ActionMarkAsRead) {
	// TODO authenticate before

	const statement = env.DB.prepare(`UPDATE ConversationViews SET read = 1 WHERE first = ?1 AND conversation = ?2`);
	// TODO only if action.lastMessageTimestampMS >= ConversationViews.lastMessage

	const response = await statement.bind(account, action.conversation).run();
	return response;
}

export async function sendMessage(
	env: Env,
	account: Address,
	timestampMS: number,
	action: ActionSendMessage,
): Promise<ResponseSendMessage> {
	const conversation = getConversationID(action.to, account);
	const upsertComversation = env.DB.prepare(`INSERT INTO ConversationViews(first,second,conversation,lastMessage,accepted,read)
		VALUES(?1,?2,?3,?4,?5,?6)
		ON CONFLICT(first,conversation) DO UPDATE SET 
			lastMessage=excluded.lastMessage,
			read=excluded.read
	`);

	const insertMessage = env.DB.prepare(`INSERT INTO Messages(conversation,sender,timestamp,message,signature) VALUES(?1,?2,?3,?4,?5)`);
	const response = await env.DB.batch([
		upsertComversation.bind(action.to, account, conversation, timestampMS, 0, 0),
		upsertComversation.bind(account, action.to, conversation, timestampMS, 1, 1),
		insertMessage.bind(conversation, account, timestampMS, action.message, `FAKE:${account}`),
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
	const statement = env.DB.prepare(`UPDATE ConversationViews SET accepted = 1 WHERE first = ?1 AND conversation = ?2`);
	const response = await statement.bind(account, action.conversation).run();
	return {
		timestampMS,
	};
}

export async function getConversationRequests(env: Env, account: Address): Promise<ConversationRequest[]> {
	// TODO authenticate before
	const statement = env.DB.prepare(`SELECT * from ConversationViews WHERE first = ?1 AND accepted = FALSE`);
	const { results } = await statement.bind(account).all();
	return results as ConversationRequest[];
}

export async function handleApiRequest(path: string[], request: Request, env: Env): Promise<Response> {
	if (request.method == 'POST') {
	} else {
		return new CorsResponse('Method not allowed', { status: 405 });
	}
	const rawContent = await request.text();
	const action: Action = parse(SchemaAction, JSON.parse(rawContent));
	const timestampMS = Date.now();
	let account: Address | undefined;
	const authentication = request.headers.get('SIGNATURE');
	if (authentication) {
		if (authentication.startsWith('FAKE:')) {
			if (env.WORKER_ENV !== 'dev') {
				throw new Error(`FAKE authentication only allowed in dev mode`);
			}
			account = parse(SchemaAddress, authentication.split(':')[1]);
			if (!account) {
				throw new Error(`no account provided in FAKE mode`);
			}
		} else {
			// TODO
		}
	}

	switch (action.type) {
		case 'registerPublicKeys': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(registerPublicKeys(env, account, timestampMS, action));
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

		case 'getConversationRequests': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(getConversationRequests(env, account));
		}

		case 'markAsRead': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(markAsRead(env, account, action));
		}
		case 'getMessages': {
			if (!account) {
				throw new Error(`no account authenticated`);
			}

			return toJSONResponse(getChatMessages(env, account, action.with));
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
				env.DB.prepare(`DROP TABLE IF EXISTS ConversationViews;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS ConversationViews (
					first         text        NOT NULL,
					second        text        NOT NULL,
					conversation  text        NOT NULL,
					lastMessage   timestamp   NOT NULL, 
					accepted      boolean     NOT NULL,
					read        boolean     NOT NULL,
					PRIMARY KEY (first, conversation),
					FOREIGN KEY (first) REFERENCES Users (address),
					FOREIGN KEY (second) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_read ON ConversationViews (first, accepted, read);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_accepted ON ConversationViews (first, accepted);`),

				env.DB.prepare(`DROP TABLE IF EXISTS Messages;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS  Messages
				(
				  conversation text      NOT NULL,
				  sender       text      NOT NULL,
				  timestamp    timestamp NOT NULL,
				  message      text      NOT NULL,
				  signature    text      NOT NULL,
				  PRIMARY KEY (conversation, sender, timestamp),
				  FOREIGN KEY (sender) REFERENCES Users (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messsages ON Messages (conversation);`),

				env.DB.prepare(`DROP TABLE IF EXISTS Users;`),
				env.DB.prepare(`CREATE TABLE IF NOT EXISTS Users
				(
				  address text      NOT NULL,
				  keys    text      NOT NULL,
				  created timestamp NOT NULL,
				  PRIMARY KEY (address)
				);`),
				env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messsages ON Users (address);`),
			]);
			return toJSONResponse(response);
		}

		default:
			return new CorsResponse('Not found', { status: 404 });
	}
}
