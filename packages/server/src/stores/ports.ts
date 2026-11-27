// The store ports of direct messaging (ADR-0005), to the contract of ADR-0006.
// The routes speak only these; each platform implements them the way it scales
// best: one SQL implementation over `remote-sql` (`sql/`) serves Node.js
// (libSQL) and Bun (bun:sqlite); Cloudflare has D1 for the KeyDirectory and a
// Durable Object per conversation and per inbox (`platforms/cf-worker/src/stores/`).
// One contract suite (`packages/server/test/store-contract.ts`) runs against
// every implementation, so a platform cannot drift silently.
import type {SessionClaims} from '../session.js';
import type {
	ActionEditDomainUser,
	ActionRegisterDomainUser,
	Address,
	Conversation,
	ConversationStatus,
	InboxServerFrame,
	ResponseInboxChanges,
	Message,
	MessageToSend,
	PublicKey,
	ResponseGetDomainUser,
	ResponseGetKeySet,
	String0x,
} from '@missiv/common';

/** Where a conversation is: every table, cursor and sequence space is keyed by the triple (ADR-0006). */
export type ConversationKey = {domain: string; namespace: string; conversationID: string};

/**
 * KeyDirectory: domain users, their key sets and the wallets' ownership
 * signatures over them. Read-heavy, rarely written. It also holds the small
 * replay set of the two signed routes that must not run twice (`/session`,
 * `register`, ADR-0006 "Sessions and replay"), since both live next to the
 * directory on every platform (D1 on Cloudflare).
 */
export interface KeyDirectory {
	/** register (or replace) the current key set of (address, domain); 409 `conflict` for a key set of another (user, domain) */
	register(address: Address, keyRef: String0x, timestampMS: number, action: ActionRegisterDomainUser): Promise<void>;
	editUser(address: Address, timestampMS: number, action: ActionEditDomainUser): Promise<void>;
	/** the account's current key set in the domain and its profile there */
	getDomainUser(domain: string, address: Address): Promise<ResponseGetDomainUser>;
	/** the domain user whose CURRENT key set has this signing key: none for a replaced one */
	getDomainUserBySigningKey(signingKey: PublicKey): Promise<ResponseGetDomainUser>;
	/** a key set registered in the domain, current or replaced */
	getKeySet(domain: string, keyRef: String0x): Promise<ResponseGetKeySet>;
	/** record a request signature until `expiresAt`; false when it was already recorded (a replay) */
	acceptRequestSignature(signature: string, expiresAt: number, now: number): Promise<boolean>;
}

/**
 * What one member's inbox row must become after a message: applied only when
 * `seq` is above the row's `lastSeq` (idempotent and monotonic, ADR-0006), so a
 * retried or reordered update changes nothing.
 */
export type InboxUpdate = ConversationKey & {
	user: Address;
	seq: number;
	lastMessageAt: number;
	/**
	 * the sender's own message: its row becomes (or starts) `accepted`, read up
	 * to `seq`; the recipient's starts `unaccepted` and keeps its status and
	 * `lastReadSeq`
	 */
	own: boolean;
};

/** What `Inbox.changes` answers: the wire's `ResponseInboxChanges`. */
export type InboxChanges = ResponseInboxChanges;

/** A recipient a new message is pushed to: registered in the domain, not the sender, not one who blocked them. */
export type PushRecipient = {address: Address; appOrigin: string};

export type AppendResult =
	/** stored under the next seq */
	| {
			status: 'appended';
			message: Message;
			/** the member it is hidden from (one who blocked the sender), if any */
			hiddenFrom?: Address;
			/** whom to push it to: loaded in the send itself, no further read */
			pushTo: PushRecipient[];
			/**
			 * the inbox updates this store did NOT apply and does not own, for the
			 * caller to apply with `Inbox.update`. The SQL store applies both members'
			 * rows in the append's transaction and returns none; Cloudflare's
			 * Conversation object applies them itself on the members' Inbox objects
			 * and retries them by alarm until acknowledged, so it returns none either.
			 * A store that leaves its members' inboxes to the caller returns them.
			 */
			pendingInboxUpdates: InboxUpdate[];
	  }
	/** a retry: this messageID is stored with the same signature */
	| {status: 'duplicate'; message: Message}
	/** this messageID is stored with another signature */
	| {status: 'conflict'};

/**
 * ConversationStore: per conversation `(domain, namespace, conversationID)`, its
 * messages, appended with a per-conversation seq the store assigns. The one
 * serialization point of a conversation.
 */
export interface ConversationStore {
	/**
	 * Append a message checked by the caller (signature, window, sender), from
	 * `sender` to `recipient` (a 1:1 conversation): dedup by messageID, the
	 * domain-level block check (a message from a sender the recipient blocked is
	 * stored hidden from the recipient and acknowledged as any other), the next
	 * seq, and the members' inbox rows. Statements bounded, whatever the history.
	 */
	append(message: MessageToSend, members: {sender: Address; recipient: Address}, now: number): Promise<AppendResult>;
	/** a page of messages for `reader`, by seq (see `ActionListMessages`), never one hidden from it */
	listMessages(
		reader: Address,
		key: ConversationKey,
		page: {after?: number; before?: number; limit: number},
	): Promise<{messages: Message[]; hasMore: boolean}>;
}

/**
 * Inbox: per user, their conversation list (ordered by last message, filtered
 * by status, with unread state from `lastReadSeq`) and their domain-level
 * blocks. Its live side (pushed frames) is `LiveInbox`.
 *
 * Every change of a row gives it the user's next inbox version in the domain
 * (`Conversation.version`, `@missiv/common`'s inbox.ts): a write that changes
 * nothing (an update at or below `lastSeq`, an accept of an accepted row, a
 * markRead that reads nothing new) takes none, and `unblock` changes no row.
 */
export interface Inbox {
	/** apply an update if its seq is above the row's `lastSeq`; a no-op otherwise */
	update(update: InboxUpdate): Promise<void>;
	/**
	 * the user's rows in `domain` (every namespace) changed after the version
	 * `since`, oldest change first, at most `limit` (the polling transport,
	 * `POST /api/inbox/changes`): `unchanged` when none did; every row when
	 * `since` is above the inbox's version
	 */
	changes(user: Address, domain: string, page: {since: number; limit: number}): Promise<InboxChanges>;
	/** one row of the user's inbox (what a `conversation` frame carries), if the user has it */
	getConversation(user: Address, key: ConversationKey): Promise<Conversation | undefined>;
	listConversations(
		user: Address,
		scope: {domain: string; namespace: string},
		page: {status?: ConversationStatus; before?: string; limit: number},
	): Promise<{conversations: Conversation[]; cursor?: string}>;
	accept(user: Address, key: ConversationKey): Promise<void>;
	/** reject the conversation and block `other` in the domain */
	reject(user: Address, key: ConversationKey, other: Address, now: number): Promise<void>;
	unblock(user: Address, domain: string, blocked: Address): Promise<void>;
	/** lastReadSeq = max(lastReadSeq, min(seq, lastSeq)) */
	markRead(user: Address, key: ConversationKey, seq: number): Promise<void>;
}

/**
 * The Inbox's live side (ADR-0005, ADR-0006 "Live channel"): the frames pushed
 * to a user's open sockets in a domain. On Node.js and Bun an in-process
 * registry of the sockets (`createInProcessLiveInbox`); this interface is the
 * seam a fan-out bus between several instances would implement (none is built:
 * spec `scalable-direct-messaging`, out of scope), which is why both calls are
 * asynchronous although the in-process one is not.
 */
export interface LiveInbox {
	/** push `frames` to every socket of `user` in `domain` (none open: nothing happens) */
	publish(domain: string, user: Address, frames: InboxServerFrame[]): Promise<void>;
	/** whether `user` has an open socket in `domain` (to skip a Web Push, `PUSH_SKIP_WHEN_ONLINE`) */
	isOnline(domain: string, user: Address): Promise<boolean>;
}

/** A socket of the live channel, as a platform's WebSocket server hands it over. */
export type LiveConnection = {
	send(data: string): void;
	close(code: number, reason: string): void;
};

/**
 * A live inbox whose sockets are held elsewhere, by an object that also pushes
 * its own frames whenever the inbox changes (Cloudflare: the user's Inbox
 * Durable Object, which holds its sockets and its rows). The server checks the
 * session token at the upgrade and hands the request over; it publishes
 * nothing itself. `isOnline` is for the push skip (`PUSH_SKIP_WHEN_ONLINE`).
 */
export interface LiveInboxRouter {
	isOnline(domain: string, user: Address): Promise<boolean>;
	/** the response to an upgrade request whose token has been checked: the socket, accepted where the user's inbox is */
	accept(request: Request, claims: SessionClaims): Promise<Response>;
}

/** A `LiveInbox` that also holds the sockets accepted by this process. */
export interface LiveInboxHost extends LiveInbox {
	/** add an accepted socket of (`domain`, `user`); returns what removes it */
	connect(domain: string, user: Address, connection: LiveConnection): () => void;
}

/** The three ports a server runs on. */
export type Stores = {
	keys: KeyDirectory;
	conversations: ConversationStore;
	inbox: Inbox;
};
