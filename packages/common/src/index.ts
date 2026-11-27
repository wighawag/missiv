// missiv's protocol: every request and response of the HTTP API as a zod schema,
// with its TypeScript type inferred from it, so the server validates exactly what
// the client is typed against. One source; nothing here is declared twice.
import {z} from 'zod';
import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex} from '@noble/hashes/utils';
import type {PublicKeySet} from 'delegated-identity';
import {MessageToSendSchema, type Message} from './message.js';

// ------------------------------------------------------------------------------------------------
// primitives
// ------------------------------------------------------------------------------------------------

export type String0x = `0x${string}`;
export type PublicKey = String0x;
export type Address = String0x;
/** A 32-byte key, as 0x-prefixed lowercase hex. */
export type Key = String0x;
export type {KeySet, PublicKeySet} from 'delegated-identity';

/** lowercase 0x-prefixed hex */
export const String0xSchema = z.custom<String0x>(
	(v) => typeof v === 'string' && v.length <= 1024 && /^0x[a-f0-9]+$/.test(v),
	{message: 'expected lowercase 0x-prefixed hex'},
);
export const AddressSchema = String0xSchema;
export const PublicKeySchema = String0xSchema;

const DomainSchema = z.string().min(1).max(253);
const NamespaceSchema = z.string().max(64);
const ConversationIDSchema = z.string().min(1).max(256);

// ------------------------------------------------------------------------------------------------
// errors
// ------------------------------------------------------------------------------------------------

/** The error codes the API answers with, each with its HTTP status. */
export const ERROR_STATUS = {
	invalid_request: 400,
	unauthenticated: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	/** a messageID whose time is outside the window around the server's clock (`MESSAGE_ID_WINDOW_MS`) */
	stale: 400,
	/** a send beyond the account's budget, or a session or registration beyond the IP's (`RateLimitedDetails`) */
	rate_limited: 429,
	internal: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

/** The body of every error response: `{error: {code, message}}`, under the code's status. */
export type ErrorResponse = {error: {code: ErrorCode; message: string; details?: unknown}};

// ------------------------------------------------------------------------------------------------
// users
// ------------------------------------------------------------------------------------------------

const ProfileFields = {
	name: z.string().max(64).optional(),
	description: z.string().max(512).optional(),
};

/** A 32-byte public key (Ed25519 or X25519), lowercase 0x-prefixed hex. */
export const KeySchema = z.custom<Key>((v) => typeof v === 'string' && /^0x[a-f0-9]{64}$/.test(v), {
	message: 'expected a 32-byte key as lowercase 0x-prefixed hex',
});

/**
 * The public half of a key set (delegated-identity's `PublicKeySet`): the
 * Ed25519 key that signs for the account, the X25519 key others encrypt to.
 * Only the public keys: anything else is dropped.
 */
export const PublicKeySetSchema = z.object({
	signing: z.object({publicKey: KeySchema}),
	encryption: z.object({publicKey: KeySchema}),
});

/**
 * Register a key set for a domain: `ownershipSignature` is the wallet's EIP-191
 * signature over the publication message of `keySet` (delegated-identity's
 * `originPublicKeyPublicationMessage`) for `appOrigin`, the origin of the app
 * (its scheme, host and port, as the wallet was shown it), whose host is
 * `domain`. The request is signed by the key set's signing key. Registering
 * another key set for the account in the domain replaces the current one (the
 * replaced one stays readable through `getKeySet`). The profile is the domain's:
 * a domain shows only what was registered in it.
 */
export const ActionRegisterDomainUserSchema = z.object({
	type: z.literal('register'),
	domain: DomainSchema,
	appOrigin: z.string().min(1).max(300),
	address: AddressSchema,
	keySet: PublicKeySetSchema,
	ownershipSignature: String0xSchema,
	...ProfileFields,
});
export type ActionRegisterDomainUser = z.infer<typeof ActionRegisterDomainUserSchema>;
export type ResponseRegisterDomainUser = {ok: true; message: string};

export const ActionEditDomainUserSchema = z.object({
	type: z.literal('editUser'),
	domain: DomainSchema,
	...ProfileFields,
});
export type ActionEditDomainUser = z.infer<typeof ActionEditDomainUserSchema>;
export type ResponseEditDomainUser = {ok: true; message: string};

/**
 * A key set registered for a wallet in a domain, current or replaced, with its
 * ownership proof: what a reader checks a key against before using it.
 */
export type RegisteredKeySet = {
	user: Address;
	domain: string;
	/** the key set's reference (delegated-identity's `keySetRef`) */
	keyRef: String0x;
	keySet: PublicKeySet;
	/** the wallet's signature over the publication message of `keySet` for `appOrigin` */
	ownershipSignature: String0x;
	/** the app origin the wallet signed for, whose host is `domain` */
	appOrigin: string;
	/** when it was first registered */
	registered: number;
};

/** A wallet in a domain: its current key set with the ownership proof, and its profile there. */
export type DomainUser = {
	user: Address;
	domain: string;
	/** the current key set's reference (delegated-identity's `keySetRef`) */
	keyRef: String0x;
	keySet: PublicKeySet;
	/** the wallet's signature over the publication message of `keySet` for `appOrigin` */
	ownershipSignature: String0x;
	/** the app origin the wallet signed for, whose host is `domain` */
	appOrigin: string;
	name: string | null;
	description: string | null;
	added: number;
	lastPresence: number;
};

export const ActionGetDomainUserSchema = z.object({
	type: z.literal('getDomainUser'),
	domain: DomainSchema,
	address: AddressSchema,
});
export type ActionGetDomainUser = z.infer<typeof ActionGetDomainUserSchema>;
export type ResponseGetDomainUser = {domainUser: DomainUser | undefined};

/** Any key set registered in the domain, current or replaced, by its reference: a reader checks old messages with it. */
export const ActionGetKeySetSchema = z.object({
	type: z.literal('getKeySet'),
	domain: DomainSchema,
	keyRef: KeySchema,
});
export type ActionGetKeySet = z.infer<typeof ActionGetKeySetSchema>;
export type ResponseGetKeySet = {keySet: RegisteredKeySet | undefined};

// ------------------------------------------------------------------------------------------------
// sessions
// ------------------------------------------------------------------------------------------------

/**
 * `POST /api/session` (ADR-0006): a request signed by the signing key of the
 * caller's current key set in `domain`, answered with a session token that
 * authenticates every later request in that domain (as `Authorization: Bearer
 * <token>`) but `register`, which stays signed (a send is authorized by the
 * token and the message's own signature).
 */
export const ActionOpenSessionSchema = z.object({
	domain: DomainSchema,
});
export type ActionOpenSession = z.infer<typeof ActionOpenSessionSchema>;
export type ResponseOpenSession = {
	token: string;
	/** when the token stops being accepted, in ms since the epoch, on the server's clock */
	expiresAt: number;
	/** the key set the session was opened with (delegated-identity's `keySetRef`) */
	keyRef: String0x;
};

// ------------------------------------------------------------------------------------------------
// conversations (0.6, ADR-0006 "API")
// ------------------------------------------------------------------------------------------------

/** A member's view of a conversation: requested (`unaccepted`), `accepted`, or `rejected` (which blocked the other member). */
export const CONVERSATION_STATUSES = ['unaccepted', 'accepted', 'rejected'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * A conversation as one member's inbox lists it: keyed by `(domain, namespace,
 * conversationID)`, never by `conversationID` alone. `lastSeq` is the seq of
 * the newest message this member can see, `lastReadSeq` the newest it marked
 * read: the conversation is unread while `lastReadSeq < lastSeq`.
 */
export type Conversation = {
	domain: string;
	namespace: string;
	conversationID: string;
	/** the two members, as `conversationID` names them */
	members: Address[];
	status: ConversationStatus;
	lastSeq: number;
	lastReadSeq: number;
	/** the server time of the newest message this member can see (ms) */
	lastMessageAt: number;
};

/** Whether a conversation has a message newer than the member's last read one. */
export function isUnread(conversation: Pick<Conversation, 'lastSeq' | 'lastReadSeq'>): boolean {
	return conversation.lastReadSeq < conversation.lastSeq;
}

const conversationScope = {
	domain: DomainSchema,
	namespace: NamespaceSchema,
};

export const MAX_PAGE_SIZE = 100;
const LimitSchema = z.number().int().min(1).max(MAX_PAGE_SIZE).optional();
const SeqSchema = z.number().int().nonnegative();

/**
 * The account's conversations in a domain and namespace, newest message first,
 * from its inbox index; `status` filters. `cursor` is set when there are older
 * ones: pass it as `before` for the next page (it names the last item's
 * position, so a page never repeats or skips an item that did not move).
 */
export const ActionListConversationsSchema = z.object({
	type: z.literal('listConversations'),
	...conversationScope,
	status: z.enum(CONVERSATION_STATUSES).optional(),
	before: z.string().max(512).optional(),
	limit: LimitSchema,
});
export type ActionListConversations = z.infer<typeof ActionListConversationsSchema>;
export type ResponseListConversations = {conversations: Conversation[]; cursor?: string};

const conversationFields = {
	...conversationScope,
	conversationID: ConversationIDSchema,
};

/** Accept a conversation request: it moves to the accepted conversations. */
export const ActionAcceptSchema = z.object({type: z.literal('accept'), ...conversationFields});
export type ActionAccept = z.infer<typeof ActionAcceptSchema>;
export type ResponseAccept = {success: true};

/**
 * Reject a conversation. It also blocks its other member in the whole domain:
 * what they send is acknowledged to them and never reaches you, in any
 * namespace, until `unblock`.
 */
export const ActionRejectSchema = z.object({type: z.literal('reject'), ...conversationFields});
export type ActionReject = z.infer<typeof ActionRejectSchema>;
export type ResponseReject = {success: true};

export const ActionUnblockSchema = z.object({
	type: z.literal('unblock'),
	domain: DomainSchema,
	address: AddressSchema,
});
export type ActionUnblock = z.infer<typeof ActionUnblockSchema>;
export type ResponseUnblock = {success: true};

/** Mark the conversation read up to `seq` (never backwards, never past its last message). */
export const ActionMarkReadSchema = z.object({type: z.literal('markRead'), ...conversationFields, seq: SeqSchema});
export type ActionMarkRead = z.infer<typeof ActionMarkReadSchema>;
export type ResponseMarkRead = {success: true};

// ------------------------------------------------------------------------------------------------
// messages (0.6, ADR-0006 "Sending"; the format is `message.ts`)
// ------------------------------------------------------------------------------------------------

/**
 * How far a messageID's time (its ULID's) may be from the server's clock: a
 * send outside it is refused `stale`, with the server's time, and the client
 * signs the message again under a fresh messageID.
 */
export const MESSAGE_ID_WINDOW_MS = 10 * 60 * 1000;

/**
 * `POST /api/messages/send`: one message (`MessageToSendSchema`), authorized by
 * the session token (its account and key set must be the message's `sender`
 * and `senderKeyRef`) and by the message's own signature, which the server
 * verifies against that key set before storing anything. 1:1 only. A retry of
 * a stored message (same messageID, same signature) answers its stored `seq`;
 * the same messageID with another signature is refused `conflict`.
 */
export const ActionSendMessageSchema = z.object({
	type: z.literal('sendMessage'),
	message: MessageToSendSchema,
});
export type ActionSendMessage = z.infer<typeof ActionSendMessageSchema>;
export type ResponseSendMessage = {seq: number; serverTimestamp: number};
/** The `details` of a `stale` refusal: the server's clock, to sign the message again against. */
export type StaleDetails = {serverTime: number};
/**
 * The `details` of a `rate_limited` refusal: how long until the request would be
 * accepted (the next token of the caller's bucket), also in the `Retry-After`
 * header, in whole seconds rounded up.
 */
export type RateLimitedDetails = {retryAfterMs: number};

/**
 * A conversation's messages by seq, always returned in ascending seq order:
 * with `after`, the first `limit` messages after that seq (what is new since
 * the last one the client has); with `before`, the last `limit` before it
 * (paging back); with neither, the newest `limit`. `hasMore` says whether
 * messages remain past the page in its direction (newer for `after`, older
 * otherwise). A member never lists a message hidden from it (a blocked sender's).
 */
export const ActionListMessagesSchema = z
	.object({
		type: z.literal('listMessages'),
		...conversationFields,
		after: SeqSchema.optional(),
		before: SeqSchema.optional(),
		limit: LimitSchema,
	})
	.refine((action) => action.after === undefined || action.before === undefined, {
		message: 'after and before are exclusive',
	});
export type ActionListMessages = z.infer<typeof ActionListMessagesSchema>;
export type ResponseListMessages = {messages: Message[]; hasMore: boolean};

// ------------------------------------------------------------------------------------------------
// admin
// ------------------------------------------------------------------------------------------------

export const ActionResetSchema = z.object({reset: z.boolean()});
export type ActionReset = z.infer<typeof ActionResetSchema>;

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

/**
 * The ID of the conversation between these members (lowercased, deduplicated):
 * `getConversationID` of the two for two, else keccak256 of the sorted addresses
 * joined by `:`. The server derives it the same way and refuses any other.
 */
export function conversationIDOf(members: Address[]): string {
	const sorted = [...new Set(members.map((v) => v.toLowerCase()))].sort() as Address[];
	if (sorted.length === 2) {
		return getConversationID(sorted[0], sorted[1]);
	}
	return `0x${bytesToHex(keccak_256(sorted.join(':')))}`;
}

/**
 * The two members of a 1:1 conversationID (`getConversationID`'s form: the two
 * lowercase addresses, the greater first), or undefined for any other form (a
 * group's hash, a malformed ID, an account with itself).
 */
export function membersOfConversationID(conversationID: string): [Address, Address] | undefined {
	const match = /^(0x[0-9a-f]{40})(0x[0-9a-f]{40})$/.exec(conversationID);
	if (!match || match[1] <= match[2]) {
		return undefined;
	}
	return [match[1] as Address, match[2] as Address];
}

export function getConversationID(accountA: Address, accountB: Address) {
	accountA = accountA.toLowerCase() as PublicKey;
	accountB = accountB.toLowerCase() as PublicKey;
	if (accountA > accountB) {
		return `${accountA}${accountB}`;
	} else {
		return `${accountB}${accountA}`;
	}
}

// ------------------------------------------------------------------------------------------------
// rooms (WebSocket messages)
// ------------------------------------------------------------------------------------------------

export type ClientMessageType =
	// the login: `signature` is delegated-identity's Ed25519 request signature over
	// the challenge (method GET, the room's path, the server's origin), by the
	// signing key of the account's current key set in the room's domain
	// a message: attributed by the server to the session's account, not signed (rooms
	// are unencrypted and server-relayed, ADR-0002)
	{address: `0x${string}`; signature: string} | {message: string} | {logout: true};

export type ServerMessageType =
	| {challenge: string; id: string}
	| {joined: `0x${string}`; id: string; publicKey: `0x${string}`}
	| {message: string; from: `0x${string}`; timestamp: number}
	| {quit: string; id: string}
	| {error: string; code?: ErrorCode};

/** Whether `appOrigin` is an origin whose host is `domain` (or is `domain` itself). */
export function isOriginOfDomain(appOrigin: string, domain: string): boolean {
	if (appOrigin === domain) {
		return true;
	}
	try {
		const url = new URL(appOrigin);
		return url.origin === appOrigin && url.host === domain;
	} catch {
		return false;
	}
}

/** The origin of an HTTP or WebSocket URL as a server sees it (`ws:` as `http:`, `wss:` as `https:`). */
export function serverOriginOf(url: string): string {
	const parsed = new URL(url);
	const protocol = parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
	return `${protocol}//${parsed.host}`;
}

export {
	MissivPushDataSchema,
	MissivPushHandoffSchema,
	readMissivPushData,
	readMissivPushHandoff,
	PUSH_HANDOFF_KEY,
	withPushHandoff,
	splitPushHandoff,
	consumePushHandoff,
	type MissivPushData,
	type MissivPushHandoff,
	type PushHandoffLocation,
	type PushHandoffHistory,
} from './push.js';

export {
	MESSAGE_SCHEMES,
	MAX_MESSAGE_CONTENT_LENGTH,
	MessageIDSchema,
	MessageSignatureHexSchema,
	MessageHeaderSchema,
	MessageToSignSchema,
	MessageToSendSchema,
	MessageSchema,
	pairwiseKeyID,
	keyRefsOfPairwiseKeyID,
	messageHeaderLines,
	messageSigningPayload,
	signMessage,
	verifyMessage,
	encryptPairwise,
	decryptPairwise,
	type MessageScheme,
	type MessageHeader,
	type MessageToSign,
	type MessageToSend,
	type Message,
} from './message.js';

export {newULID, ulidAt, ulidTime} from './ids.js';

export {
	INBOX_WS_PATH,
	INBOX_WS_PROTOCOL,
	INBOX_CLOSE_SESSION_EXPIRED,
	INBOX_SESSION_EXPIRED_REASON,
	MAX_SYNC_CONVERSATIONS,
	InboxSyncSchema,
	inboxConversationKey,
	parseInboxConversationKey,
	type InboxSync,
	type InboxClientFrame,
	type InboxServerFrame,
} from './inbox.js';

export {
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_TIMEOUT_MS,
	HEARTBEAT_IDLE_INTERVALS,
	HEARTBEAT_CLOSE_TIMEOUT,
	HEARTBEAT_TIMEOUT_REASON,
} from './heartbeat.js';
