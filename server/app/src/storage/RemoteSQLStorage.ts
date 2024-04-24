import {Address, Conversation, DomainUser, MissivUser, PublicKey} from '../api/types';
import {
	ActionRegisterDomainUser,
	ResponseGetCompleteUser,
	ResponseGetDomainUser,
	ResponseGetMissivUser,
} from '../api/user/types';
import {
	ActionAcceptConversation,
	ActionGetMessages,
	ActionMarkAsRead,
	ActionSendMessage,
	ResponseAcceptConversation,
	ResponseGetAcceptedConversations,
	ResponseGetConversations,
	ResponseGetMessages,
	ResponseGetUnacceptedConversations,
	ResponseSendMessage,
} from '../api/private/types';
import {getConversationID} from '../api/utils';
import {RemoteSQL} from '../utils/DB';
import {Storage} from '.';

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
		const insertUser = this.db.prepare(`INSERT INTO Users(address,name,created)
		VALUES(?1,?2,?3)
		ON CONFLICT(address) DO UPDATE SET name=coalesce(excluded.name,name)
	`);
		const insertDomainUser = this.db
			.prepare(`INSERT INTO DomainUsers(user,domain,domainUsername,publicKey,signature,added,lastPresence)
		VALUES(?1,?2,?3,?4,?5,?6,?7)
		ON CONFLICT(user,domain) DO UPDATE SET domainUsername=coalesce(excluded.domainUsername,domainUsername), added=excluded.added, lastPresence=excluded.lastPresence
	`);
		// currently not possible to update publicKey: else  publicKey=excluded.publicKey,

		const response = await this.db.batch([
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
	}

	async getMessages(action: ActionGetMessages): Promise<ResponseGetMessages> {
		const statement = this.db.prepare(
			`SELECT * from Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 ORDER BY timestamp DESC`,
		);
		const {rows} = await statement.bind(action.domain, action.namespace, action.conversationID).all();
		return {messages: rows} as ResponseGetMessages;
	}

	async getUser(address: Address): Promise<ResponseGetMissivUser> {
		const response = await this.db.prepare(`SELECT * from Users WHERE address = ?1`).bind(address).all();

		if (response.rows.length === 1) {
			return {user: response.rows[0] as MissivUser};
		}
		return {user: undefined};
	}

	async getCompleteUser(domain: string, address: Address): Promise<ResponseGetCompleteUser> {
		const response = await this.db
			.prepare(`SELECT * from DomainUsers INNER JOIN Users on Users.address = ?1 AND user = ?1 AND domain = ?2;`)
			.bind(address, domain)
			.all();

		if (response.rows.length === 1) {
			return {completeUser: response.rows[0] as DomainUser & MissivUser};
		}
		return {completeUser: undefined};
	}

	async getCompleteUserByPublicKey(publicKey: PublicKey): Promise<ResponseGetCompleteUser> {
		// const response = await this.db.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();
		const response = await this.db
			.prepare(`SELECT * from DomainUsers INNER JOIN Users on Users.address = DomainUsers.user AND publicKey = ?1;`)
			.bind(publicKey)
			.all();

		if (response.rows.length === 1) {
			return {completeUser: response.rows[0] as DomainUser & MissivUser};
		}
		return {completeUser: undefined};
	}

	async getDomainUserByPublicKey(publicKey: PublicKey): Promise<ResponseGetDomainUser> {
		const response = await this.db.prepare(`SELECT * from DomainUsers WHERE publicKey = ?1`).bind(publicKey).all();
		if (response.rows.length === 1) {
			return {domainUser: response.rows[0] as DomainUser};
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
		const {rows} = await statement.bind(domain, namespace, address).all<ConversationFromDB>();
		return {conversations: rows.map(formatConversation)};
	}

	async getUnacceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetUnacceptedConversations> {
		const statement = this.db.prepare(
			`SELECT * from Conversations WHERE domain = ?1 AND namespace =?2 AND first = ?3 AND accepted = 0 ORDER BY lastMessage DESC`,
		);
		const {rows} = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
		return {unacceptedConversations: rows.map(formatConversation)};
	}

	async getAcceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetAcceptedConversations> {
		const statement = this.db.prepare(
			`SELECT * from Conversations WHERE domain = ?1 AND namespace =?2 AND first = ?3 AND accepted = 1 ORDER BY read ASC, lastMessage DESC`,
		);
		const {rows} = await statement.bind(domain, namespace, account).all<ConversationFromDB>();
		return {acceptedConversations: rows.map(formatConversation)};
	}

	async reset() {
		const response = await this.db.batch([
			this.db.prepare(`DROP TABLE IF EXISTS Conversations;`),
			this.db.prepare(`CREATE TABLE IF NOT EXISTS Conversations (
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

			this.db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_Conversations_all_conversations ON Conversations (namespace, first, lastMessage);`,
			),
			this.db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_Conversations_accepted ON Conversations (domain, namespace, first, accepted, lastMessage);`,
			),
			this.db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_Conversations_read ON Conversations (domain, namespace, first, read, lastMessage);`,
			),

			this.db.prepare(`DROP TABLE IF EXISTS Messages;`),
			this.db.prepare(`CREATE TABLE IF NOT EXISTS  Messages
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

			this.db.prepare(
				`CREATE INDEX IF NOT EXISTS idx_Messsages_list ON Messages (domain, namespace, conversationID, timestamp);`,
			),
			this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_Messsages_id ON Messages (id, timestamp);`),

			this.db.prepare(`DROP TABLE IF EXISTS DomainUsers;`),
			this.db.prepare(`CREATE TABLE IF NOT EXISTS DomainUsers
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
			this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_DomainUsers_publicKey ON DomainUsers (publicKey);`),
			this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_DomainUsers_lastPresence ON DomainUsers (lastPresence);`),

			this.db.prepare(`DROP TABLE IF EXISTS Users;`),
			this.db.prepare(`CREATE TABLE IF NOT EXISTS Users
            (
              address       text       NOT NULL,
              name			text       NULL,
              created       timestamp  NOT NULL,
              PRIMARY KEY (address)
            );`),
			// this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_Users ON Users (address);`),
		]);
	}
}
