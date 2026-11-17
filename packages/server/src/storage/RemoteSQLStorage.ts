import {RemoteSQL, SQLPreparedStatement} from 'remote-sql';
import {
	ActionAcceptConversation,
	ActionEditDomainUser,
	ActionGetMessages,
	ActionMarkAsRead,
	ActionRegisterDomainUser,
	ActionRejectConversation,
	ActionSendMessage,
	ActionUnblock,
	Address,
	Conversation,
	ConversationMessage,
	DomainUser,
	MAX_PAGE_SIZE,
	PublicKey,
	ResponseAcceptConversation,
	ResponseGetAcceptedConversations,
	ResponseGetConversations,
	ResponseGetDomainUser,
	ResponseGetMessages,
	ResponseGetUnacceptedConversations,
	ResponseSendMessage,
	String0x,
} from '@missiv/common';
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
	senderOwnershipSignature: String0x;
	senderAppOrigin: string;
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

	/**
	 * Register a key for (address, domain), or REPLACE the key already registered
	 * there (a newer publication wins: messages encrypted to the old key stay
	 * stored, and only the old key can read them). A key registered for another
	 * (address, domain) is a 409.
	 */
	async register(
		address: Address,
		publicKey: PublicKey,
		signature: String0x,
		timestampMS: number,
		action: ActionRegisterDomainUser,
	) {
		const statement = this.db.prepare(`
			INSERT INTO DomainUsers (user, domain, publicKey, signature, appOrigin, name, description, added, lastPresence)
			VALUES (?1, ?2, ?3, ?4, ?8, ?5, ?6, ?7, ?7)
			ON CONFLICT (user, domain) DO UPDATE SET
				publicKey = excluded.publicKey,
				signature = excluded.signature,
				appOrigin = excluded.appOrigin,
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
					action.appOrigin,
				)
				.all();
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new MissivError('conflict', 'this key is already registered for another account or domain');
			}
			throw err;
		}
	}

	/**
	 * Record a request signature until `expiresAt`, dropping the expired ones;
	 * false when it was already recorded (a replay).
	 */
	async acceptRequestSignature(signature: string, expiresAt: number, now: number): Promise<boolean> {
		await this.db.prepare(`DELETE FROM RequestSignatures WHERE expiresAt < ?1`).bind(now).all();
		try {
			await this.db
				.prepare(`INSERT INTO RequestSignatures (signature, expiresAt) VALUES (?1, ?2)`)
				.bind(signature, expiresAt)
				.all();
			return true;
		} catch (err) {
			if (isUniqueViolation(err)) {
				return false;
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
		const limit = Math.min(action.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
		const {results} = await this.db
			.prepare(
				`SELECT * FROM Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND recipient = ?4
				AND (?5 IS NULL OR messageID < ?5)
				ORDER BY messageID DESC LIMIT ?6`,
			)
			.bind(action.domain, action.namespace, action.conversationID, address, action.before ?? null, limit + 1)
			.all<MessageRow>();
		const page = results.slice(0, limit);
		const messages: ConversationMessage[] = page.map((row) => ({
			domain: row.domain,
			namespace: row.namespace,
			conversationID: row.conversationID,
			id: row.messageID,
			recipient: row.recipient,
			sender: row.sender,
			senderPublicKey: row.senderPublicKey,
			senderOwnershipSignature: row.senderOwnershipSignature,
			senderAppOrigin: row.senderAppOrigin,
			recipientPublicKey: row.recipientPublicKey,
			content: row.content,
			timestamp: row.timestamp,
			messageType: row.messageType,
			signature: row.signature,
		}));
		return results.length > limit ? {messages, cursor: page[page.length - 1].messageID} : {messages};
	}

	async markAsRead(address: Address, action: ActionMarkAsRead) {
		await this.db
			.prepare(
				`UPDATE ConversationParticipants SET lastRead = ?5 WHERE domain = ?1 AND namespace = ?2 AND user = ?3 AND conversationID = ?4`,
			)
			.bind(action.domain, action.namespace, address, action.conversationID, action.lastMessageReadTimestampMS)
			.all();
	}

	/** Reject a conversation; in a conversation of two, also block its other member in the domain. */
	async rejectConversation(address: Address, timestampMS: number, action: ActionRejectConversation): Promise<void> {
		const {results} = await this.db
			.prepare(`SELECT members FROM Conversations WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3`)
			.bind(action.domain, action.namespace, action.conversationID)
			.all<{members: string}>();
		const batch: SQLPreparedStatement[] = [
			this.db
				.prepare(
					`UPDATE ConversationParticipants SET status = ${ParticipantStatus.Rejected}
					WHERE domain = ?1 AND namespace = ?2 AND user = ?3 AND conversationID = ?4`,
				)
				.bind(action.domain, action.namespace, address, action.conversationID),
		];
		const members: Address[] = results[0] ? JSON.parse(results[0].members) : [];
		if (members.length === 2 && members.includes(address)) {
			const other = members.find((member) => member !== address)!;
			batch.push(
				this.db
					.prepare(`INSERT OR IGNORE INTO Blocks (domain, user, blocked, timestamp) VALUES (?1, ?2, ?3, ?4)`)
					.bind(action.domain, address, other, timestampMS),
			);
		}
		await this.db.batch(batch);
	}

	async unblock(address: Address, action: ActionUnblock): Promise<void> {
		await this.db
			.prepare(`DELETE FROM Blocks WHERE domain = ?1 AND user = ?2 AND blocked = ?3`)
			.bind(action.domain, address, action.address)
			.all();
	}

	/** Of these members, the ones who blocked `sender` in the domain. */
	async blockersOf(domain: string, sender: Address, members: Address[]): Promise<Set<Address>> {
		const {results} = await this.db
			.prepare(`SELECT user FROM Blocks WHERE domain = ?1 AND blocked = ?2`)
			.bind(domain, sender)
			.all<{user: Address}>();
		const memberSet = new Set(members);
		return new Set(results.map((row) => row.user).filter((user) => memberSet.has(user)));
	}

	/** The domain users of these addresses (the registered ones). */
	async domainUsersOf(domain: string, addresses: Address[]): Promise<DomainUser[]> {
		const users: DomainUser[] = [];
		for (const address of addresses) {
			const {domainUser} = await this.getDomainUser(domain, address);
			if (domainUser) {
				users.push(domainUser);
			}
		}
		return users;
	}

	/** The registered keys of these addresses in the domain. */
	async publicKeysOf(domain: string, addresses: Address[]): Promise<Map<Address, PublicKey>> {
		const keys = new Map<Address, PublicKey>();
		for (const address of addresses) {
			const {domainUser} = await this.getDomainUser(domain, address);
			if (domainUser) {
				keys.set(address, domainUser.publicKey);
			}
		}
		return keys;
	}

	/**
	 * Store a message checked by the caller: one copy per member in `deliverTo`
	 * (the members minus those who blocked the sender), the conversation with all
	 * of `members`.
	 */
	async sendMessage(
		sender: DomainUser,
		timestampMS: number,
		action: ActionSendMessage,
		members: Address[],
		deliverTo: Set<Address>,
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
				senderOwnershipSignature, senderAppOrigin, recipientPublicKey, messageType, content, signature, timestamp)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
		`);

		const account = sender.user;
		const messageID = newULID(timestampMS);
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
			if (!deliverTo.has(message.to)) {
				continue;
			}
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
					sender.publicKey,
					sender.signature,
					sender.appOrigin,
					action.messageType === 'encrypted' ? message.toPublicKey : null,
					action.messageType,
					message.content,
					message.signature,
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

	private async conversationPage(
		domain: string,
		namespace: string,
		address: Address,
		status: ParticipantStatus | undefined,
		page: {limit?: number; before?: string},
	): Promise<{conversations: Conversation[]; cursor?: string}> {
		const limit = Math.min(page.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
		// the cursor is `<lastMessage>:<conversationID>` of the last item of the previous page
		let beforeTime: number | null = null;
		let beforeID: string | null = null;
		if (page.before) {
			const separator = page.before.indexOf(':');
			beforeTime = Number(page.before.slice(0, separator));
			beforeID = page.before.slice(separator + 1);
			if (separator < 0 || !Number.isFinite(beforeTime)) {
				throw new MissivError('invalid_request', 'malformed cursor');
			}
		}
		const {results} = await this.db
			.prepare(
				`${CONVERSATIONS_SELECT}
				AND (?4 IS NULL OR cp.status = ?4)
				AND (?5 IS NULL OR c.lastMessage < ?5 OR (c.lastMessage = ?5 AND c.conversationID < ?6))
				ORDER BY c.lastMessage DESC, c.conversationID DESC LIMIT ?7`,
			)
			.bind(domain, namespace, address, status ?? null, beforeTime, beforeID, limit + 1)
			.all<ConversationRow>();
		const rows = results.slice(0, limit);
		const conversations = rows.map(formatConversation);
		if (results.length > limit) {
			const last = rows[rows.length - 1];
			return {conversations, cursor: `${last.lastMessage}:${last.conversationID}`};
		}
		return {conversations};
	}

	async getConversations(
		domain: string,
		namespace: string,
		address: Address,
		page: {limit?: number; before?: string} = {},
	): Promise<ResponseGetConversations> {
		return this.conversationPage(domain, namespace, address, undefined, page);
	}

	async getUnacceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
		page: {limit?: number; before?: string} = {},
	): Promise<ResponseGetUnacceptedConversations> {
		const {conversations, cursor} = await this.conversationPage(
			domain,
			namespace,
			account,
			ParticipantStatus.Unaccepted,
			page,
		);
		return cursor ? {unacceptedConversations: conversations, cursor} : {unacceptedConversations: conversations};
	}

	async getAcceptedConversations(
		domain: string,
		namespace: string,
		account: Address,
		page: {limit?: number; before?: string} = {},
	): Promise<ResponseGetAcceptedConversations> {
		const {conversations, cursor} = await this.conversationPage(
			domain,
			namespace,
			account,
			ParticipantStatus.Accepted,
			page,
		);
		return cursor ? {acceptedConversations: conversations, cursor} : {acceptedConversations: conversations};
	}

	async migrate() {
		return migrate(this.db);
	}

	async reset() {
		return resetDatabase(this.db);
	}
}
