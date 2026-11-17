import {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {
	ActionAcceptConversation,
	ActionEditDomainUser,
	ActionGetMessages,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionRejectConversation,
	ActionSendMessage,
	Address,
	Conversation,
	ConversationMessage,
	DomainUser,
	PublicKey,
	ResponseAcceptConversation,
	ResponseGetAcceptedConversations,
	ResponseGetConversations,
	ResponseGetDomainUser,
	ResponseGetMessages,
	ResponseGetUnacceptedConversations,
	ResponseSendMessage,
	String0x,
} from 'missiv-common';
import {migrate, resetDatabase} from '../schema/migrate.js';
import {newULID} from './ids.js';
import {MissivError} from '../errors.js';

export enum ParticipantStatus {
	Unaccepted = 0,
	Rejected = 1,
	Accepted = 2,
}

type ConversationRow = {
	domain: string;
	namespace: string;
	conversationID: string;
	creationDate: number;
	members: string;
	lastMessage: number;
	user: Address;
	status: ParticipantStatus;
	lastRead: number;
};

type MessageRow = {
	domain: string;
	namespace: string;
	conversationID: string;
	recipient: Address;
	messageID: string;
	sender: Address;
	senderPublicKey: PublicKey;
	recipientPublicKey: PublicKey | null;
	messageType: 'clear' | 'encrypted';
	content: string;
	signature: String0x;
	timestamp: number;
};

function formatConversation(v: ConversationRow): Conversation {
	return {
		domain: v.domain,
		namespace: v.namespace,
		conversationID: v.conversationID,
		user: v.user,
		members: JSON.parse(v.members),
		lastMessage: v.lastMessage,
		lastRead: v.lastRead,
		accepted: v.status === ParticipantStatus.Accepted,
	};
}

function isUniqueViolation(err: unknown): boolean {
	const message = String((err as any)?.message ?? err) + String((err as any)?.cause?.message ?? '');
	return /UNIQUE constraint failed/i.test(message);
}

const CONVERSATIONS_SELECT = `
	SELECT c.*, cp.user AS user, cp.status AS status, cp.lastRead AS lastRead
	FROM ConversationParticipants cp
	JOIN Conversations c ON
		c.domain = cp.domain AND
		c.namespace = cp.namespace AND
		c.conversationID = cp.conversationID
	WHERE cp.domain = ?1 AND cp.namespace = ?2 AND cp.user = ?3`;

export class RemoteSQLStorage {
	constructor(private db: RemoteSQL) {}

	async register(
		address: Address,
		publicKey: PublicKey,
		signature: String0x,
		timestampMS: number,
		action: ActionRegisterDomainUser,
	) {
		const statement = this.db.prepare(`
			INSERT INTO DomainUsers (user, domain, publicKey, signature, name, description, added, lastPresence)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
			ON CONFLICT (user, domain) DO UPDATE SET
				name = coalesce(excluded.name, name),
				description = coalesce(excluded.description, description),
				lastPresence = excluded.lastPresence
		`);
		try {
			await statement
				.bind(
					address,
					action.domain,
					publicKey,
					signature,
					action.name ?? null,
					action.description ?? null,
					timestampMS,
				)
				.all();
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new MissivError('conflict', 'this key is already registered for another account or domain');
			}
			throw err;
		}
	}

	async editUser(address: Address, timestampMS: number, action: ActionEditDomainUser) {
		await this.db
			.prepare(
				`UPDATE DomainUsers SET name = coalesce(?1, name), description = coalesce(?2, description), lastPresence = ?3
				WHERE user = ?4 AND domain = ?5`,
			)
			.bind(action.name ?? null, action.description ?? null, timestampMS, address, action.domain)
			.all();
	}

	async getDomainUser(domain: string, address: Address): Promise<ResponseGetDomainUser> {
		const {results} = await this.db
			.prepare(`SELECT * FROM DomainUsers WHERE user = ?1 AND domain = ?2`)
			.bind(address, domain)
			.all<DomainUser>();
		return {domainUser: results[0]};
	}

	async getDomainUserByPublicKey(publicKey: PublicKey): Promise<ResponseGetDomainUser> {
		const {results} = await this.db
			.prepare(`SELECT * FROM DomainUsers WHERE publicKey = ?1`)
			.bind(publicKey)
			.all<DomainUser>();
		return {domainUser: results[0]};
	}

	async getMessages(address: Address, action: ActionGetMessages): Promise<ResponseGetMessages> {
		const {results} = await this.db
			.prepare(
				`SELECT * FROM Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND recipient = ?4
				ORDER BY messageID DESC`,
			)
			.bind(action.domain, action.namespace, action.conversationID, address)
			.all<MessageRow>();
		const messages: ConversationMessage[] = results.map((row) => ({
			domain: row.domain,
			namespace: row.namespace,
			conversationID: row.conversationID,
			id: row.messageID,
			recipient: row.recipient,
			sender: row.sender,
			senderPublicKey: row.senderPublicKey,
			recipientPublicKey: row.recipientPublicKey as PublicKey,
			content: row.content,
			timestamp: row.timestamp,
			messageType: row.messageType,
			signature: row.signature,
		}));
		return {messages};
	}

	async markAsRead(address: Address, action: ActionMarkAsRead) {
		await this.db
			.prepare(
				`UPDATE ConversationParticipants SET lastRead = ?5 WHERE domain = ?1 AND namespace = ?2 AND user = ?3 AND conversationID = ?4`,
			)
			.bind(action.domain, action.namespace, address, action.conversationID, action.lastMessageReadTimestampMS)
			.all();
	}

	async rejectConversation(address: Address, action: ActionRejectConversation): Promise<void> {
		await this.db
			.prepare(
				`UPDATE ConversationParticipants SET status = ${ParticipantStatus.Rejected}
				WHERE domain = ?1 AND namespace = ?2 AND user = ?3 AND conversationID = ?4`,
			)
			.bind(action.domain, action.namespace, address, action.conversationID)
			.all();
	}

	async sendMessage(
		publicKey: PublicKey,
		account: Address,
		timestampMS: number,
		action: ActionSendMessage,
	): Promise<ResponseSendMessage & {messageID: string}> {
		const upsertConversation = this.db.prepare(`
			INSERT INTO Conversations (domain, namespace, conversationID, creationDate, members, lastMessage)
			VALUES (?1, ?2, ?3, ?4, ?5, ?4)
			ON CONFLICT (domain, namespace, conversationID) DO UPDATE SET lastMessage = excluded.lastMessage
		`);
		const upsertParticipant = this.db.prepare(`
			INSERT INTO ConversationParticipants (domain, namespace, conversationID, user, status, lastRead)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6)
			ON CONFLICT (domain, namespace, conversationID, user) DO UPDATE SET
				status = MAX(status, excluded.status),
				lastRead = MAX(lastRead, excluded.lastRead)
		`);
		const insertMessage = this.db.prepare(`
			INSERT INTO Messages (domain, namespace, conversationID, recipient, messageID, sender, senderPublicKey,
				recipientPublicKey, messageType, content, signature, timestamp)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
		`);

		const messageID = newULID(timestampMS);
		const members = action.messages.map((v) => v.to);
		const batch: SQLPreparedStatement[] = [
			upsertConversation.bind(
				action.domain,
				action.namespace,
				action.conversationID,
				timestampMS,
				JSON.stringify(members),
			),
		];
		for (const message of action.messages) {
			const isMyself = message.to === account;
			batch.push(
				upsertParticipant.bind(
					action.domain,
					action.namespace,
					action.conversationID,
					message.to,
					isMyself ? ParticipantStatus.Accepted : ParticipantStatus.Unaccepted,
					isMyself ? action.lastMessageReadTimestampMS : 0,
				),
				insertMessage.bind(
					action.domain,
					action.namespace,
					action.conversationID,
					message.to,
					messageID,
					account,
					publicKey,
					message.toPublicKey ?? null,
					action.messageType,
					message.content,
					action.signature,
					timestampMS,
				),
			);
		}
		await this.db.batch(batch);
		return {timestampMS, messageID};
	}

	async acceptConversation(
		account: Address,
		timestampMS: number,
		action: ActionAcceptConversation,
	): Promise<ResponseAcceptConversation> {
		await this.db
			.prepare(
				`UPDATE ConversationParticipants SET status = ${ParticipantStatus.Accepted}, lastRead = ?5
				WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND user = ?4`,
			)
			.bind(action.domain, action.namespace, action.conversationID, account, action.lastMessageReadTimestampMS)
			.all();
		return {timestampMS};
	}

	async getConversations(domain: string, namespace: string, address: Address): Promise<ResponseGetConversations> {
		const {results} = await this.db
			.prepare(`${CONVERSATIONS_SELECT} ORDER BY c.lastMessage DESC`)
			.bind(domain, namespace, address)
			.all<ConversationRow>();
		return {conversations: results.map(formatConversation)};
	}

	async getUnacceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetUnacceptedConversations> {
		const {results} = await this.db
			.prepare(`${CONVERSATIONS_SELECT} AND cp.status = ${ParticipantStatus.Unaccepted} ORDER BY c.lastMessage DESC`)
			.bind(domain, namespace, account)
			.all<ConversationRow>();
		return {unacceptedConversations: results.map(formatConversation)};
	}

	async getAcceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
	): Promise<ResponseGetAcceptedConversations> {
		const {results} = await this.db
			.prepare(`${CONVERSATIONS_SELECT} AND cp.status = ${ParticipantStatus.Accepted} ORDER BY c.lastMessage DESC`)
			.bind(domain, namespace, account)
			.all<ConversationRow>();
		return {acceptedConversations: results.map(formatConversation)};
	}

	async migrate() {
		return migrate(this.db);
	}

	async reset() {
		return resetDatabase(this.db);
	}
}
