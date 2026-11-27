// The Inbox Durable Object (ADR-0005's Inbox on Cloudflare, to ADR-0006): one
// per (domain, user), SQLite storage. It holds the user's conversation rows in
// the domain (every namespace), their block list, and their live sockets
// (hibernatable: the session's claims are the socket's attachment, so a socket
// outlives the object's eviction), and it pushes its own frames whenever a row
// changes, so the Worker publishes nothing (`LiveInboxRouter`).
//
// Decisions recorded here (the shape is ADR-0005's and ADR-0006's; these are not):
// - The block list is this object's, and it propagates every change to each
//   Conversation object that holds a copy of it (`shared`: every conversation
//   that read it before its first append or delivered an update here, so one
//   whose messages were all hidden from this user is reached too), awaited
//   before `reject` / `unblock` answers, and retried by alarm until each
//   acknowledges. Each change has a version (one more than the last), so a
//   propagation that arrives late or twice changes nothing.
// - The user's own message to a member it blocks lifts the block (ADR-0006
//   "Sending"): when this object applies the user's own update, from a message
//   stored after the block was set, it unblocks as `unblock` does (versioned,
//   propagated and awaited), so an own update retried by alarm after a newer
//   block lifts nothing.
// - An update from a member this user blocks is refused (`{blocked: true}`),
//   whatever the Conversation object believed: the refusal makes it hide the
//   message from this user. Node/Bun's `Inbox.update` has no such check, as the
//   send's own transaction reads the block there.
// - A socket's session expiry is this object's alarm (the soonest of its
//   sockets' `exp` and of its pending propagations), since a timer does not
//   survive hibernation; at the alarm an expired socket is closed with
//   `session-expired` (4001), as on Node/Bun.
// - The heartbeat's `ping` (`@missiv/common`'s heartbeat.ts) is answered `pong`
//   by the runtime (`setWebSocketAutoResponse`), so it neither wakes this
//   object nor bills its duration. An idle socket is not closed here, as it is
//   on Node/Bun: a hibernated socket costs nothing.
// - The inbox version (`@missiv/common`'s inbox.ts) is this object's rows' own:
//   each change of a row gives it the highest row's version plus one, in the
//   statement that changes it, so `changes` (the polling transport) reads only
//   this object's storage and an unchanged poll is one indexed read. Polling
//   still costs a Worker and a Durable Object request each time, which a
//   hibernated socket does not: the socket stays the cheaper transport here.
//   An object made before the version numbers its rows by rowid (`migrate`).
import {DurableObject} from 'cloudflare:workers';
import {
	conversationIDOf,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	INBOX_CLOSE_SESSION_EXPIRED,
	INBOX_SESSION_EXPIRED_REASON,
	INBOX_WS_PROTOCOL,
	InboxSyncSchema,
	membersOfConversationID,
	type Address,
	type Conversation,
	type ConversationStatus,
	type InboxServerFrame,
	type Message,
} from '@missiv/common';
import {
	answerSync,
	inboxChangesOf,
	type ConversationKey,
	type InboxChanges,
	type InboxUpdate,
	type SessionClaims,
} from '@missiv/server';
import type {CloudflareWorkerEnv} from '../env.js';
import type {InboxApplyAnswer} from './conversation.js';
import {conversationObject, conversationKeyOf, retryDelayMs, type InboxOwner} from './names.js';

/** The header with which the Worker hands an upgrade's checked session claims to the Inbox object. */
export const SESSION_CLAIMS_HEADER = 'X-Missiv-Session-Claims';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
	namespace TEXT NOT NULL,
	conversationID TEXT NOT NULL,
	status INTEGER NOT NULL,
	lastSeq INTEGER NOT NULL,
	lastReadSeq INTEGER NOT NULL,
	lastMessageAt INTEGER NOT NULL,
	version INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (namespace, conversationID)
);
CREATE INDEX IF NOT EXISTS inbox_all ON inbox (namespace, lastMessageAt DESC, conversationID DESC);
CREATE INDEX IF NOT EXISTS inbox_by_status ON inbox (namespace, status, lastMessageAt DESC, conversationID DESC);
CREATE TABLE IF NOT EXISTS blocks (
	blocked TEXT PRIMARY KEY,
	blocking INTEGER NOT NULL,
	version INTEGER NOT NULL,
	timestamp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shared (
	namespace TEXT NOT NULL,
	conversationID TEXT NOT NULL,
	PRIMARY KEY (namespace, conversationID)
);
CREATE TABLE IF NOT EXISTS propagations (
	namespace TEXT NOT NULL,
	conversationID TEXT NOT NULL,
	blocked TEXT NOT NULL,
	blocking INTEGER NOT NULL,
	version INTEGER NOT NULL,
	attempts INTEGER NOT NULL,
	nextAttemptAt INTEGER NOT NULL,
	PRIMARY KEY (namespace, conversationID)
);
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);`;

/** The index of the inbox version, made once the column exists (an object made before it gets it in `migrate`). */
const VERSION_INDEX = `CREATE INDEX IF NOT EXISTS inbox_version ON inbox (version)`;

/** The next inbox version: one more than the highest row's (`inbox_version`), in the statement that changes the row. */
const NEXT_VERSION = `(SELECT COALESCE(MAX(version), 0) + 1 FROM inbox)`;

/** Inbox.status as stored (as the SQL store's). */
enum InboxStatus {
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

type InboxRow = {
	namespace: string;
	conversationID: string;
	status: InboxStatus;
	lastSeq: number;
	lastReadSeq: number;
	lastMessageAt: number;
	version: number;
};

type PropagationRow = {
	namespace: string;
	conversationID: string;
	blocked: Address;
	blocking: number;
	version: number;
	attempts: number;
	nextAttemptAt: number;
};

/** The upsert of a row, applied only above its `lastSeq` (idempotent and monotonic, ADR-0006), as `SQLInbox`'s. */
const UPSERT = `INSERT INTO inbox (namespace, conversationID, status, lastSeq, lastReadSeq, lastMessageAt, version)
	VALUES (?, ?, ?, ?, ?, ?, ${NEXT_VERSION})
	ON CONFLICT (namespace, conversationID) DO UPDATE SET
	status = CASE WHEN excluded.status = ${InboxStatus.Accepted} THEN ${InboxStatus.Accepted} ELSE inbox.status END,
	lastSeq = excluded.lastSeq,
	lastReadSeq = MAX(inbox.lastReadSeq, excluded.lastReadSeq),
	lastMessageAt = excluded.lastMessageAt,
	version = excluded.version
	WHERE excluded.lastSeq > inbox.lastSeq`;

export class ServerObjectInbox extends DurableObject<CloudflareWorkerEnv> {
	private sql: SqlStorage;
	private owner?: InboxOwner;
	/** each socket's syncs, answered in turn (in memory: an object with a sync in progress is not evicted) */
	private syncs = new Map<WebSocket, Promise<void>>();

	constructor(ctx: DurableObjectState, env: CloudflareWorkerEnv) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(SCHEMA);
		this.migrate();
		// the heartbeat, answered without waking this object
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
	}

	/** An object made before the inbox version gets its column, each row numbered by its rowid (unique, above 0). */
	private migrate() {
		const columns = this.sql.exec<{name: string}>(`PRAGMA table_info(inbox)`).toArray();
		if (!columns.some((column) => column.name === 'version')) {
			this.sql.exec(`ALTER TABLE inbox ADD COLUMN version INTEGER NOT NULL DEFAULT 0`);
			this.sql.exec(`UPDATE inbox SET version = rowid`);
		}
		this.sql.exec(VERSION_INDEX);
	}

	/** The Conversation object of `key` (a seam for tests). */
	protected conversationOf(key: ConversationKey) {
		return conversationObject(this.env, key);
	}

	// ------------------------------------------------------------------------------------------------
	// from the Conversation objects
	// ------------------------------------------------------------------------------------------------

	/**
	 * An inbox update from a Conversation object, with its message: applied when
	 * its seq is above the row's `lastSeq`, then the message and the row pushed to
	 * the user's sockets; refused when the update is another member's and this
	 * user blocks them. The user's own update, of a message stored after this
	 * user blocked the other member, lifts the block.
	 */
	async apply(owner: InboxOwner, update: InboxUpdate, message?: Message): Promise<InboxApplyAnswer> {
		this.remember(owner);
		const key = conversationKeyOf(update);
		this.share(key);
		const other = this.otherMember(key.conversationID);
		const block = other ? this.block(other) : undefined;
		if (!update.own && block?.blocking) {
			return {blocked: true, version: block.version};
		}
		this.upsert(update);
		const frames: InboxServerFrame[] = message ? [{type: 'message', message}] : [];
		const row = this.row(key);
		if (row) {
			frames.push({type: 'conversation', conversation: row});
		}
		this.publish(frames);
		if (update.own && other && block?.blocking && update.lastMessageAt >= block.timestamp) {
			await this.changeBlock(owner, other, false, block.version + 1, Date.now());
		}
		return {blocked: false};
	}

	/** This user's block state of `other`, for a Conversation object before its first append (which then shares it). */
	async blockState(
		owner: InboxOwner,
		key: ConversationKey,
		other: Address,
	): Promise<{blocking: boolean; version: number}> {
		this.remember(owner);
		this.share(conversationKeyOf(key));
		const block = this.block(other);
		return {blocking: !!block?.blocking, version: block?.version ?? 0};
	}

	// ------------------------------------------------------------------------------------------------
	// the Inbox port, from the Worker
	// ------------------------------------------------------------------------------------------------

	async update(owner: InboxOwner, update: InboxUpdate): Promise<void> {
		await this.apply(owner, update);
	}

	/**
	 * The rows changed after the version `since` (`Inbox.changes`), from this
	 * object's own storage alone: an unchanged poll is one indexed read here,
	 * and wakes no other object.
	 */
	async changes(owner: InboxOwner, page: {since: number; limit: number}): Promise<InboxChanges> {
		this.remember(owner);
		const version = Number(
			this.sql.exec<{version: number}>(`SELECT COALESCE(MAX(version), 0) AS version FROM inbox`).one().version,
		);
		if (page.since === version) {
			return {version, unchanged: true};
		}
		// above this inbox's version (its storage was reset): every row
		const since = page.since > version ? 0 : page.since;
		const rows = this.sql
			.exec<InboxRow>(`SELECT * FROM inbox WHERE version > ? ORDER BY version ASC LIMIT ?`, since, page.limit + 1)
			.toArray();
		return inboxChangesOf(
			rows.map((row) => this.format(row)),
			version,
			page.limit,
		);
	}

	async getConversation(owner: InboxOwner, key: ConversationKey): Promise<Conversation | undefined> {
		this.remember(owner);
		return this.row(key);
	}

	async listConversations(
		owner: InboxOwner,
		scope: {domain: string; namespace: string},
		/** `before`: the position after which the page starts, the Worker's parse of the cursor (`parseConversationCursor`) */
		page: {status?: ConversationStatus; before?: [number, string]; limit: number},
	): Promise<{conversations: Conversation[]; cursor?: string}> {
		this.remember(owner);
		const [time, conversationID] = page.before ?? [Number.MAX_SAFE_INTEGER, ''];
		const rows =
			page.status === undefined
				? this.sql
						.exec<InboxRow>(
							`SELECT * FROM inbox WHERE namespace = ? AND (lastMessageAt, conversationID) < (?, ?)
							ORDER BY lastMessageAt DESC, conversationID DESC LIMIT ?`,
							scope.namespace,
							time,
							conversationID,
							page.limit + 1,
						)
						.toArray()
				: this.sql
						.exec<InboxRow>(
							`SELECT * FROM inbox WHERE namespace = ? AND status = ? AND (lastMessageAt, conversationID) < (?, ?)
							ORDER BY lastMessageAt DESC, conversationID DESC LIMIT ?`,
							scope.namespace,
							STATUS_VALUE[page.status],
							time,
							conversationID,
							page.limit + 1,
						)
						.toArray();
		const kept = rows.slice(0, page.limit);
		const conversations = kept.map((row) => this.format(row));
		if (rows.length > page.limit) {
			const last = kept[kept.length - 1];
			return {conversations, cursor: `${last.lastMessageAt}:${last.conversationID}`};
		}
		return {conversations};
	}

	async accept(owner: InboxOwner, key: ConversationKey): Promise<void> {
		this.remember(owner);
		this.sql.exec(
			`UPDATE inbox SET status = ${InboxStatus.Accepted}, version = ${NEXT_VERSION}
			WHERE namespace = ? AND conversationID = ? AND status <> ${InboxStatus.Accepted}`,
			key.namespace,
			key.conversationID,
		);
		this.publishRow(key);
	}

	/** Reject the conversation and block `other` in the domain: the block reaches every conversation shared with them before this answers. */
	async reject(owner: InboxOwner, key: ConversationKey, other: Address, now: number): Promise<void> {
		this.remember(owner);
		this.share(conversationKeyOf(key));
		this.sql.exec(
			`UPDATE inbox SET status = ${InboxStatus.Rejected}, version = ${NEXT_VERSION}
			WHERE namespace = ? AND conversationID = ? AND status <> ${InboxStatus.Rejected}`,
			key.namespace,
			key.conversationID,
		);
		const block = this.block(other);
		if (!block?.blocking) {
			await this.changeBlock(owner, other, true, (block?.version ?? 0) + 1, now);
		}
		this.publishRow(key);
	}

	async unblock(owner: InboxOwner, blocked: Address): Promise<void> {
		this.remember(owner);
		const block = this.block(blocked);
		if (block?.blocking) {
			await this.changeBlock(owner, blocked, false, block.version + 1, Date.now());
		}
	}

	async markRead(owner: InboxOwner, key: ConversationKey, seq: number): Promise<void> {
		this.remember(owner);
		this.sql.exec(
			`UPDATE inbox SET lastReadSeq = MIN(?, lastSeq), version = ${NEXT_VERSION}
			WHERE namespace = ? AND conversationID = ? AND MIN(?, lastSeq) > lastReadSeq`,
			seq,
			key.namespace,
			key.conversationID,
			seq,
		);
		this.publishRow(key);
	}

	// ------------------------------------------------------------------------------------------------
	// the live side
	// ------------------------------------------------------------------------------------------------

	/** whether the user has a socket open whose session has not expired */
	async isOnline(owner: InboxOwner): Promise<boolean> {
		this.remember(owner);
		const now = Date.now();
		return this.ctx.getWebSockets().some((ws) => (claimsOf(ws)?.exp ?? 0) > now);
	}

	/** An upgrade whose token the Worker checked (its claims in `SESSION_CLAIMS_HEADER`): the socket, hibernatable. */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('expected a websocket upgrade', {status: 426});
		}
		const claims = JSON.parse(request.headers.get(SESSION_CLAIMS_HEADER) ?? 'null') as SessionClaims | null;
		if (!claims) {
			return new Response('no session', {status: 401});
		}
		this.remember({domain: claims.domain, user: claims.account});
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		// the session survives the object's hibernation with the socket
		server.serializeAttachment(claims);
		await this.schedule();
		return new Response(null, {status: 101, webSocket: client, headers: {'Sec-WebSocket-Protocol': INBOX_WS_PROTOCOL}});
	}

	async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
		const claims = claimsOf(ws);
		if (!claims || claims.exp <= Date.now()) {
			closeQuietly(ws, INBOX_CLOSE_SESSION_EXPIRED, INBOX_SESSION_EXPIRED_REASON);
			return;
		}
		const previous = this.syncs.get(ws) ?? Promise.resolve();
		const next = previous
			.then(() => this.answer(ws, claims, data))
			.catch((err) => console.error(`inbox: a sync failed`, err));
		this.syncs.set(ws, next);
		await next;
		if (this.syncs.get(ws) === next) {
			this.syncs.delete(ws);
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		this.syncs.delete(ws);
		// complete the closing handshake (Cloudflare's "Use WebSockets": reply with close())
		if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) {
			closeQuietly(ws, code, reason);
		} else {
			closeQuietly(ws);
		}
		await this.schedule();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.syncs.delete(ws);
		await this.schedule();
	}

	/** Close the sockets whose session expired, retry the pending propagations, schedule the next alarm. Never throws. */
	async alarm(): Promise<void> {
		try {
			const now = Date.now();
			for (const ws of this.ctx.getWebSockets()) {
				const claims = claimsOf(ws);
				if (!claims || claims.exp <= now) {
					closeQuietly(ws, INBOX_CLOSE_SESSION_EXPIRED, INBOX_SESSION_EXPIRED_REASON);
				}
			}
			const owner = this.loadOwner();
			if (owner) {
				// every pending one, not only the soonest's (a propagation is idempotent)
				const due = this.sql.exec<PropagationRow>(`SELECT * FROM propagations`).toArray();
				await Promise.all(due.map((row) => this.propagate(owner, row)));
			}
		} catch (err) {
			console.error(`inbox: the alarm failed`, err);
		} finally {
			await this.schedule();
		}
	}

	private async answer(ws: WebSocket, claims: SessionClaims, data: string | ArrayBuffer): Promise<void> {
		let frame: unknown;
		try {
			frame = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
		} catch {
			frame = undefined;
		}
		const sync = InboxSyncSchema.safeParse(frame);
		if (!sync.success) {
			// 1008: policy violation; nothing but a sync is expected
			closeQuietly(ws, 1008, 'expected a sync frame');
			return;
		}
		await answerSync(
			{
				conversations: {
					listMessages: (reader, key, page) =>
						this.conversationOf(key).listMessages(conversationKeyOf(key), reader, page) as Promise<{
							messages: Message[];
							hasMore: boolean;
						}>,
				},
				inbox: {
					getConversation: async (_user, key) => this.row(key),
					update: async (update) => {
						await this.apply({domain: claims.domain, user: claims.account}, update);
					},
				},
			},
			claims,
			sync.data,
			(frame) => ws.send(JSON.stringify(frame)),
			() => ws.readyState === 1, // OPEN
		);
	}

	// ------------------------------------------------------------------------------------------------
	// blocks and their propagation
	// ------------------------------------------------------------------------------------------------

	private async changeBlock(owner: InboxOwner, other: Address, blocking: boolean, version: number, now: number) {
		this.sql.exec(
			`INSERT INTO blocks (blocked, blocking, version, timestamp) VALUES (?, ?, ?, ?)
			ON CONFLICT (blocked) DO UPDATE SET blocking = excluded.blocking, version = excluded.version, timestamp = excluded.timestamp`,
			other,
			blocking ? 1 : 0,
			version,
			now,
		);
		// every conversation with them, in every namespace, that holds a copy of this block state
		const conversationID = conversationIDOf([owner.user, other]);
		const namespaces = this.sql
			.exec<{namespace: string}>(`SELECT namespace FROM shared WHERE conversationID = ?`, conversationID)
			.toArray();
		const rows: PropagationRow[] = namespaces.map(({namespace}) => ({
			namespace,
			conversationID,
			blocked: other,
			blocking: blocking ? 1 : 0,
			version,
			attempts: 0,
			nextAttemptAt: Date.now() + 1000,
		}));
		for (const row of rows) {
			this.sql.exec(
				`INSERT OR REPLACE INTO propagations (namespace, conversationID, blocked, blocking, version, attempts, nextAttemptAt)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
				row.namespace,
				row.conversationID,
				row.blocked,
				row.blocking,
				row.version,
				row.attempts,
				row.nextAttemptAt,
			);
		}
		await this.schedule();
		await Promise.all(rows.map((row) => this.propagate(owner, row)));
		await this.schedule();
	}

	private async propagate(owner: InboxOwner, row: PropagationRow): Promise<void> {
		const key = {domain: owner.domain, namespace: row.namespace, conversationID: row.conversationID};
		try {
			await this.conversationOf(key).setBlock(key, owner.user, row.blocking === 1, row.version);
			this.sql.exec(
				`DELETE FROM propagations WHERE namespace = ? AND conversationID = ? AND version = ?`,
				row.namespace,
				row.conversationID,
				row.version,
			);
		} catch (err) {
			console.error(`inbox: a block propagation failed, retried by alarm`, err);
			const attempts = row.attempts + 1;
			this.sql.exec(
				`UPDATE propagations SET attempts = ?, nextAttemptAt = ? WHERE namespace = ? AND conversationID = ? AND version = ?`,
				attempts,
				Date.now() + retryDelayMs(attempts),
				row.namespace,
				row.conversationID,
				row.version,
			);
		}
	}

	/** The alarm at the soonest of the sockets' session expiry and the propagations' next attempt; none when neither. */
	private async schedule(): Promise<void> {
		const now = Date.now();
		let next = this.sql.exec<{next: number | null}>(`SELECT MIN(nextAttemptAt) AS next FROM propagations`).one().next;
		for (const ws of this.ctx.getWebSockets()) {
			const exp = claimsOf(ws)?.exp;
			if (exp !== undefined && exp > now && (next === null || exp < next)) {
				next = exp;
			}
		}
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
		} else {
			await this.ctx.storage.setAlarm(next);
		}
	}

	private block(other: Address): {blocking: boolean; version: number; timestamp: number} | undefined {
		const rows = this.sql
			.exec<{
				blocking: number;
				version: number;
				timestamp: number;
			}>(`SELECT blocking, version, timestamp FROM blocks WHERE blocked = ?`, other)
			.toArray();
		return rows[0]
			? {blocking: rows[0].blocking === 1, version: Number(rows[0].version), timestamp: Number(rows[0].timestamp)}
			: undefined;
	}

	/** remember that this conversation's object holds a copy of this inbox's block state */
	private share(key: ConversationKey) {
		this.sql.exec(
			`INSERT OR IGNORE INTO shared (namespace, conversationID) VALUES (?, ?)`,
			key.namespace,
			key.conversationID,
		);
	}

	// ------------------------------------------------------------------------------------------------
	// rows and frames
	// ------------------------------------------------------------------------------------------------

	private upsert(update: InboxUpdate) {
		this.sql.exec(
			UPSERT,
			update.namespace,
			update.conversationID,
			update.own ? InboxStatus.Accepted : InboxStatus.Unaccepted,
			update.seq,
			update.own ? update.seq : 0,
			update.lastMessageAt,
		);
	}

	private row(key: {namespace: string; conversationID: string}): Conversation | undefined {
		const rows = this.sql
			.exec<InboxRow>(
				`SELECT * FROM inbox WHERE namespace = ? AND conversationID = ?`,
				key.namespace,
				key.conversationID,
			)
			.toArray();
		return rows[0] ? this.format(rows[0]) : undefined;
	}

	private format(row: InboxRow): Conversation {
		return {
			domain: this.owner?.domain ?? this.loadOwner()?.domain ?? '',
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

	private publishRow(key: ConversationKey) {
		const row = this.row(key);
		if (row) {
			this.publish([{type: 'conversation', conversation: row}]);
		}
	}

	/** the frames to every open socket of the user (none: nothing happens) */
	private publish(frames: InboxServerFrame[]) {
		const sockets = this.ctx.getWebSockets();
		if (sockets.length === 0 || frames.length === 0) {
			return;
		}
		const data = frames.map((frame) => JSON.stringify(frame));
		for (const ws of sockets) {
			for (const text of data) {
				try {
					ws.send(text);
				} catch (err) {
					// a socket closing as we send: its close removes it
					console.error(`inbox: a send failed`, err);
				}
			}
		}
	}

	private otherMember(conversationID: string): Address | undefined {
		const members = membersOfConversationID(conversationID);
		const user = this.owner?.user.toLowerCase();
		return members?.find((member) => member.toLowerCase() !== user);
	}

	/** the (domain, user) this object is, from the first call that named it (the alarm has no argument) */
	private remember(owner: InboxOwner) {
		if (!this.owner) {
			this.owner = {domain: owner.domain, user: owner.user};
			this.sql.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('owner', ?)`, JSON.stringify(this.owner));
		}
	}

	private loadOwner(): InboxOwner | undefined {
		if (!this.owner) {
			const rows = this.sql.exec<{value: string}>(`SELECT value FROM meta WHERE key = 'owner'`).toArray();
			this.owner = rows[0] ? (JSON.parse(rows[0].value) as InboxOwner) : undefined;
		}
		return this.owner;
	}
}

function claimsOf(ws: WebSocket): SessionClaims | undefined {
	return (ws.deserializeAttachment() as SessionClaims | null) ?? undefined;
}

function closeQuietly(ws: WebSocket, code?: number, reason?: string) {
	try {
		if (code === undefined) {
			ws.close();
		} else {
			ws.close(code, reason);
		}
	} catch {
		// already closed
	}
}
