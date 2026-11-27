// The store ports of direct messaging (ADR-0005), to the contract of ADR-0006.
// The routes speak only these; each platform implements them the way it scales
// best: one SQL implementation over `remote-sql` (`sql/`) serves Node.js
// (libSQL), Bun (bun:sqlite) and, as an interim, Cloudflare (D1). One contract
// suite (`packages/server/test/store-contract.ts`) runs against every
// implementation, so a platform cannot drift silently.
import type {
	ActionEditDomainUser,
	ActionRegisterDomainUser,
	Address,
	Conversation,
	ConversationStatus,
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
			 * the inbox updates this store did NOT apply in its own transaction, for
			 * the caller to apply with `Inbox.update` (and retry). The SQL store applies
			 * both members' rows in the append's transaction and returns none; a store
			 * whose inboxes live elsewhere (Cloudflare's Inbox objects) returns them.
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
 * blocks. Its live side (pushed frames) is task `live-inbox-channel`.
 */
export interface Inbox {
	/** apply an update if its seq is above the row's `lastSeq`; a no-op otherwise */
	update(update: InboxUpdate): Promise<void>;
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

/** The three ports a server runs on. */
export type Stores = {
	keys: KeyDirectory;
	conversations: ConversationStore;
	inbox: Inbox;
};
