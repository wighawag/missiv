import {
	object,
	string,
	literal,
	Output,
	special,
	variant,
	number,
	toLowerCase,
	BaseTransformation,
	BaseValidation,
	union,
	optional,
	forward,
	custom,
} from 'valibot';
import {DB} from './types';
import {domainusers, users} from './db/schema';
import {sql} from 'drizzle-orm';
export {parse} from 'valibot';

const string0x = (...args: (BaseValidation<`0x${string}`> | BaseTransformation<`0x${string}`>)[]) =>
	special<`0x${string}`>((val) => (typeof val === 'string' ? val.startsWith('0x') : false), 'do not start with 0x', [
		toLowerCase() as BaseTransformation<`0x${string}`>,
		...args,
	]);

export const SchemaPublicKey = string0x();
export type PublicKey = Output<typeof SchemaPublicKey>;

export const SchemaAddress = string0x();
export type Address = Output<typeof SchemaAddress>;

export const SchemaActionSendMessage = object(
	{
		type: literal('sendMessage'),
		domain: string(),
		namespace: string(),
		to: string0x(),
		toPublicKey: optional(string0x()),
		message: string(),
		messageType: union([literal('clear'), literal('encrypted')]),
		signature: string0x(),
	},
	[
		forward(
			custom(({toPublicKey, messageType}) => {
				if (messageType === 'clear') {
					return toPublicKey ? false : true;
				} else {
					return toPublicKey ? true : false;
				}
			}, 'toPublicKey is required when message is encrypted and forbidden when message is clear'),
			['toPublicKey'],
		),
	],
);

export type ActionSendMessage = Output<typeof SchemaActionSendMessage>;

export type ActionSendMessageInClear = {
	type: 'sendMessage';
	domain: string;
	namespace: string;
	to: `0x${string}`;
	message: string;
	messageType: 'clear';
	signature: `0x${string}`;
};

export type ActionSendEncryptedMessage = {
	type: 'sendMessage';
	domain: string;
	namespace: string;
	to: `0x${string}`;
	toPublicKey: `0x${string}`;
	message: string;
	messageType: 'encrypted';
	signature: `0x${string}`;
};

export type ResponseSendMessage = {
	timestampMS: number;
};

export const SchemaActionAcceptConversation = object({
	type: literal('acceptConversation'),
	domain: string(),
	namespace: string(),
	conversationID: string(),
});
export type ActionAcceptConversation = Output<typeof SchemaActionAcceptConversation>;
export type ResponseAcceptConversation = {
	timestampMS: number;
};

export type Conversation = {
	domain: string;
	namespace: string;
	first: Address;
	second: Address;
	conversationID: string;
	lastMessage: number;
	state: 'unaccepted' | 'unread' | 'read';
};
export const SchemaActionGetConversations = object({
	type: literal('getConversations'),
	domain: string(),
	namespace: string(),
});
export type ActionGetConversations = Output<typeof SchemaActionGetConversations>;
export type ResponseGetConversations = {conversations: Conversation[]};

export const SchemaActionGetUnacceptedConversations = object({
	type: literal('getUnacceptedConversations'),
	domain: string(),
	namespace: string(),
});
export type ActionGetUnacceptedConversations = Output<typeof SchemaActionGetUnacceptedConversations>;
export type ResponseGetUnacceptedConversations = {unacceptedConversations: Conversation[]};

export const SchemaActionGetAcceptedConversations = object({
	type: literal('getAcceptedConversations'),
	domain: string(),
	namespace: string(),
});
export type ActionGetAcceptedConversations = Output<typeof SchemaActionGetAcceptedConversations>;
export type ResponseGetAcceptedConversations = {acceptedConversations: Conversation[]};

export const SchemaActionMarkAsRead = object({
	type: literal('markAsRead'),
	domain: string(),
	namespace: string(),
	conversationID: string(),
	lastMessageTimestampMS: number(),
});
export type ActionMarkAsRead = Output<typeof SchemaActionMarkAsRead>;
export type ResponseMarkAsRead = {timestampMS: number};

export type ConversationMessage = {
	id: number;
	donmain: string;
	namespace: string;
	conversationID: string;
	sender: Address;
	senderPublicKey: PublicKey;
	recipient: Address;
	recipientPublicKey: PublicKey;
	timestamp: number;
	message: string;
	type: 'encrypted' | 'clear';
	signature: string;
};
export const SchemaActionGetMessages = object({
	domain: string(),
	namespace: string(),
	type: literal('getMessages'),
	conversationID: string(),
});
export type ActionGetMessages = Output<typeof SchemaActionGetMessages>;
export type ResponseGetMessages = {messages: ConversationMessage[]};

export type MissivUser = {
	address: Address;
	name: string;
	created: number;
};
export const SchemaActionGetMissivUser = object({
	type: literal('getUser'),
	address: string0x(),
});
export type ActionGetMissivUser = Output<typeof SchemaActionGetMissivUser>;
export type ResponseGetMissivUser = {user: MissivUser | undefined};

export type DomainUser = {
	address: Address;
	domain: string;
	domainUsername: string;
	publicKey: PublicKey;
	signature: `0x${string}`;
	lastPresence: number;
	added: number;
};
export const SchemaActionGetDomainUser = object({
	type: literal('getDomainUser'),
	domain: string(),
	address: string0x(),
});
export type ActionGetDomainUser = Output<typeof SchemaActionGetDomainUser>;
export type ResponseGetDomainUser = {domainUser: (DomainUser & MissivUser) | undefined};

export const SchemaActionRegisterDomainUser = object({
	type: literal('register'),
	domain: string(),
	signature: string0x(),
	address: string0x(),
	name: optional(string()),
	domainUsername: optional(string()),
});
export type ActionRegisterDomainUser = Output<typeof SchemaActionRegisterDomainUser>;
export type ResponseRegisterDomainUser = {timestampMS: number};

export const SchemaAction = variant('type', [
	SchemaActionRegisterDomainUser,
	SchemaActionSendMessage,
	SchemaActionGetConversations,
	SchemaActionGetUnacceptedConversations,
	SchemaActionGetAcceptedConversations,
	SchemaActionMarkAsRead,
	SchemaActionGetMessages,
	SchemaActionAcceptConversation,
	SchemaActionGetMissivUser,
	SchemaActionGetDomainUser,

	object({
		type: literal('db:select'),
		table: string(),
	}),
	object({
		type: literal('db:reset'),
	}),
]);

export type Action = Output<typeof SchemaAction>;

export function getConversationID(accountA: Address, accountB: Address) {
	accountA = accountA.toLowerCase() as PublicKey;
	accountB = accountB.toLowerCase() as PublicKey;
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

export function publicKeyAuthorizationMessage({
	address,
	publicKey,
}: {
	address: `0x${string}`;
	publicKey: `0x${string}`;
}): string {
	return `I authorize the following Public Key to represent me:\n ${publicKey}\n\n  Others can use this key to write me messages`;
}

type ConversationFromDB = Omit<Conversation, 'read' | 'accepted'> & {read: 0 | 1; accepted: 0 | 1};

function formatConversation(v: ConversationFromDB): Conversation {
	return {...v, state: v.accepted == 0 ? 'unaccepted' : v.read === 0 ? 'unread' : 'read'};
}

export async function register(
	db: DB<any>,
	publicKey: PublicKey,
	timestampMS: number,
	action: ActionRegisterDomainUser,
) {
	let address: Address;
	// if (action.signature.startsWith('0xFAKE') || action.signature === '0x') {
	// 	if (env.WORKER_ENV !== 'dev') {
	// 		throw new Error(`FAKE authentication only allowed in dev mode`);
	// 	}
	// 	address = action.address;
	// } else {
	// 	const message = publicKeyAuthorizationMessage({ address: action.address, publicKey });
	// 	address = await recoverMessageAddress({
	// 		message,
	// 		signature: action.signature,
	// 	});
	// 	if (address.toLowerCase() != action.address.toLowerCase()) {
	// 		throw new Error(`no matching address from signature: ${message}, ${address} != ${action.address}`);
	// 	}
	// }

	address = address.toLowerCase() as Address;

	// TODO use prepared statement in batch: see : https://github.com/drizzle-team/drizzle-orm/issues/2197
	const response = await db.batch([
		db
			.insert(users)
			.values({
				address: sql.placeholder('address'),
				name: sql.placeholder('name'),
				created: sql.placeholder('created'),
			})
			.onConflictDoUpdate({
				target: users.address,
				set: {
					name: sql`coalesce(excluded.name,name)`,
				},
			}),
		db
			.insert(domainusers)
			.values({
				user: sql.placeholder('user'),
				domain: sql.placeholder('domain'),
				domainUsername: sql.placeholder('domainUsername'),
				publicKey: sql.placeholder('publicKey'),
				signature: sql.placeholder('signature'),
				added: sql.placeholder('added'),
				lastPresence: sql.placeholder('lastPresence'),
			})
			// currently not possible to update publicKey: else  publicKey=excluded.publicKey,
			.onConflictDoUpdate({
				target: [domainusers.user, domainusers.domain],
				set: {
					domainUsername: sql`coalesce(excluded.domainUsername,domainUsername)`,
					added: sql`excluded.added`,
					lastPresence: sql`excluded.lastPresence`,
				},
			}),
		// insertUser.run({address, name: action.name || null, created: timestampMS}),
		// insertDomainUser.execute(
		// 	address,
		// 	action.domain,
		// 	action.domainUsername || null,
		// 	publicKey,
		// 	action.signature,
		// 	timestampMS,
		// 	timestampMS,
		// ),
	]);

	return response;
}

export async function getMessages(env: Env, action: ActionGetMessages): Promise<ResponseGetMessages> {
	const statement = env.DB.prepare(
		`SELECT * from Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 ORDER BY timestamp DESC`,
	);
	const {results} = await statement.bind(action.domain, action.namespace, action.conversationID).all();
	return {messages: results} as ResponseGetMessages;
}

export async function getUser(env: Env, address: Address): Promise<ResponseGetMissivUser> {
	const response = await env.DB.prepare(`SELECT * from Users WHERE address = ?1`).bind(address).all();

	if (response.results.length === 1) {
		return {user: response.results[0] as MissivUser};
	}
	return {user: undefined};
}

export async function getDomainUser(env: Env, domain: string, address: Address): Promise<ResponseGetDomainUser> {
	const response = await env.DB.prepare(
		`SELECT * from DomainUsers INNER JOIN Users on Users.address = ?1 AND user = ?1 AND domain = ?2;`,
	)
		.bind(address, domain)
		.all();

	if (response.results.length === 1) {
		return {domainUser: response.results[0] as DomainUser & MissivUser};
	}
	return {domainUser: undefined};
}

export async function getUserAddressByPublicKey(env: Env, publicKey: PublicKey): Promise<ResponseGetDomainUser> {
	// const response = await env.DB.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();
	const response = await env.DB.prepare(
		`SELECT * from DomainUsers INNER JOIN Users on Users.address = DomainUsers.user AND publicKey = ?1;`,
	)
		.bind(publicKey)
		.all();

	if (response.results.length === 1) {
		return {domainUser: response.results[0] as DomainUser & MissivUser};
	}
	return {domainUser: undefined};
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

export async function getConversations(
	env: Env,
	domain: string,
	namespace: string,
	address: Address,
): Promise<ResponseGetConversations> {
	const statement = env.DB.prepare(
		`SELECT * from Conversations WHERE domain = ?1 AND namespace = ?2 AND first = ?3 ORDER BY accepted DESC, read ASC, lastMessage DESC`,
	);
	const {results} = await statement.bind(domain, namespace, address).all<ConversationFromDB>();
	return {conversations: results.map(formatConversation)};
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
	const {results} = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
	return {unacceptedConversations: results.map(formatConversation)};
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
	const {results} = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
	return {acceptedConversations: results.map(formatConversation)};
}
