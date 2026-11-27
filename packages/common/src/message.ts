// The missiv message (ADR-0004 decisions 2 to 4, ADR-0006 "The message"): one
// row per message, its one `content` readable by every member (no per-recipient
// copy, the sender's own included), signed once by the sender's Ed25519 signing
// key. The signature names the message's scope, its messageID, its sender and
// key set, its scheme and keyID, and its content by SHA-256, so a message moved
// to another conversation, namespace, domain or messageID, or with another
// content, verifies for none of them. The server checks it before storing (a
// write filter, and what authorizes a send); the reading client checks it again
// itself (ADR-0003).
//
// ## Schemes and keyIDs
//
// `scheme` says how `content` is to be read and `keyID` which keys read it:
//
// - `clear`: `content` is the text; `keyID` is null. An introduction.
// - `pairwise-v1` (1:1): `keyID` is the two members' keyRefs (delegated-identity's
//   `keySetRef`), sorted, joined by `:` (`pairwiseKeyID`). The content key is
//   HKDF-SHA256 of the X25519 shared secret of those two key sets' encryption
//   keys (empty salt, the message header as info, `messageHeaderLines`), so every
//   message has its own key; `content` is base64url (unpadded) of a random
//   96-bit IV, the AES-256-GCM ciphertext and its tag, under the same header as
//   associated data. Both members derive the same key, so both read the same
//   ciphertext; a reader whose key set is not one of the two cannot.
//
// A later scheme reuses the same row and the same signature: a new `scheme`
// value (reserved: `sender-key-v1`, `mls-v1`) and a `keyID` that names, instead
// of a pair of key sets, the key the content is under (a sender-key chain, an
// MLS epoch), whose keys reach the members through a separate key-envelope
// table. A reader that does not know a scheme, or holds no key for its keyID,
// shows the message as undecryptable; nothing in the row, the signing payload
// or the store changes. A post-quantum scheme is the same: a new `scheme`.
import {z} from 'zod';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';
import {base64urlnopad} from '@scure/base';
import {ed25519Sign, ed25519Verify, sha256} from 'delegated-identity/ed25519';
import {aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, randomBytes, x25519SharedSecret} from './cipher.js';

type Hex = `0x${string}`;

/** The schemes a message can be in; `sender-key-v1` and `mls-v1` are reserved for groups. */
export const MESSAGE_SCHEMES = ['clear', 'pairwise-v1'] as const;
export type MessageScheme = (typeof MESSAGE_SCHEMES)[number];

/** The longest `content` (characters): the text of a clear message, the base64url of a pairwise one. */
export const MAX_MESSAGE_CONTENT_LENGTH = 16384;

// Every header field is validated to contain no newline (most are hex or
// base32), so the signing payload's lines are unambiguous.
const MessageDomainSchema = z
	.string()
	.min(1)
	.max(253)
	.regex(/^[\x21-\x7e]+$/, 'expected a domain (printable ASCII, no space)');
const MessageNamespaceSchema = z
	.string()
	.max(64)
	.regex(/^[^\x00-\x1f\x7f]*$/, 'expected a namespace without control characters');
/** `conversationIDOf` of the members: the two addresses for two, a 32-byte hash for more (refused while groups are). */
const MessageConversationIDSchema = z
	.string()
	.regex(/^(0x[0-9a-f]{40}0x[0-9a-f]{40}|0x[0-9a-f]{64})$/, 'expected a conversationID (conversationIDOf)');
/** A ULID (Crockford base32, uppercase): the client's, so the message carries its time. */
export const MessageIDSchema = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'expected a messageID (a ULID)');
const MessageAddressSchema = z.custom<Hex>((v) => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v), {
	message: 'expected an address as lowercase 0x-prefixed hex',
});
const KeyRefSchema = z.custom<Hex>((v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v), {
	message: 'expected a keyRef (32 bytes as lowercase 0x-prefixed hex)',
});
const PairwiseKeyIDSchema = z
	.string()
	.regex(/^0x[0-9a-f]{64}:0x[0-9a-f]{64}$/, 'expected a pairwise keyID (two keyRefs joined by `:`)')
	.refine((keyID) => {
		const [a, b] = keyID.split(':');
		return a < b;
	}, 'expected a pairwise keyID with its two keyRefs sorted');
/** A message signature by the sender's Ed25519 signing key: 64 bytes as lowercase 0x-prefixed hex. */
export const MessageSignatureHexSchema = z.custom<Hex>((v) => typeof v === 'string' && /^0x[0-9a-f]{128}$/.test(v), {
	message: 'expected a message signature (0x, 64 bytes of lowercase hex)',
});

const headerFields = {
	domain: MessageDomainSchema,
	namespace: MessageNamespaceSchema,
	conversationID: MessageConversationIDSchema,
	messageID: MessageIDSchema,
	sender: MessageAddressSchema,
	/** the keyRef of the sender's key set that signs it (`getKeySet` answers it after a replacement too) */
	senderKeyRef: KeyRefSchema,
};

const PAIRWISE_CONTENT = /^[A-Za-z0-9_-]+$/;

/** A message's header: everything the signature and the pairwise content key bind but the content. */
export const MessageHeaderSchema = z.discriminatedUnion('scheme', [
	z.object({...headerFields, scheme: z.literal('clear'), keyID: z.null()}),
	z.object({...headerFields, scheme: z.literal('pairwise-v1'), keyID: PairwiseKeyIDSchema}),
]);
export type MessageHeader = z.infer<typeof MessageHeaderSchema>;

/** A message as the sender signs it. */
export const MessageToSignSchema = z.discriminatedUnion('scheme', [
	z.object({
		...headerFields,
		scheme: z.literal('clear'),
		keyID: z.null(),
		content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
	}),
	z.object({
		...headerFields,
		scheme: z.literal('pairwise-v1'),
		keyID: PairwiseKeyIDSchema,
		content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH).regex(PAIRWISE_CONTENT, 'expected base64url content'),
	}),
]);
export type MessageToSign = z.infer<typeof MessageToSignSchema>;

/** A message as sent (`messages/send`): signed, without what the store assigns. */
export const MessageToSendSchema = z.discriminatedUnion('scheme', [
	MessageToSignSchema.options[0].extend({signature: MessageSignatureHexSchema}),
	MessageToSignSchema.options[1].extend({signature: MessageSignatureHexSchema}),
]);
export type MessageToSend = z.infer<typeof MessageToSendSchema>;

const storedFields = {
	/** its place in the conversation, assigned by the ConversationStore */
	seq: z.number().int().nonnegative(),
	/** when the store appended it, in ms since the epoch, on the server's clock */
	serverTimestamp: z.number().int().nonnegative(),
};

/** A message as stored and listed: as sent, plus its `seq` and `serverTimestamp`. */
export const MessageSchema = z.discriminatedUnion('scheme', [
	MessageToSendSchema.options[0].extend(storedFields),
	MessageToSendSchema.options[1].extend(storedFields),
]);
export type Message = z.infer<typeof MessageSchema>;

/**
 * The `pairwise-v1` keyID of the two members' key sets: their keyRefs,
 * lowercased, sorted, joined by `:`. The same whichever member computes it.
 */
export function pairwiseKeyID(keyRefA: string, keyRefB: string): string {
	return [keyRefA.toLowerCase(), keyRefB.toLowerCase()].sort().join(':');
}

/** The two keyRefs of a `pairwise-v1` keyID, sorted. */
export function keyRefsOfPairwiseKeyID(keyID: string): [Hex, Hex] {
	const parsed = PairwiseKeyIDSchema.parse(keyID);
	const [a, b] = parsed.split(':');
	return [a as Hex, b as Hex];
}

function header(message: MessageHeader): MessageHeader {
	const parsed = MessageHeaderSchema.safeParse(message);
	if (!parsed.success) {
		throw new Error(`not a valid message header: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
	}
	return parsed.data;
}

/**
 * The header lines of a message, `domain` through `keyID`, joined with `\n`:
 * the middle of the signing payload, and the HKDF info and the AES-GCM
 * associated data of `pairwise-v1`. Throws on a header that is not valid (a
 * field with a newline, among others).
 */
export function messageHeaderLines(message: MessageHeader): string {
	const h = header(message);
	return [
		`domain: ${h.domain}`,
		`namespace: ${h.namespace}`,
		`conversation: ${h.conversationID}`,
		`id: ${h.messageID}`,
		`sender: ${h.sender}`,
		`senderKey: ${h.senderKeyRef}`,
		`scheme: ${h.scheme}`,
		`keyID: ${h.keyID ?? 'none'}`,
	].join('\n');
}

const utf8 = new TextEncoder();

/**
 * What a sender's signing key signs for a message (Ed25519 over its UTF-8
 * bytes): `missiv message`, the header lines, then `content: 0x<SHA-256 of the
 * content's UTF-8>`. Its purpose line sets it apart from delegated-identity's
 * request envelope, signed by the same key. Throws on a message that is not
 * valid.
 */
export async function messageSigningPayload(message: MessageToSign): Promise<string> {
	const parsed = MessageToSignSchema.safeParse(message);
	if (!parsed.success) {
		throw new Error(`not a valid message: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
	}
	const contentHash = bytesToHex(await sha256(utf8.encode(parsed.data.content)));
	return ['missiv message', messageHeaderLines(parsed.data), `content: 0x${contentHash}`].join('\n');
}

function toBytes(key: Uint8Array | string): Uint8Array {
	if (typeof key !== 'string') {
		return key;
	}
	return hexToBytes(key.startsWith('0x') ? key.slice(2) : key);
}

/** Sign a message with the sender's Ed25519 signing private key: `0x` + the 64-byte signature. */
export async function signMessage(message: MessageToSign, signingPrivateKey: Uint8Array | string): Promise<Hex> {
	const seed = toBytes(signingPrivateKey);
	if (seed.length !== 32) {
		throw new Error(`an Ed25519 private key is 32 bytes, got ${seed.length}`);
	}
	return `0x${bytesToHex(await ed25519Sign(utf8.encode(await messageSigningPayload(message)), seed))}`;
}

/**
 * Whether `signingPublicKey` (the Ed25519 key of the key set `senderKeyRef`
 * names, checked first against its keyRef and its ownership proof) signed this
 * message. False on an invalid message, a malformed signature or key, never a
 * throw.
 */
export async function verifyMessage(message: MessageToSend, signingPublicKey: string): Promise<boolean> {
	if (!/^0x[0-9a-fA-F]{64}$/.test(signingPublicKey)) {
		return false;
	}
	const parsed = MessageToSendSchema.safeParse(message);
	if (!parsed.success) {
		return false;
	}
	try {
		return await ed25519Verify(
			hexToBytes(parsed.data.signature.slice(2)),
			utf8.encode(await messageSigningPayload(parsed.data)),
			hexToBytes(signingPublicKey.slice(2)),
		);
	} catch {
		return false;
	}
}

type PairwiseHeader = Extract<MessageHeader, {scheme: 'pairwise-v1'}>;

async function pairwiseContentKey(
	message: PairwiseHeader,
	encryptionPrivateKey: Uint8Array | string,
	otherEncryptionPublicKey: Uint8Array | string,
): Promise<{key: Uint8Array; info: Uint8Array}> {
	const info = utf8.encode(messageHeaderLines(message));
	const secret = await x25519SharedSecret(toBytes(encryptionPrivateKey), toBytes(otherEncryptionPublicKey));
	return {key: await hkdfSha256(secret, info, 32), info};
}

/**
 * The `pairwise-v1` content of `text` for this header, from one member's X25519
 * encryption private key and the other member's encryption public key (the
 * key sets `keyID` names; either member computes the same key). `iv` is random
 * unless given (test vectors only: an IV is never reused under a key, and
 * every message has its own key).
 */
export async function encryptPairwise(
	message: PairwiseHeader,
	text: string,
	encryptionPrivateKey: Uint8Array | string,
	otherEncryptionPublicKey: Uint8Array | string,
	iv: Uint8Array = randomBytes(12),
): Promise<string> {
	const {key, info} = await pairwiseContentKey(
		header(message) as PairwiseHeader,
		encryptionPrivateKey,
		otherEncryptionPublicKey,
	);
	const sealed = await aesGcmEncrypt(key, iv, utf8.encode(text), info);
	const content = new Uint8Array(iv.length + sealed.length);
	content.set(iv);
	content.set(sealed, iv.length);
	return base64urlnopad.encode(content);
}

/**
 * The text of a `pairwise-v1` message, read with one member's X25519
 * encryption private key and the other member's encryption public key. Throws
 * when it cannot be read: not base64url, too short, another key or another
 * header (the AES-GCM tag fails), or not UTF-8.
 */
export async function decryptPairwise(
	message: PairwiseHeader & {content: string},
	encryptionPrivateKey: Uint8Array | string,
	otherEncryptionPublicKey: Uint8Array | string,
): Promise<string> {
	const bytes = base64urlnopad.decode(message.content);
	if (bytes.length < 12 + 16) {
		throw new Error('a pairwise-v1 content is an IV, a ciphertext and a tag');
	}
	const {key, info} = await pairwiseContentKey(
		header(message) as PairwiseHeader,
		encryptionPrivateKey,
		otherEncryptionPublicKey,
	);
	const plaintext = await aesGcmDecrypt(key, bytes.subarray(0, 12), bytes.subarray(12), info);
	return new TextDecoder('utf-8', {fatal: true}).decode(plaintext);
}
