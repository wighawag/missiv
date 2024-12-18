import {Storage} from './index.js';
import {RemoteSQL} from 'remote-sql';
import setupComversationsTables from '../schema/ts/02_conversations.sql.js';
import setupUsersTables from '../schema/ts/01_users.sql.js';
import {sqlToStatements} from './utils.js';
import {
	ActionAcceptConversation,
	ActionEditDomainUser,
	ActionGetMessages,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionSendMessage,
	Address,
	Conversation,
	DomainUser,
	getConversationID,
	MissivUser,
	PublicKey,
	ResponseAcceptConversation,
	ResponseGetAcceptedConversations,
	ResponseGetCompleteUser,
	ResponseGetConversations,
	ResponseGetDomainUser,
	ResponseGetMessages,
	ResponseGetMissivUser,
	ResponseGetUnacceptedConversations,
	ResponseSendMessage,
} from 'missiv-common';
import dropTables from '../schema/ts/drop.sql.js';

type ConversationFromDB = Omit<Conversation, 'read' | 'accepted'> & {read: 0 | 1; accepted: 0 | 1};

function formatConversation(v: ConversationFromDB): Conversation {
	return {...v, state: v.accepted == 0 ? 'unaccepted' : v.read === 0 ? 'unread' : 'read'};
}
export class RemoteSQLStorage implements Storage {
	constructor(private db: RemoteSQL) {}

	async register(address: Address, publicKey: PublicKey, timestampMS: number, action: ActionRegisterDomainUser) {
		// const insertUser = this.db.prepare(`INSERT OR IGNORE INTO Users(address,name,created)
		// 	VALUES(?1,?2,?3)
		// `);
		const insertUser = this.db.prepare(`INSERT INTO Users(address,name,description,created)
		VALUES(?1,?2,?3,?4)
		ON CONFLICT(address) DO UPDATE SET
			name=coalesce(excluded.name,name),
			description=coalesce(excluded.description,description)
	`);
		const insertDomainUser = this.db
			.prepare(`INSERT INTO DomainUsers(user,domain,domainUsername,domainDescription,publicKey,signature,added,lastPresence)
		VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
		ON CONFLICT(user,domain) DO UPDATE SET 
			domainUsername=coalesce(excluded.domainUsername,domainUsername),
			domainDescription=coalesce(excluded.domainDescription,domainDescription),
			added=excluded.added, lastPresence=excluded.lastPresence
	`);
		// currently not possible to update publicKey: else  publicKey=excluded.publicKey,

		const response = await this.db.batch([
			insertUser.bind(address, action.name || null, action.description || null, timestampMS),
			insertDomainUser.bind(
				address,
				action.domain,
				action.domainUsername || null,
				action.domainDescription || null,
				publicKey,
				action.signature,
				timestampMS,
				timestampMS,
			),
		]);
	}

	async editUser(address: Address, timestampMS: number, action: ActionEditDomainUser) {
		const editRootUser = this.db.prepare(
			`UPDATE Users SET name = coalesce(?1, name), description = coalesce(?2, description) WHERE address = ?3 AND (description <> ?2 OR name <> ?1)`,
		);
		const editDomainUser = this.db.prepare(
			`UPDATE DomainUsers SET domainUsername =  coalesce(?1, domainUsername), domainDescription = coalesce(?2, domainDescription) WHERE user = ?3 AND domain = ?4 AND (domainDescription <> ?2 OR domainUsername <> ?1)`,
		);
		// currently not possible to update publicKey

		const response = await this.db.batch([
			editRootUser.bind(action.name || null, action.description || null, address),
			editDomainUser.bind(action.domainUsername || null, action.domainDescription || null, address, action.domain),
		]);
	}

	async getMessages(action: ActionGetMessages): Promise<ResponseGetMessages> {
		const statement = this.db.prepare(
			`SELECT * from Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 ORDER BY timestamp DESC`,
		);
		const {results} = await statement.bind(action.domain, action.namespace, action.conversationID).all();
		return {messages: results} as ResponseGetMessages;
	}

	async getUser(address: Address): Promise<ResponseGetMissivUser> {
		const response = await this.db.prepare(`SELECT * from Users WHERE address = ?1`).bind(address).all();

		if (response.results.length === 1) {
			return {user: response.results[0] as MissivUser};
		}
		return {user: undefined};
	}

	async getCompleteUser(domain: string, address: Address): Promise<ResponseGetCompleteUser> {
		const response = await this.db
			.prepare(`SELECT * from DomainUsers INNER JOIN Users on Users.address = ?1 AND user = ?1 AND domain = ?2;`)
			.bind(address, domain)
			.all();

		if (response.results.length === 1) {
			return {completeUser: response.results[0] as DomainUser & MissivUser};
		}
		return {completeUser: undefined};
	}

	async getCompleteUserByPublicKey(publicKey: PublicKey): Promise<ResponseGetCompleteUser> {
		// const response = await this.db.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();
		const response = await this.db
			.prepare(`SELECT * from DomainUsers INNER JOIN Users on Users.address = DomainUsers.user AND publicKey = ?1;`)
			.bind(publicKey)
			.all();

		if (response.results.length === 1) {
			return {completeUser: response.results[0] as DomainUser & MissivUser};
		}
		return {completeUser: undefined};
	}

	async getDomainUserByPublicKey(publicKey: PublicKey): Promise<ResponseGetDomainUser> {
		const response = await this.db.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();
		if (response.results.length === 1) {
			return {domainUser: response.results[0] as DomainUser};
		}
		return {domainUser: undefined};
	}

	async markAsRead(publicKey: PublicKey, action: ActionMarkAsRead) {
		const statement = this.db.prepare(
			`UPDATE Conversations SET read = 1, accepted = 1 WHERE domain = ?1 AND namespace = ?2 AND first = ?3 AND conversationID = ?4`,
		);
		// TODO only if action.lastMessageTimestampMS >= Conversations.lastMessage

		await statement.bind(action.domain, action.namespace, publicKey, action.conversationID).all();
	}

	async sendMessage(
		publicKey: PublicKey,
		account: Address,
		timestampMS: number,
		action: ActionSendMessage,
	): Promise<ResponseSendMessage> {
		const conversationID = getConversationID(action.to, account);
		const upsertConversation = this.db
			.prepare(`INSERT INTO Conversations(domain,namespace,first,second,conversationID,lastMessage,accepted,read)
		VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
		ON CONFLICT(domain,namespace,first,conversationID) DO UPDATE SET 
			lastMessage=excluded.lastMessage,
			accepted=1,
			read=excluded.read
	`);

		const insertMessage = this.db.prepare(
			`INSERT INTO Messages(domain,namespace,conversationID,sender,senderPublicKey,recipient,recipientPublicKey,timestamp,message,type,signature) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
		);

		const response = await this.db.batch([
			upsertConversation.bind(action.domain, action.namespace, action.to, account, conversationID, timestampMS, 0, 0),
			upsertConversation.bind(action.domain, action.namespace, account, action.to, conversationID, timestampMS, 1, 1),
			action.messageType === 'clear'
				? insertMessage.bind(
						action.domain,
						action.namespace,
						conversationID,
						account,
						publicKey,
						action.to,
						null,
						timestampMS,
						action.message,
						action.messageType,
						action.signature,
					)
				: insertMessage.bind(
						action.domain,
						action.namespace,
						conversationID,
						account,
						publicKey,
						action.to,
						action.toPublicKey,
						timestampMS,
						action.message,
						action.messageType,
						action.signature,
					),
		]);
		console.log({timestampMS});
		return {
			timestampMS,
		};
	}

	async acceptConversation(
		account: Address,
		timestampMS: number,
		action: ActionAcceptConversation,
	): Promise<ResponseAcceptConversation> {
		const statement = this.db.prepare(
			`UPDATE Conversations SET accepted = 1, read = 1 WHERE domain = ?1 AND namespace = ?2 AND first = ?3 AND conversationID = ?4`,
		);
		await statement.bind(action.domain, action.namespace, account, action.conversationID).all();
		return {
			timestampMS,
		};
	}

	async getConversations(domain: string, namespace: string, address: Address): Promise<ResponseGetConversations> {
		const statement = this.db.prepare(
			`SELECT * from Conversations WHERE domain = ?1 AND namespace = ?2 AND first = ?3 ORDER BY accepted DESC, read ASC, lastMessage DESC`,
		);
		const {results} = await statement.bind(domain, namespace, address).all<ConversationFromDB>();
		return {conversations: results.map(formatConversation)};
	}

	async getUnacceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetUnacceptedConversations> {
		const statement = this.db.prepare(
			`SELECT * from Conversations WHERE domain = ?1 AND namespace =?2 AND first = ?3 AND accepted = 0 ORDER BY lastMessage DESC`,
		);
		const {results} = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
		return {unacceptedConversations: results.map(formatConversation)};
	}

	async getAcceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetAcceptedConversations> {
		const statement = this.db.prepare(
			`SELECT * from Conversations WHERE domain = ?1 AND namespace =?2 AND first = ?3 AND accepted = 1 ORDER BY read ASC, lastMessage DESC`,
		);
		const {results} = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
		return {acceptedConversations: results.map(formatConversation)};
	}

	async setup() {
		const statements = sqlToStatements(setupUsersTables).concat(sqlToStatements(setupComversationsTables));
		// The following do not work on bun sqlite:
		//  (seems like prepared statement are partially executed and index cannot be prepared when table is not yet created)
		// await this.db.batch(statements.map((v) => this.db.prepare(v)));
		for (const statement of statements) {
			await this.db.prepare(statement).all();
		}
	}
	async reset() {
		const dropStatements = sqlToStatements(dropTables);
		const statements = sqlToStatements(setupUsersTables).concat(sqlToStatements(setupComversationsTables));
		const allStatements = dropStatements.concat(statements);
		// The following do not work on bun sqlite:
		//  (seems like prepared statement are partially executed and index cannot be prepared when table is not yet created)
		// await this.db.batch(allStatements.map((v) => this.db.prepare(v)));
		for (const statement of allStatements) {
			await this.db.prepare(statement).all();
		}
	}
}
