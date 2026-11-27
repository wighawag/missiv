// The ConversationStore and the Inbox over `remote-sql` (ADR-0005), for Node.js
// (libSQL) and Bun (bun:sqlite): `Messages`,
// `Inbox` and `Blocks` of one database, so a send is ONE transaction (one
// `batch`): the dedup read, the append under the next seq with the block check,
// both members' inbox rows, the lift of the sender's block of the recipient
// (a message the blocker sends unblocks, ADR-0006 "Sending"), and the read of
// what was stored (with the recipient's app origin, for the push). Six
// statements, whatever the size of
// the conversation or of the inboxes: each one is a lookup on a primary key or
// a unique index (the next seq is the last one, read backwards on the
// messages' primary key).
import type {RemoteSQL} from 'remote-sql';
import {
	membersOfConversationID,
	type Address,
	type Conversation,
	type Message,
	type MessageToSend,
} from '@missiv/common';
import {MissivError} from '../../errors.js';
import type {AppendResult, ConversationKey, ConversationStore, Inbox, InboxChanges, InboxUpdate} from '../ports.js';
import type {ConversationStatus} from '@missiv/common';

/** Inbox.status as stored. */
export enum InboxStatus {
	Unaccepted = 0,
	Rejected = 1,
	Accepted = 2,
}

const STATUS_OF: Record<InboxStatus, ConversationStatus> = {
	[InboxStatus.Unaccepted]: 'unaccepted',
	[InboxStatus.Rejected]: 'rejected',
	[InboxStatus.Accepted]: 'accepted',
};
const STATUS_VALUE: Record<ConversationStatus, InboxStatus> = {
	unaccepted: InboxStatus.Unaccepted,
	rejected: InboxStatus.Rejected,
	accepted: InboxStatus.Accepted,
};

/** Above every seq and every timestamp: the open end of a page. */
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;

type MessageRow = {
	domain: string;
	namespace: string;
	conversationID: string;
	seq: number;
	messageID: string;
	sender: Address;
	senderKeyRef: `0x${string}`;
	scheme: 'clear' | 'pairwise-v1';
	keyID: string | null;
	content: string;
	signature: `0x${string}`;
	serverTimestamp: number;
	hiddenFrom: Address | null;
};

function formatMessage(row: MessageRow): Message {
	return {
		domain: row.domain,
		namespace: row.namespace,
		conversationID: row.conversationID,
		messageID: row.messageID,
		sender: row.sender,
		senderKeyRef: row.senderKeyRef,
		scheme: row.scheme,
		keyID: row.keyID,
		content: row.content,
		signature: row.signature,
		seq: Number(row.seq),
		serverTimestamp: Number(row.serverTimestamp),
	} as Message;
}

/**
 * The upsert rule of an inbox row, shared by `Inbox.update` and the send's own
 * statements, so both apply an update the same way: only when its seq is above
 * the row's `lastSeq` (idempotent and monotonic, ADR-0006). An update can only
 * promote the status to accepted (the sender's own message) and only raise
 * `lastReadSeq`; the recipient's update carries `unaccepted` and 0, so it moves
 * neither.
 */
const INBOX_UPSERT = `ON CONFLICT (user, domain, namespace, conversationID) DO UPDATE SET
	status = CASE WHEN excluded.status = ${InboxStatus.Accepted} THEN ${InboxStatus.Accepted} ELSE Inbox.status END,
	lastSeq = excluded.lastSeq,
	lastReadSeq = MAX(Inbox.lastReadSeq, excluded.lastReadSeq),
	lastMessageAt = excluded.lastMessageAt,
	version = excluded.version
	WHERE excluded.lastSeq > Inbox.lastSeq`;

const INBOX_COLUMNS = `(user, domain, namespace, conversationID, status, lastSeq, lastReadSeq, lastMessageAt, version)`;

/**
 * The next inbox version of (`user`, `domain`), the SQL parameters naming them:
 * one more than the user's highest row's (read backwards on idx_inbox_version),
 * computed in the statement that changes the row, so the change and its
 * version are one write (SQLite runs one writer at a time).
 */
function nextVersion(user: string, domain: string): string {
	return `(SELECT COALESCE(MAX(version), 0) + 1 FROM Inbox WHERE user = ${user} AND domain = ${domain})`;
}

export class SQLConversationStore implements ConversationStore {
	constructor(private db: RemoteSQL) {}

	async append(
		message: MessageToSend,
		members: {sender: Address; recipient: Address},
		now: number,
	): Promise<AppendResult> {
		const {domain, namespace, conversationID, messageID} = message;
		const key = [domain, namespace, conversationID] as const;
		const [before, , , , , after] = await this.db.batch([
			// 1. a message already stored under this messageID (a retry, or a conflict)
			this.db
				.prepare(
					`SELECT seq, signature FROM Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND messageID = ?4`,
				)
				.bind(...key, messageID),
			// 2. the append: the next seq; hidden from the recipient when they blocked
			// the sender in the domain; nothing when the messageID is stored
			this.db
				.prepare(
					`INSERT INTO Messages (domain, namespace, conversationID, seq, messageID, sender, senderKeyRef, scheme,
						keyID, content, signature, serverTimestamp, hiddenFrom)
					SELECT ?1, ?2, ?3,
						COALESCE((SELECT seq FROM Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3
							ORDER BY seq DESC LIMIT 1), 0) + 1,
						?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
						CASE WHEN EXISTS (SELECT 1 FROM Blocks WHERE domain = ?1 AND user = ?12 AND blocked = ?5) THEN ?12 ELSE NULL END
					WHERE true
					ON CONFLICT (domain, namespace, conversationID, messageID) DO NOTHING`,
				)
				.bind(
					...key,
					messageID,
					members.sender,
					message.senderKeyRef,
					message.scheme,
					message.keyID,
					message.content,
					message.signature,
					now,
					members.recipient,
				),
			// 3. the sender's inbox row: accepted, read up to its own message
			this.db
				.prepare(
					`INSERT INTO Inbox ${INBOX_COLUMNS}
					SELECT ?5, domain, namespace, conversationID, ${InboxStatus.Accepted}, seq, seq, serverTimestamp,
						${nextVersion('?5', '?1')} FROM Messages
					WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND messageID = ?4 AND signature = ?6
					${INBOX_UPSERT}`,
				)
				.bind(...key, messageID, members.sender, message.signature),
			// 4. the recipient's, unless the message is hidden from them
			this.db
				.prepare(
					`INSERT INTO Inbox ${INBOX_COLUMNS}
					SELECT ?5, domain, namespace, conversationID, ${InboxStatus.Unaccepted}, seq, 0, serverTimestamp,
						${nextVersion('?5', '?1')} FROM Messages
					WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND messageID = ?4 AND signature = ?6
						AND hiddenFrom IS NULL
					${INBOX_UPSERT}`,
				)
				.bind(...key, messageID, members.recipient, message.signature),
			// 5. the sender's block of the recipient in the domain, lifted by this
			// message when it was set before it (an older message retried after a
			// newer block lifts nothing; nothing on a conflict)
			this.db
				.prepare(
					`DELETE FROM Blocks WHERE domain = ?1 AND user = ?5 AND blocked = ?7
					AND timestamp <= (SELECT serverTimestamp FROM Messages
						WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND messageID = ?4 AND signature = ?6)`,
				)
				.bind(...key, messageID, members.sender, message.signature, members.recipient),
			// 6. what is stored, with the recipient's app origin (their current key set's) for the push
			this.db
				.prepare(
					`SELECT m.*, k.appOrigin AS recipientAppOrigin FROM Messages m
					LEFT JOIN DomainUsers d ON d.user = ?5 AND d.domain = m.domain
					LEFT JOIN KeySets k ON k.domain = d.domain AND k.keyRef = d.keyRef AND k.user = d.user
					WHERE m.domain = ?1 AND m.namespace = ?2 AND m.conversationID = ?3 AND m.messageID = ?4`,
				)
				.bind(...key, messageID, members.recipient),
		]);
		const stored = after.results[0] as (MessageRow & {recipientAppOrigin: string | null}) | undefined;
		if (!stored) {
			throw new MissivError('internal', 'the message was not stored');
		}
		if (stored.signature !== message.signature) {
			return {status: 'conflict'};
		}
		if (before.results.length > 0) {
			return {status: 'duplicate', message: formatMessage(stored)};
		}
		const hiddenFrom = stored.hiddenFrom ?? undefined;
		return {
			status: 'appended',
			message: formatMessage(stored),
			...(hiddenFrom ? {hiddenFrom} : {}),
			pushTo:
				!hiddenFrom && stored.recipientAppOrigin
					? [{address: members.recipient, appOrigin: stored.recipientAppOrigin}]
					: [],
			pendingInboxUpdates: [],
		};
	}

	async listMessages(
		reader: Address,
		key: ConversationKey,
		page: {after?: number; before?: number; limit: number},
	): Promise<{messages: Message[]; hasMore: boolean}> {
		const forward = page.after !== undefined;
		const {results} = await this.db
			.prepare(
				forward
					? `SELECT * FROM Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND seq > ?4
						AND (hiddenFrom IS NULL OR hiddenFrom <> ?5) ORDER BY seq ASC LIMIT ?6`
					: `SELECT * FROM Messages WHERE domain = ?1 AND namespace = ?2 AND conversationID = ?3 AND seq < ?4
						AND (hiddenFrom IS NULL OR hiddenFrom <> ?5) ORDER BY seq DESC LIMIT ?6`,
			)
			.bind(
				key.domain,
				key.namespace,
				key.conversationID,
				forward ? page.after : (page.before ?? MAX_INTEGER),
				reader,
				page.limit + 1,
			)
			.all<MessageRow>();
		const rows = results.slice(0, page.limit).map(formatMessage);
		return {messages: forward ? rows : rows.reverse(), hasMore: results.length > page.limit};
	}
}

type InboxRow = {
	user: Address;
	domain: string;
	namespace: string;
	conversationID: string;
	status: InboxStatus;
	lastSeq: number;
	lastReadSeq: number;
	lastMessageAt: number;
	version: number;
};

function formatConversation(row: InboxRow): Conversation {
	return {
		domain: row.domain,
		namespace: row.namespace,
		conversationID: row.conversationID,
		members: membersOfConversationID(row.conversationID) ?? [],
		status: STATUS_OF[Number(row.status) as InboxStatus],
		lastSeq: Number(row.lastSeq),
		lastReadSeq: Number(row.lastReadSeq),
		lastMessageAt: Number(row.lastMessageAt),
		version: Number(row.version),
	};
}

/**
 * The cursor of a conversation list: `<lastMessageAt>:<conversationID>` of the
 * page's last item, its position in the index, so the next page starts right
 * after it however many items share its time.
 */
function parseCursor(cursor: string | undefined): [number, string] {
	if (cursor === undefined) {
		return [MAX_INTEGER, ''];
	}
	const separator = cursor.indexOf(':');
	const time = Number(cursor.slice(0, separator));
	if (separator < 0 || !Number.isInteger(time)) {
		throw new MissivError('invalid_request', 'malformed cursor');
	}
	return [time, cursor.slice(separator + 1)];
}

/**
 * A page of `Inbox.changes` from the rows read (oldest change first, at most
 * `limit + 1`, the extra one saying there are more) and the inbox's version
 * read before them: the version to poll from next is the last kept row's when
 * there are more, else the inbox's (or a row's above it, written in between).
 */
export function inboxChangesOf(rows: Conversation[], version: number, limit: number): InboxChanges {
	const conversations = rows.slice(0, limit);
	const hasMore = rows.length > limit;
	const last = conversations[conversations.length - 1]?.version ?? 0;
	return {version: hasMore ? last : Math.max(version, last), conversations, hasMore};
}

export class SQLInbox implements Inbox {
	constructor(private db: RemoteSQL) {}

	async update(update: InboxUpdate): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO Inbox ${INBOX_COLUMNS} VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ${nextVersion('?1', '?2')})
				${INBOX_UPSERT}`,
			)
			.bind(
				update.user,
				update.domain,
				update.namespace,
				update.conversationID,
				update.own ? InboxStatus.Accepted : InboxStatus.Unaccepted,
				update.seq,
				update.own ? update.seq : 0,
				update.lastMessageAt,
			)
			.all();
	}

	async changes(user: Address, domain: string, page: {since: number; limit: number}): Promise<InboxChanges> {
		const {results: current} = await this.db
			.prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM Inbox WHERE user = ?1 AND domain = ?2`)
			.bind(user, domain)
			.all<{version: number}>();
		const version = Number(current[0]?.version ?? 0);
		if (page.since === version) {
			return {version, unchanged: true};
		}
		// above the inbox's version: the database was reset, so every row
		const since = page.since > version ? 0 : page.since;
		const {results} = await this.db
			.prepare(`SELECT * FROM Inbox WHERE user = ?1 AND domain = ?2 AND version > ?3 ORDER BY version ASC LIMIT ?4`)
			.bind(user, domain, since, page.limit + 1)
			.all<InboxRow>();
		return inboxChangesOf(results.map(formatConversation), version, page.limit);
	}

	async getConversation(user: Address, key: ConversationKey): Promise<Conversation | undefined> {
		const {results} = await this.db
			.prepare(`SELECT * FROM Inbox WHERE user = ?1 AND domain = ?2 AND namespace = ?3 AND conversationID = ?4`)
			.bind(user, key.domain, key.namespace, key.conversationID)
			.all<InboxRow>();
		return results[0] ? formatConversation(results[0]) : undefined;
	}

	async listConversations(
		user: Address,
		scope: {domain: string; namespace: string},
		page: {status?: ConversationStatus; before?: string; limit: number},
	): Promise<{conversations: Conversation[]; cursor?: string}> {
		const [time, conversationID] = parseCursor(page.before);
		// two statements, so each one walks its index in order (idx_inbox_by_status, idx_inbox_all)
		const statement =
			page.status === undefined
				? this.db
						.prepare(
							`SELECT * FROM Inbox WHERE user = ?1 AND domain = ?2 AND namespace = ?3
							AND (lastMessageAt, conversationID) < (?4, ?5)
							ORDER BY lastMessageAt DESC, conversationID DESC LIMIT ?6`,
						)
						.bind(user, scope.domain, scope.namespace, time, conversationID, page.limit + 1)
				: this.db
						.prepare(
							`SELECT * FROM Inbox WHERE user = ?1 AND domain = ?2 AND namespace = ?3 AND status = ?7
							AND (lastMessageAt, conversationID) < (?4, ?5)
							ORDER BY lastMessageAt DESC, conversationID DESC LIMIT ?6`,
						)
						.bind(user, scope.domain, scope.namespace, time, conversationID, page.limit + 1, STATUS_VALUE[page.status]);
		const {results} = await statement.all<InboxRow>();
		const rows = results.slice(0, page.limit);
		const conversations = rows.map(formatConversation);
		if (results.length > page.limit) {
			const last = rows[rows.length - 1];
			return {conversations, cursor: `${last.lastMessageAt}:${last.conversationID}`};
		}
		return {conversations};
	}

	async accept(user: Address, key: ConversationKey): Promise<void> {
		await this.db
			.prepare(
				`UPDATE Inbox SET status = ${InboxStatus.Accepted}, version = ${nextVersion('?1', '?2')}
				WHERE user = ?1 AND domain = ?2 AND namespace = ?3 AND conversationID = ?4
					AND status <> ${InboxStatus.Accepted}`,
			)
			.bind(user, key.domain, key.namespace, key.conversationID)
			.all();
	}

	async reject(user: Address, key: ConversationKey, other: Address, now: number): Promise<void> {
		await this.db.batch([
			this.db
				.prepare(
					`UPDATE Inbox SET status = ${InboxStatus.Rejected}, version = ${nextVersion('?1', '?2')}
					WHERE user = ?1 AND domain = ?2 AND namespace = ?3 AND conversationID = ?4
						AND status <> ${InboxStatus.Rejected}`,
				)
				.bind(user, key.domain, key.namespace, key.conversationID),
			this.db
				.prepare(`INSERT OR IGNORE INTO Blocks (domain, user, blocked, timestamp) VALUES (?1, ?2, ?3, ?4)`)
				.bind(key.domain, user, other, now),
		]);
	}

	async unblock(user: Address, domain: string, blocked: Address): Promise<void> {
		await this.db
			.prepare(`DELETE FROM Blocks WHERE domain = ?1 AND user = ?2 AND blocked = ?3`)
			.bind(domain, user, blocked)
			.all();
	}

	async markRead(user: Address, key: ConversationKey, seq: number): Promise<void> {
		await this.db
			.prepare(
				`UPDATE Inbox SET lastReadSeq = MIN(?5, lastSeq), version = ${nextVersion('?1', '?2')}
				WHERE user = ?1 AND domain = ?2 AND namespace = ?3 AND conversationID = ?4
					AND MIN(?5, lastSeq) > lastReadSeq`,
			)
			.bind(user, key.domain, key.namespace, key.conversationID, seq)
			.all();
	}
}
