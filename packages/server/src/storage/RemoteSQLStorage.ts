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

type ConversationFromDB = Omit<Conversation, 'accepted' | 'members'> & {accepted: 0 | 1; members: string};

function formatConversation(v: ConversationFromDB): Conversation {
	return {...v, accepted: v.accepted == 1 ? true : false, members: JSON.parse(v.members)};
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
			`SELECT * from Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND recipient = ?4  ORDER BY timestamp DESC`,
		);
		const {results} = await statement.bind(action.domain, action.namespace, action.conversationID, address).all();
		return {messages: results} as ResponseGetMessages;
	}

	async markAsRead(address: Address, action: ActionMarkAsRead) {
		const statement = this.db.prepare(
			`UPDATE ConversationViews SET lastRead = ?5, accepted = 1 WHERE domain = ?1 AND namespace = ?2 AND user = ?3 AND conversationID = ?4`,
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
		// 	const upsertConversation = this.db
		// 		.prepare(`INSERT INTO Conversations(domain,namespace,first,second,conversationID,lastMessage,accepted,read)
		// 	VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
		// 	ON CONFLICT(domain,namespace,first,conversationID) DO UPDATE SET
		// 		lastMessage=excluded.lastMessage,
		// 		accepted=1,
		// 		read=excluded.read
		// `);

		const upsertLastMessageTimestampPerRecipient = this.db.prepare(`
			INSERT INTO LastMessageTimestamp(domain, namespace, conversationID, recipient, timestamp) VALUES(?1,?2,?3,?4,?5)
			ON CONFLICT(domain, namespace, conversationID, recipient) DO UPDATE SET
				timestamp=excluded.timestamp
			`);

		const upsertConversationView = this.db
			.prepare(`INSERT INTO ConversationViews(domain,namespace,user,conversationID,members,lastRead,accepted)
		VALUES(?1,?2,?3,?4,?5,?6,?7)
		ON CONFLICT(domain,namespace,user,conversationID) DO UPDATE SET 
			lastRead=MAX(lastRead, excluded.lastRead),
			accepted=MAX(accepted, excluded.accepted)
	`);

		const insertMessage = this.db.prepare(
			`INSERT INTO Messages
			(domain,namespace,conversationID,messageID,recipient,sender,message,timestamp)
			VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`,
		);

		const batch: SQLPreparedStatement[] = [];

		// TODO this is not full proof
		const messageID = Date.now();

		const members = action.messages.map((v) => v.to);

		for (const message of action.messages) {
			const myself = message.to === account ? 1 : 0;
			batch.push(
				upsertConversationView.bind(
					action.domain,
					action.namespace,
					message.to,
					action.conversationID,
					JSON.stringify(members),
					myself ? action.lastMessageReadTimestampMS : 0,
					myself,
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
			batch.push(
				upsertLastMessageTimestampPerRecipient.bind(
					action.domain,
					action.namespace,
					action.conversationID,
					message.to,
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
			`UPDATE ConversationViews SET accepted = 1, lastRead = ?5 WHERE domain = ?1 AND namespace = ?2 AND user = ?3 AND conversationID = ?4`,
		);
		await statement
			.bind(action.domain, action.namespace, account, action.conversationID, action.lastMessageReadTimestampMS)
			.all();
		return {
			timestampMS,
		};
	}

	async getConversations(domain: string, namespace: string, address: Address): Promise<ResponseGetConversations> {
		const statement = this.db.prepare(
			// `SELECT * from Conversations WHERE domain = ?1 AND namespace = ?2 AND first = ?3 ORDER BY accepted DESC, read ASC, lastMessage DESC`,
			`SELECT cv.*, lmt.timestamp AS lastMessageTimestamp
			FROM ConversationViews cv
			LEFT JOIN LastMessageTimestamp lmt ON cv.domain = lmt.domain 
				AND cv.namespace = lmt.namespace 
				AND cv.conversationID = lmt.conversationID 
				AND cv.user = lmt.recipient
			WHERE  cv.domain = ?1
    		AND cv.namespace = ?2
			AND cv.user = ?3
			ORDER BY lmt.timestamp DESC NULLS LAST;
`,
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
			// `SELECT * from Conversations WHERE domain = ?1 AND namespace =?2 AND first = ?3 AND accepted = 0 ORDER BY lastMessage DESC`,
			`SELECT cv.*, lmt.timestamp AS lastMessageTimestamp
			FROM ConversationViews cv
			LEFT JOIN LastMessageTimestamp lmt ON cv.domain = lmt.domain 
				AND cv.namespace = lmt.namespace 
				AND cv.conversationID = lmt.conversationID 
				AND cv.user = lmt.recipient
			WHERE  cv.domain = ?1
    		AND cv.namespace = ?2
			AND cv.user = ?3
			AND cv.accepted = 0
			ORDER BY lmt.timestamp DESC NULLS LAST;
`,
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
			// `SELECT * from Conversations WHERE domain = ?1 AND namespace =?2 AND first = ?3 AND accepted = 1 ORDER BY read ASC, lastMessage DESC`,
			`SELECT cv.*, lmt.timestamp AS lastMessageTimestamp
			FROM ConversationViews cv
			LEFT JOIN LastMessageTimestamp lmt ON cv.domain = lmt.domain 
				AND cv.namespace = lmt.namespace 
				AND cv.conversationID = lmt.conversationID 
				AND cv.user = lmt.recipient
			WHERE  cv.domain = ?1
    		AND cv.namespace = ?2
			AND cv.user = ?3
			AND cv.accepted = 1
			ORDER BY lmt.timestamp DESC NULLS LAST;
`,
		);
		const {results} = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
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
			await this.db.prepare(statement).all();
		}
	}
}
