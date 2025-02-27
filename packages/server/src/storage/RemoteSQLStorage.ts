import {Storage} from './index.js';
import {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import setupComversationsTables from '../schema/ts/03_conversations.sql.js';
import setupUsersTables from '../schema/ts/01_users.sql.js';
import alterUsersTables from '../schema/ts/02_user_alter.sql.js';

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

// type ConversationFromDB = Omit<Conversation, 'accepted' | 'members'> & {status: number; members: string};

export interface DB_Message {
	// Primary key fields
	domain: string;
	namespace: string;
	conversationID: string;
	messageID: number;
	recipient: string;

	// Other fields
	sender: string;
	message: string;
	timestamp: Date;
}

export interface DB_Conversation {
	// Primary key fields
	domain: string;
	namespace: string;
	conversationID: string;

	// Other fields
	creationDate: Date;
	members: string; // Typically this would be parsed JSON
	name: string | null;
	lastMessage: number;
}

export interface DB_ConversationParticipant {
	// Primary key fields
	domain: string;
	namespace: string;
	conversationID: string;
	user: string;

	// Other fields
	status: DB_ConversationParticipantStatus;
	lastRead: Date | null;
}

// Enum for conversation status
export enum DB_ConversationParticipantStatus {
	Unaccepted = 0,
	Rejected = 1,
	Accepted = 2,
}

export type JOIN_ConversationWithParticipantStatus = DB_Conversation & {
	// ConversationParticipant fields
	user: string;
	status: 0 | 1 | 2;
	lastRead: number | null;
};

function formatConversation(v: JOIN_ConversationWithParticipantStatus): Conversation {
	return {
		domain: v.domain,
		namespace: v.namespace,
		conversationID: v.conversationID,
		user: v.user,
		members: JSON.parse(v.members),
		lastMessage: v.lastMessage,
		lastRead: v.lastRead ? v.lastRead : 0,
		accepted: v.status === 2,
	};
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
			// `UPDATE Users SET name = coalesce(?1, name), description = coalesce(?2, description) WHERE address = ?3 AND (description <> ?2 OR name <> ?1)`,
			`UPDATE Users SET name = coalesce(?1, name), description = coalesce(?2, description) WHERE address = ?3`,
		);
		const editDomainUser = this.db.prepare(
			// `UPDATE DomainUsers SET domainUsername =  coalesce(?1, domainUsername), domainDescription = coalesce(?2, domainDescription) WHERE user = ?3 AND domain = ?4 AND (domainDescription <> ?2 OR domainUsername <> ?1)`,
			`UPDATE DomainUsers SET domainUsername =  coalesce(?1, domainUsername), domainDescription = coalesce(?2, domainDescription) WHERE user = ?3 AND domain = ?4`,
		);
		// currently not possible to update publicKey

		const response = await this.db.batch([
			editRootUser.bind(action.name || null, action.description || null, address),
			editDomainUser.bind(action.domainUsername || null, action.domainDescription || null, address, action.domain),
		]);
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

	async getMessages(address: Address, action: ActionGetMessages): Promise<ResponseGetMessages> {
		const statement = this.db.prepare(
			`SELECT * from Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND recipient = ?4 ORDER BY timestamp DESC`,
		);
		const {results} = await statement.bind(action.domain, action.namespace, action.conversationID, address).all();
		return {messages: results} as ResponseGetMessages;
	}

	async markAsRead(address: Address, action: ActionMarkAsRead) {
		const statement = this.db.prepare(
			`UPDATE ConversationParticipants SET lastRead = ?5, status = 1 WHERE domain = ?1 AND namespace = ?2 AND user = ?3 AND conversationID = ?4`,
		);

		await statement
			.bind(action.domain, action.namespace, address, action.conversationID, action.lastMessageReadTimestampMS)
			.all();
	}

	async sendMessage(
		publicKey: PublicKey,
		account: Address,
		timestampMS: number,
		action: ActionSendMessage,
	): Promise<ResponseSendMessage> {
		const upsertConversation = this.db.prepare(`
			INSERT INTO Conversations(domain, namespace, conversationID, creationDate, members, lastMessage)
			VALUES(?1, ?2, ?3, ?4, ?5, ?6)
			ON CONFLICT(domain, namespace, conversationID) DO UPDATE SET
				lastMessage=excluded.lastMessage
		`);

		const upsertConversationParticipant = this.db.prepare(`
			INSERT INTO ConversationParticipants(domain, namespace, conversationID, user, status, lastRead)
			VALUES(?1, ?2, ?3, ?4, ?5, ?6)
			ON CONFLICT(domain, namespace, conversationID, user) DO UPDATE SET 
				status=MAX(status, excluded.status),
				lastRead=MAX(lastRead, excluded.lastRead)
		`);

		const insertMessage = this.db.prepare(`
			INSERT INTO Messages
			(domain, namespace, conversationID, messageID, recipient, sender, message, timestamp)
			VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
		`);

		const batch: SQLPreparedStatement[] = [];

		// TODO this is not full proof
		const messageID = Date.now();

		const members = action.messages.map((v) => v.to);

		// Update the conversation with the latest message timestamp
		batch.push(
			upsertConversation.bind(
				action.domain,
				action.namespace,
				action.conversationID,
				timestampMS, // creation date if new
				JSON.stringify(members),
				timestampMS, // lastMessage
			),
		);

		for (const message of action.messages) {
			const isMyself = message.to === account;

			batch.push(
				upsertConversationParticipant.bind(
					action.domain,
					action.namespace,
					action.conversationID,
					message.to,
					isMyself ? 2 : 0, // status: 0=unaccepted, 1 = rejected, 2 accepted
					isMyself ? action.lastMessageReadTimestampMS : 0, // lastRead
				),
			);

			batch.push(
				insertMessage.bind(
					action.domain,
					action.namespace,
					action.conversationID,
					messageID,
					message.to,
					account,
					JSON.stringify(message),
					timestampMS,
				),
			);
		}

		const response = await this.db.batch(batch);
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
			`UPDATE ConversationParticipants SET status = 2, lastRead = ?5 WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND user = ?4`,
		);
		await statement
			.bind(action.domain, action.namespace, action.conversationID, account, action.lastMessageReadTimestampMS)
			.all();
		return {
			timestampMS,
		};
	}

	async getConversations(domain: string, namespace: string, address: Address): Promise<ResponseGetConversations> {
		const statement = this.db.prepare(`
			SELECT c.*, cp.user as user, cp.status as status, cp.lastRead as lastRead
			FROM Conversations c
			JOIN ConversationParticipants cp ON 
				c.domain = cp.domain AND 
				c.namespace = cp.namespace AND 
				c.conversationID = cp.conversationID
			WHERE c.domain = ?1
			AND c.namespace = ?2
			AND cp.user = ?3
			ORDER BY c.lastMessage DESC NULLS LAST
		`);
		const {results} = await statement.bind(domain, namespace, address).all<JOIN_ConversationWithParticipantStatus>();
		return {conversations: results.map(formatConversation)};
	}

	async getUnacceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetUnacceptedConversations> {
		const statement = this.db.prepare(`
			SELECT c.*,  cp.user as user, cp.status as status, cp.lastRead as lastRead
			FROM Conversations c
			JOIN ConversationParticipants cp ON 
				c.domain = cp.domain AND 
				c.namespace = cp.namespace AND 
				c.conversationID = cp.conversationID
			WHERE c.domain = ?1
			AND c.namespace = ?2
			AND cp.user = ?3
			AND cp.status = 0
			ORDER BY c.lastMessage DESC NULLS LAST
		`);

		const {results} = await statement.bind(domain, namespace, account).all<JOIN_ConversationWithParticipantStatus>();
		return {unacceptedConversations: results.map(formatConversation)};
	}

	async getAcceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetAcceptedConversations> {
		const statement = this.db.prepare(`
			SELECT c.*, cp.user as user,  cp.status as status, cp.lastRead as lastRead
			FROM Conversations c
			JOIN ConversationParticipants cp ON 
				c.domain = cp.domain AND 
				c.namespace = cp.namespace AND 
				c.conversationID = cp.conversationID
			WHERE c.domain = ?1
			AND c.namespace = ?2
			AND cp.user = ?3
			AND cp.status = 2
			ORDER BY c.lastMessage DESC NULLS LAST
		`);
		const {results} = await statement.bind(domain, namespace, account).all<JOIN_ConversationWithParticipantStatus>();
		return {acceptedConversations: results.map(formatConversation)};
	}

	async setup() {
		const statements = sqlToStatements(setupUsersTables)
			.concat(alterUsersTables)
			.concat(sqlToStatements(setupComversationsTables));
		// The following do not work on bun sqlite:
		//  (seems like prepared statement are partially executed and index cannot be prepared when table is not yet created)
		// await this.db.batch(statements.map((v) => this.db.prepare(v)));
		for (const statement of statements) {
			await this.db.prepare(statement).all();
		}
	}
	async reset() {
		const dropStatements = sqlToStatements(dropTables);
		const statements = sqlToStatements(setupUsersTables)
			.concat(alterUsersTables)
			.concat(sqlToStatements(setupComversationsTables));
		const allStatements = dropStatements.concat(statements);

		// The following do not work on bun sqlite:
		//  (seems like prepared statement are partially executed and index cannot be prepared when table is not yet created)
		// await this.db.batch(allStatements.map((v) => this.db.prepare(v)));
		for (const statement of allStatements) {
			// console.log(`STATEMENT: ${statement}`);
			await this.db.prepare(statement).all();
		}
	}
}
