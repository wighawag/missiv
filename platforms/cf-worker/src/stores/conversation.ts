// The Conversation Durable Object (ADR-0005's ConversationStore on Cloudflare,
// to ADR-0006): one per (domain, namespace, conversationID), SQLite storage.
// It is the conversation's one serialization point: the dedup by messageID,
// the block check and the next seq run in one synchronous step (no `await`
// between them, so no other call to this object runs in between), and the
// members' Inbox objects are then updated from an outbox, retried by alarm
// until each acknowledges.
//
// Decisions recorded here (the shape is ADR-0005's and ADR-0006's; these are not):
// - The append awaits its inbox updates before it answers (one call to each
//   member's Inbox object, in parallel), so a send that succeeds has, in the
//   normal case, updated both lists, as one SQL transaction does on Node/Bun.
//   A failed update does not fail the send: it stays in the outbox and the
//   alarm retries it (1 s, doubling, at most 5 min apart, without end: an
//   Inbox object is never gone for good). Alternative: answer at once and
//   update the inboxes after the response (`waitUntil`); rejected, a client
//   listing its conversations right after a send would not see it.
// - The outbox holds one row per (member, seq), delivered to a member in seq
//   order, so every update reaches its Inbox (which applies only one above its
//   `lastSeq`) and every message is pushed to the member's sockets once its
//   update is delivered; an older update after a newer one is a no-op there.
//   Alternative: one row per member, the newest; rejected, the newest can lose
//   what an older one carried (the sender's own message accepts its row).
// - The block state is a copy: each member's Inbox object owns its block list
//   (ADR-0006 "Sending"). It is read from both Inboxes before this object's
//   first append, kept current by the Inboxes' propagation (`setBlock`,
//   versioned, so a late or repeated one changes nothing), and checked again by
//   the recipient's Inbox at every update: one that answers `blocked` makes
//   this object hide the message from it and record the block, which closes the
//   window between a block and its propagation.
import {DurableObject} from 'cloudflare:workers';
import type {Address, Message, MessageToSend} from '@missiv/common';
import type {AppendResult, ConversationKey, InboxUpdate} from '@missiv/server';
import type {CloudflareWorkerEnv} from '../env.js';
import {conversationKeyOf, inboxObject, retryDelayMs} from './names.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
	seq INTEGER PRIMARY KEY,
	messageID TEXT NOT NULL UNIQUE,
	sender TEXT NOT NULL,
	senderKeyRef TEXT NOT NULL,
	scheme TEXT NOT NULL,
	keyID TEXT,
	content TEXT NOT NULL,
	signature TEXT NOT NULL,
	serverTimestamp INTEGER NOT NULL,
	hiddenFrom TEXT
);
CREATE TABLE IF NOT EXISTS blocks (
	blocker TEXT PRIMARY KEY,
	blocking INTEGER NOT NULL,
	version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
	user TEXT NOT NULL,
	seq INTEGER NOT NULL,
	own INTEGER NOT NULL,
	attempts INTEGER NOT NULL,
	nextAttemptAt INTEGER NOT NULL,
	PRIMARY KEY (user, seq)
);
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);`;

type MessageRow = {
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

type OutboxRow = {user: Address; seq: number; own: number; attempts: number; nextAttemptAt: number};

/** What the object answers an append with: an `AppendResult` but what the Worker adds (the push recipients). */
export type ConversationAppendResult =
	| {status: 'appended'; message: Message; hiddenFrom?: Address}
	| Exclude<AppendResult, {status: 'appended'}>;

/** What an Inbox object answers an update with: whether it refused it because its owner blocks the sender. */
export type InboxApplyAnswer = {blocked: false} | {blocked: true; version: number};

/** How long the first attempt of an inbox update may take before the alarm retries it. */
const FIRST_RETRY_MS = 1000;

export class ServerObjectConversation extends DurableObject<CloudflareWorkerEnv> {
	private sql: SqlStorage;
	/** the read of both members' block states before the first append, shared by the appends that wait for it */
	private readingBlocks?: Promise<void>;

	constructor(ctx: DurableObjectState, env: CloudflareWorkerEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(SCHEMA);
	}

	/** The Inbox object of `user` (a seam: a test replaces it to fail an update). */
	protected inboxOf(domain: string, user: Address) {
		return inboxObject(this.env, domain, user);
	}

	async append(
		key: ConversationKey,
		message: MessageToSend,
		members: {sender: Address; recipient: Address},
		now: number,
	): Promise<ConversationAppendResult> {
		this.remember(key);
		const known = this.dedup(message);
		if (known) {
			return known;
		}
		await this.readBlocks(key, members);

		// from here to the outbox, nothing awaits: one step of this object
		const again = this.dedup(message);
		if (again) {
			return again;
		}
		const hidden = this.blocks(members.recipient);
		const seq = Number(this.sql.exec<{seq: number}>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM messages`).one().seq) + 1;
		this.sql.exec(
			`INSERT INTO messages (seq, messageID, sender, senderKeyRef, scheme, keyID, content, signature, serverTimestamp, hiddenFrom)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			seq,
			message.messageID,
			members.sender,
			message.senderKeyRef,
			message.scheme,
			message.keyID,
			message.content,
			message.signature,
			now,
			hidden ? members.recipient : null,
		);
		const retryAt = Date.now() + FIRST_RETRY_MS;
		const rows: OutboxRow[] = [{user: members.sender, seq, own: 1, attempts: 0, nextAttemptAt: retryAt}];
		if (!hidden) {
			rows.push({user: members.recipient, seq, own: 0, attempts: 0, nextAttemptAt: retryAt});
		}
		for (const row of rows) {
			this.sql.exec(
				`INSERT OR IGNORE INTO outbox (user, seq, own, attempts, nextAttemptAt) VALUES (?, ?, ?, ?, ?)`,
				row.user,
				row.seq,
				row.own,
				row.attempts,
				row.nextAttemptAt,
			);
		}
		// the safety net, before any call out: if this object stops now, the alarm delivers
		await this.schedule();

		const stored = this.message(seq)!;
		const answers = await Promise.all(rows.map((row) => this.deliver(key, row)));
		await this.schedule();
		const refused = answers.some((answer, i) => answer === 'blocked' && rows[i].user === members.recipient);
		const hiddenFrom = hidden || refused ? members.recipient : undefined;
		return {status: 'appended', message: stored, ...(hiddenFrom ? {hiddenFrom} : {})};
	}

	/** A page of messages for `reader`, by seq, never one hidden from it (as `SQLConversationStore.listMessages`). */
	async listMessages(
		key: ConversationKey,
		reader: Address,
		page: {after?: number; before?: number; limit: number},
	): Promise<{messages: Message[]; hasMore: boolean}> {
		this.remember(key);
		const forward = page.after !== undefined;
		const rows = this.sql
			.exec<MessageRow>(
				forward
					? `SELECT * FROM messages WHERE seq > ? AND (hiddenFrom IS NULL OR hiddenFrom <> ?) ORDER BY seq ASC LIMIT ?`
					: `SELECT * FROM messages WHERE seq < ? AND (hiddenFrom IS NULL OR hiddenFrom <> ?) ORDER BY seq DESC LIMIT ?`,
				forward ? page.after! : (page.before ?? Number.MAX_SAFE_INTEGER),
				reader,
				page.limit + 1,
			)
			.toArray();
		const messages = rows.slice(0, page.limit).map((row) => this.format(key, row));
		return {messages: forward ? messages : messages.reverse(), hasMore: rows.length > page.limit};
	}

	/** A member's Inbox tells its block state of the other member (propagation); a version not above the stored one changes nothing. */
	async setBlock(key: ConversationKey, blocker: Address, blocking: boolean, version: number): Promise<void> {
		this.remember(key);
		this.recordBlock(blocker, blocking, version);
	}

	/**
	 * Retry every inbox update still in the outbox, each member's in seq order,
	 * then schedule the next attempt. The alarm is set at the soonest row's
	 * attempt; the others are tried with it (early, which costs nothing: an
	 * update is idempotent). Never throws, so the runtime's own alarm retries
	 * (six, then it gives up) never apply: this object reschedules itself.
	 */
	async alarm(): Promise<void> {
		try {
			const key = this.key();
			if (!key) {
				return;
			}
			const due = this.sql.exec<OutboxRow>(`SELECT * FROM outbox ORDER BY user, seq`).toArray();
			const byUser = new Map<string, OutboxRow[]>();
			for (const row of due) {
				byUser.set(row.user, [...(byUser.get(row.user) ?? []), row]);
			}
			await Promise.all(
				[...byUser.values()].map(async (rows) => {
					for (const row of rows) {
						if ((await this.deliver(key, row)) === 'failed') {
							break;
						}
					}
				}),
			);
		} catch (err) {
			console.error(`conversation: the alarm failed`, err);
		} finally {
			await this.schedule();
		}
	}

	/** One update to its member's Inbox: acknowledged (removed from the outbox), refused for a block, or failed (retried later). */
	private async deliver(key: ConversationKey, row: OutboxRow): Promise<'delivered' | 'blocked' | 'failed'> {
		const stored = this.message(row.seq);
		if (!stored) {
			this.sql.exec(`DELETE FROM outbox WHERE user = ? AND seq = ?`, row.user, row.seq);
			return 'delivered';
		}
		const update: InboxUpdate = {
			...conversationKeyOf(key),
			user: row.user,
			seq: row.seq,
			lastMessageAt: stored.serverTimestamp,
			own: row.own === 1,
		};
		try {
			const answer = (await this.inboxOf(key.domain, row.user).apply(
				{domain: key.domain, user: row.user},
				update,
				stored,
			)) as InboxApplyAnswer;
			this.sql.exec(`DELETE FROM outbox WHERE user = ? AND seq = ?`, row.user, row.seq);
			if (answer.blocked) {
				// the recipient blocks the sender: hide it from them, and remember the block
				this.recordBlock(row.user, true, answer.version);
				this.sql.exec(
					`UPDATE messages SET hiddenFrom = ? WHERE seq = ? AND sender <> ? AND hiddenFrom IS NULL`,
					row.user,
					row.seq,
					row.user,
				);
				return 'blocked';
			}
			return 'delivered';
		} catch (err) {
			console.error(`conversation: an inbox update failed, retried by alarm`, err);
			const attempts = row.attempts + 1;
			this.sql.exec(
				`UPDATE outbox SET attempts = ?, nextAttemptAt = ? WHERE user = ? AND seq = ?`,
				attempts,
				Date.now() + retryDelayMs(attempts),
				row.user,
				row.seq,
			);
			return 'failed';
		}
	}

	/** The alarm at the outbox's next due attempt, or none when it is empty. */
	private async schedule(): Promise<void> {
		const next = this.sql.exec<{next: number | null}>(`SELECT MIN(nextAttemptAt) AS next FROM outbox`).one().next;
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
		} else {
			await this.ctx.storage.setAlarm(next);
		}
	}

	/** Before the first append: both members' block states, read from their Inbox objects (ADR-0006 "Sending"). */
	private async readBlocks(key: ConversationKey, members: {sender: Address; recipient: Address}): Promise<void> {
		if (this.meta('blocksRead')) {
			return;
		}
		if (!this.readingBlocks) {
			this.readingBlocks = (async () => {
				const conversation = conversationKeyOf(key);
				const [ofSender, ofRecipient] = await Promise.all([
					this.inboxOf(key.domain, members.sender).blockState(
						{domain: key.domain, user: members.sender},
						conversation,
						members.recipient,
					),
					this.inboxOf(key.domain, members.recipient).blockState(
						{domain: key.domain, user: members.recipient},
						conversation,
						members.sender,
					),
				]);
				this.recordBlock(members.sender, ofSender.blocking, ofSender.version);
				this.recordBlock(members.recipient, ofRecipient.blocking, ofRecipient.version);
				this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('blocksRead', '1')`);
			})().finally(() => {
				this.readingBlocks = undefined;
			});
		}
		await this.readingBlocks;
	}

	private recordBlock(blocker: Address, blocking: boolean, version: number) {
		this.sql.exec(
			`INSERT INTO blocks (blocker, blocking, version) VALUES (?, ?, ?)
			ON CONFLICT (blocker) DO UPDATE SET blocking = excluded.blocking, version = excluded.version
			WHERE excluded.version > blocks.version`,
			blocker,
			blocking ? 1 : 0,
			version,
		);
	}

	/** whether `blocker` blocks the other member */
	private blocks(blocker: Address): boolean {
		const rows = this.sql.exec<{blocking: number}>(`SELECT blocking FROM blocks WHERE blocker = ?`, blocker).toArray();
		return rows.length > 0 && rows[0].blocking === 1;
	}

	/** a retry (same signature: the stored message) or a conflict, when the messageID is stored */
	private dedup(message: MessageToSend): ConversationAppendResult | undefined {
		const rows = this.sql.exec<MessageRow>(`SELECT * FROM messages WHERE messageID = ?`, message.messageID).toArray();
		if (rows.length === 0) {
			return undefined;
		}
		if (rows[0].signature !== message.signature) {
			return {status: 'conflict'};
		}
		return {status: 'duplicate', message: this.format(this.key()!, rows[0])};
	}

	private message(seq: number): Message | undefined {
		const rows = this.sql.exec<MessageRow>(`SELECT * FROM messages WHERE seq = ?`, seq).toArray();
		return rows[0] ? this.format(this.key()!, rows[0]) : undefined;
	}

	private format(key: ConversationKey, row: MessageRow): Message {
		return {
			domain: key.domain,
			namespace: key.namespace,
			conversationID: key.conversationID,
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

	private cachedKey?: ConversationKey;

	/** the conversation this object is, from the first call that named it (the alarm has no argument) */
	private remember(key: ConversationKey) {
		if (!this.cachedKey) {
			this.cachedKey = conversationKeyOf(key);
			this.sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('key', ?)`, JSON.stringify(this.cachedKey));
		}
	}

	private key(): ConversationKey | undefined {
		if (!this.cachedKey) {
			const value = this.meta('key');
			this.cachedKey = value ? (JSON.parse(value) as ConversationKey) : undefined;
		}
		return this.cachedKey;
	}

	private meta(name: string): string | undefined {
		const rows = this.sql.exec<{value: string}>(`SELECT value FROM meta WHERE key = ?`, name).toArray();
		return rows[0]?.value;
	}
}
