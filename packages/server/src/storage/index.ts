import {recoverMessageAddress} from 'viem';
import type {Env} from '../env';
import {
	ActionAcceptConversation,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionSendMessage,
	PublicKey,
	ResponseAcceptConversation,
	ResponseGetConversations,
	ResponseGetMessages,
	ResponseSendMessage,
	Address,
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
import {RemoteSQL} from 'remote-sql';

export class MessagesStorage {
	constructor(private db: RemoteSQL) {}
	async register(
		env: Env,
		address: Address,
		publicKey: PublicKey,
		timestampMS: number,
		action: ActionRegisterDomainUser,
	) {
		// const insertUser = env.DB.prepare(`INSERT OR IGNORE INTO Users(address,name,created)
		// 	VALUES(?1,?2,?3)
		// `);
		const insertUser = env.DB.prepare(`INSERT INTO Users(address,name,created)
            VALUES(?1,?2,?3)
            ON CONFLICT(address) DO UPDATE SET name=coalesce(excluded.name,name)
        `);
		const insertDomainUser = env.DB
			.prepare(`INSERT INTO DomainUsers(user,domain,domainUsername,publicKey,signature,added,lastPresence)
            VALUES(?1,?2,?3,?4,?5,?6,?7)
            ON CONFLICT(user,domain) DO UPDATE SET domainUsername=coalesce(excluded.domainUsername,domainUsername), added=excluded.added, lastPresence=excluded.lastPresence
        `);
		// currently not possible to update publicKey: else  publicKey=excluded.publicKey,

		const response = await env.DB.batch([
			insertUser.bind(address, action.name || null, timestampMS),
			insertDomainUser.bind(
				address,
				action.domain,
				action.domainUsername || null,
				publicKey,
				action.signature,
				timestampMS,
				timestampMS,
			),
		]);

		return response;
	}

	async getMessages(env: Env, action: ActionGetMessages): Promise<ResponseGetMessages> {
		const statement = env.DB.prepare(
			`SELECT * from Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 ORDER BY timestamp DESC`,
		);
		const {results} = await statement.bind(action.domain, action.namespace, action.conversationID).all();
		return {messages: results} as ResponseGetMessages;
	}

	async getUser(env: Env, address: Address): Promise<ResponseGetMissivUser> {
		const response = await env.DB.prepare(`SELECT * from Users WHERE address = ?1`).bind(address).all();

		if (response.results.length === 1) {
			return {user: response.results[0] as MissivUser};
		}
		return {user: undefined};
	}

	async getDomainUser(env: Env, domain: string, address: Address): Promise<ResponseGetDomainUser> {
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

	async getUserAddressByPublicKey(env: Env, publicKey: PublicKey): Promise<ResponseGetDomainUser> {
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

	async markAsRead(env: Env, publicKey: PublicKey, action: ActionMarkAsRead) {
		const statement = env.DB.prepare(
			`UPDATE Conversations SET read = 1, accepted = 1 WHERE domain = ?1 AND namespace = ?2 AND first = ?3 AND conversationID = ?4`,
		);
		// TODO only if action.lastMessageTimestampMS >= Conversations.lastMessage

		const response = await statement.bind(action.domain, action.namespace, publicKey, action.conversationID).run();
		return response;
	}

	async sendMessage(
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

	async acceptConversation(
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

	async getConversations(
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

	async getUnacceptedConversations(
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

	async getAcceptedConversations(
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

	async setup() {}
}
