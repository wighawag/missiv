// missiv's protocol: every request and response of the HTTP API as a zod schema,
// with its TypeScript type inferred from it, so the server validates exactly what
// the client is typed against. One source; nothing here is declared twice.
import {z} from 'zod';
import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex} from '@noble/hashes/utils';
import type {PublicKeySet} from 'delegated-identity';

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
 * <token>`) but `register` and `sendMessage`, which stay signed.
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
// conversations
// ------------------------------------------------------------------------------------------------

export type Conversation = {
	domain: string;
	namespace: string;
	user: Address;
	conversationID: string;
	members: Address[];
	lastMessage: number;
	lastRead: number;
	accepted: boolean;
};

const conversationScope = {
	domain: DomainSchema,
	namespace: NamespaceSchema,
};

/** a page: at most `limit` (default and maximum 100) items older than the cursor `before` */
const pageFields = {
	limit: z.number().int().min(1).max(100).optional(),
	before: z.string().max(512).optional(),
};
export const MAX_PAGE_SIZE = 100;

export const ActionGetConversationsSchema = z.object({
	type: z.literal('getConversations'),
	...conversationScope,
	...pageFields,
});
export type ActionGetConversations = z.infer<typeof ActionGetConversationsSchema>;
/** `cursor` is set when there are older items: pass it as `before` for the next page */
export type ResponseGetConversations = {conversations: Conversation[]; cursor?: string};

export const ActionGetUnacceptedConversationsSchema = z.object({
	type: z.literal('getUnacceptedConversations'),
	...conversationScope,
	...pageFields,
});
export type ActionGetUnacceptedConversations = z.infer<typeof ActionGetUnacceptedConversationsSchema>;
export type ResponseGetUnacceptedConversations = {unacceptedConversations: Conversation[]; cursor?: string};

export const ActionGetAcceptedConversationsSchema = z.object({
	type: z.literal('getAcceptedConversations'),
	...conversationScope,
	...pageFields,
});
export type ActionGetAcceptedConversations = z.infer<typeof ActionGetAcceptedConversationsSchema>;
export type ResponseGetAcceptedConversations = {acceptedConversations: Conversation[]; cursor?: string};

export const ActionAcceptConversationSchema = z.object({
	type: z.literal('acceptConversation'),
	...conversationScope,
	conversationID: ConversationIDSchema,
	lastMessageReadTimestampMS: z.number(),
});
export type ActionAcceptConversation = z.infer<typeof ActionAcceptConversationSchema>;
export type ResponseAcceptConversation = {timestampMS: number};

export const ActionMarkAsReadSchema = z.object({
	type: z.literal('markAsRead'),
	...conversationScope,
	conversationID: ConversationIDSchema,
	lastMessageReadTimestampMS: z.number(),
});
export type ActionMarkAsRead = z.infer<typeof ActionMarkAsReadSchema>;
export type ResponseMarkAsRead = {success: true};

/**
 * Reject a conversation request. In a conversation of two, it also blocks the
 * other member in the domain: nothing they send reaches you until `unblock`.
 */
export const ActionRejectConversationSchema = z.object({
	type: z.literal('rejectConversation'),
	...conversationScope,
	conversationID: ConversationIDSchema,
});
export type ActionRejectConversation = z.infer<typeof ActionRejectConversationSchema>;
export type ResponseRejectConversation = {success: true};

export const ActionUnblockSchema = z.object({
	type: z.literal('unblock'),
	domain: DomainSchema,
	address: AddressSchema,
});
export type ActionUnblock = z.infer<typeof ActionUnblockSchema>;
export type ResponseUnblock = {success: true};

// ------------------------------------------------------------------------------------------------
// messages
// ------------------------------------------------------------------------------------------------

/**
 * Send a message: one copy per member, the sender's own included. The members
 * are the recipients (`to`), so `conversationID` must be `conversationIDOf` them.
 * An encrypted copy names the X25519 encryption key it is encrypted to
 * (`toPublicKey`), which must be the encryption key of the recipient's current
 * key set; a clear copy names none. Each copy carries the sender's Ed25519
 * signature over it (`signMessageCopy`), which the server stores and the reader
 * checks. (0.5's per-copy format on 0.6's keys, until the one-ciphertext format.)
 */
const sendMessageFields = {
	type: z.literal('sendMessage'),
	...conversationScope,
	conversationID: ConversationIDSchema,
	lastMessageReadTimestampMS: z.number(),
};

/** a copy's signature by the sender's Ed25519 signing key (`signMessageCopy`): 64 bytes */
export const MessageSignatureSchema = z.custom<String0x>((v) => typeof v === 'string' && /^0x[0-9a-f]{128}$/.test(v), {
	message: 'expected a message signature (0x, 64 bytes of lowercase hex)',
});

export const MAX_MEMBERS = 32;

export const ActionSendMessageSchema = z.discriminatedUnion('messageType', [
	z.object({
		...sendMessageFields,
		messageType: z.literal('encrypted'),
		messages: z
			.array(
				z.object({
					to: AddressSchema,
					toPublicKey: KeySchema,
					content: z.string().max(16384),
					signature: MessageSignatureSchema,
				}),
			)
			.min(2)
			.max(MAX_MEMBERS),
	}),
	z.object({
		...sendMessageFields,
		messageType: z.literal('clear'),
		messages: z
			.array(
				z.object({
					to: AddressSchema,
					toPublicKey: KeySchema.optional(),
					content: z.string().max(16384),
					signature: MessageSignatureSchema,
				}),
			)
			.min(2)
			.max(MAX_MEMBERS),
	}),
]);
export type ActionSendMessage = z.infer<typeof ActionSendMessageSchema>;
export type ActionSendEncryptedMessage = Extract<ActionSendMessage, {messageType: 'encrypted'}>;
export type ActionSendInClearMessage = Extract<ActionSendMessage, {messageType: 'clear'}>;
export type ResponseSendMessage = {timestampMS: number};

export type ConversationMessage = {
	domain: string;
	namespace: string;
	conversationID: string;
	/** time-ordered (a ULID), shared by the rows of one message */
	id: string;
	recipient: Address;
	sender: Address;
	/** the reference of the sender's key set when it sent (`getKeySet` answers it after a replacement too) */
	senderKeyRef: String0x;
	/** the sender's key set when it sent: its signing key signed this copy */
	senderKeySet: PublicKeySet;
	/** the sender's ownership proof of `senderKeySet` (the wallet's signature over its publication message) */
	senderOwnershipSignature: String0x;
	/** the app origin that proof names, whose host is `domain` */
	senderAppOrigin: string;
	/** the X25519 encryption key an encrypted copy is encrypted to; null for a clear copy */
	recipientPublicKey: PublicKey | null;
	content: string;
	timestamp: number;
	messageType: 'encrypted' | 'clear';
	/** the sender's signature over this copy (`signMessageCopy`), stored as sent and never checked by the server */
	signature: String0x;
};

export const ActionGetMessagesSchema = z.object({
	type: z.literal('getMessages'),
	...conversationScope,
	conversationID: ConversationIDSchema,
	...pageFields,
});
export type ActionGetMessages = z.infer<typeof ActionGetMessagesSchema>;
/** newest first; `cursor` is set when there are older messages: pass it as `before` */
export type ResponseGetMessages = {messages: ConversationMessage[]; cursor?: string};

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

export {messageCopyMessage, signMessageCopy, verifyMessageCopy, type MessageCopyToSign} from './message-signature.js';
