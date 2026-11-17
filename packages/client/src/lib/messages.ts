// What the client trusts, and how: missiv's server is an untrusted relay, so
// every key the client uses is checked against the wallet's ownership proof
// before use, every copy it sends is signed by the sender's delegate key, and
// every copy it reads is checked and decrypted on its own, into a content or an
// error, never an exception that would stop the rest of the thread.
import { getSharedSecret } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils';
import { base64 } from '@scure/base';
import { delegatePublicKey, recoverAccount } from 'delegated-identity';
import {
	isOriginOfDomain,
	recoverMessageCopySigner,
	signMessageCopy,
	type ActionSendEncryptedMessage,
	type ActionSendInClearMessage,
	type Address,
	type ConversationMessage,
	type DomainUser,
	type PublicKey
} from 'missiv-common';

/** The delegate key of the account using the client. */
export type DelegateKey = { privateKey: string | Uint8Array };

function toPrivateKeyHex(privateKey: string | Uint8Array): `0x${string}` {
	if (typeof privateKey !== 'string') {
		return `0x${Array.from(privateKey, (b) => b.toString(16).padStart(2, '0')).join('')}`;
	}
	return (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
}

/** The public key of a delegate key, as the server registers it. */
export function publicKeyOf(key: DelegateKey): PublicKey {
	return delegatePublicKey(toPrivateKeyHex(key.privateKey));
}

const proofCache = new Map<string, Promise<boolean>>();

/**
 * Whether `publicKey` is a key `address` authorized for an app of `domain`:
 * the ownership proof recovers `address` for `appOrigin`, and `appOrigin` is an
 * origin of `domain`. The server's word is never enough.
 */
export function verifyOwnership(proof: {
	address: Address;
	domain: string;
	publicKey: PublicKey;
	appOrigin: string;
	ownershipSignature: `0x${string}`;
}): Promise<boolean> {
	const cacheID = [
		proof.address,
		proof.domain,
		proof.publicKey,
		proof.appOrigin,
		proof.ownershipSignature
	]
		.join(':')
		.toLowerCase();
	let verified = proofCache.get(cacheID);
	if (!verified) {
		verified = (async () => {
			if (!isOriginOfDomain(proof.appOrigin, proof.domain)) {
				return false;
			}
			try {
				const recovered = await recoverAccount({
					appOrigin: proof.appOrigin,
					publicKey: proof.publicKey,
					ownershipSignature: proof.ownershipSignature
				});
				return recovered === proof.address.toLowerCase();
			} catch {
				return false;
			}
		})();
		proofCache.set(cacheID, verified);
	}
	return verified;
}

/** Whether a domain user the server returned is what it claims: its key proven by its wallet, for its domain. */
export function verifyDomainUser(
	domainUser: DomainUser,
	expected: { address: Address; domain: string }
) {
	if (
		domainUser.user.toLowerCase() !== expected.address.toLowerCase() ||
		domainUser.domain !== expected.domain
	) {
		return Promise.resolve(false);
	}
	return verifyOwnership({
		address: domainUser.user,
		domain: domainUser.domain,
		publicKey: domainUser.publicKey,
		appOrigin: domainUser.appOrigin,
		ownershipSignature: domainUser.signature
	});
}

const sharedKeyCache = new Map<string, Uint8Array>();

function sharedKey(privateKey: `0x${string}`, otherPublicKey: PublicKey): Uint8Array {
	const cacheID = privateKey + ':' + otherPublicKey;
	let key = sharedKeyCache.get(cacheID);
	if (!key) {
		key = keccak_256(getSharedSecret(privateKey.slice(2), otherPublicKey.slice(2)));
		sharedKeyCache.set(cacheID, key);
	}
	return key;
}

/** Where a message is: what both the AEAD's associated data and the copy's signature bind. */
export type MessageScope = { domain: string; namespace: string; conversationID: string };

/**
 * The associated data of an encrypted message: its scope and the two keys of the
 * exchange, so a ciphertext moved to another conversation, namespace, domain or
 * pair of keys fails to decrypt.
 */
function associatedData(
	scope: MessageScope,
	senderPublicKey: PublicKey,
	recipientPublicKey: PublicKey
) {
	return utf8ToBytes(
		[
			'missiv encrypted v1',
			scope.domain,
			scope.namespace,
			scope.conversationID,
			senderPublicKey.toLowerCase(),
			recipientPublicKey.toLowerCase()
		].join('\n')
	);
}

/**
 * The two signed copies of an encrypted direct message: the recipient's, and the
 * sender's own, both encrypted to the recipient's key (the sender reads its copy
 * with the same shared secret). `recipient.publicKey` must be verified first.
 */
export async function encryptedCopies(params: {
	scope: MessageScope;
	sender: { address: Address } & DelegateKey;
	recipient: { address: Address; publicKey: PublicKey };
	text: string;
}): Promise<ActionSendEncryptedMessage['messages']> {
	const privateKey = toPrivateKeyHex(params.sender.privateKey);
	const senderPublicKey = publicKeyOf(params.sender);
	const nonce = randomBytes(24);
	const ciphertext = xchacha20poly1305(
		sharedKey(privateKey, params.recipient.publicKey),
		nonce,
		associatedData(params.scope, senderPublicKey, params.recipient.publicKey)
	).encrypt(utf8ToBytes(params.text));
	const content = `${base64.encode(nonce)}:${base64.encode(ciphertext)}`;
	return Promise.all(
		[params.recipient.address, params.sender.address].map(async (to) => ({
			to: to.toLowerCase() as Address,
			toPublicKey: params.recipient.publicKey,
			content,
			signature: await signMessageCopy(
				{
					...params.scope,
					messageType: 'encrypted',
					from: params.sender.address,
					to,
					toPublicKey: params.recipient.publicKey,
					content
				},
				privateKey
			)
		}))
	);
}

/** The signed copies of a clear message (an introduction): the server and anyone it shows them to can read them. */
export async function clearCopies(params: {
	scope: MessageScope;
	sender: { address: Address } & DelegateKey;
	recipients: Address[];
	text: string;
}): Promise<ActionSendInClearMessage['messages']> {
	const privateKey = toPrivateKeyHex(params.sender.privateKey);
	const members = [...params.recipients, params.sender.address];
	return Promise.all(
		members.map(async (to) => ({
			to: to.toLowerCase() as Address,
			content: params.text,
			signature: await signMessageCopy(
				{
					...params.scope,
					messageType: 'clear',
					from: params.sender.address,
					to,
					content: params.text
				},
				privateKey
			)
		}))
	);
}

export type MessageErrorCode =
	/** the sender's key is not proven by the sender's wallet, or this copy is not signed by it */
	| 'unverified'
	/** the copy is signed, but its content cannot be decrypted with this account's key */
	| 'undecryptable';

/** A copy as the client shows it: its text, or why it cannot be shown. Never thrown. */
export type OpenedMessage = Omit<ConversationMessage, 'content'> &
	(
		| { content: string; error?: undefined }
		| { content?: undefined; error: { code: MessageErrorCode; message: string } }
	);

const openedCache = new Map<string, OpenedMessage>();

/**
 * Check one copy and decrypt it for the reader: the sender's key against the
 * sender's ownership proof, the copy's signature against that key and this
 * copy's scope, recipient and content, then the ciphertext with its associated
 * data. Each copy on its own, so one bad copy never hides the others.
 */
export async function openMessage(
	message: ConversationMessage,
	reader: { address: Address; domain: string } & DelegateKey
): Promise<OpenedMessage> {
	const cacheID = `${message.id}:${message.recipient}:${message.signature}:${publicKeyOf(reader)}`;
	const cached = openedCache.get(cacheID);
	if (cached) {
		return cached;
	}
	const { content, ...rest } = message;
	const fail = (code: MessageErrorCode, text: string): OpenedMessage => ({
		...rest,
		error: { code, message: text }
	});
	const scope = {
		domain: message.domain,
		namespace: message.namespace,
		conversationID: message.conversationID
	};

	let opened: OpenedMessage;
	const proven =
		message.domain === reader.domain &&
		message.recipient.toLowerCase() === reader.address.toLowerCase() &&
		(await verifyOwnership({
			address: message.sender,
			domain: message.domain,
			publicKey: message.senderPublicKey,
			appOrigin: message.senderAppOrigin,
			ownershipSignature: message.senderOwnershipSignature
		}));
	const signer = proven
		? recoverMessageCopySigner({
				...scope,
				messageType: message.messageType,
				from: message.sender,
				to: message.recipient,
				toPublicKey: message.recipientPublicKey,
				content,
				signature: message.signature
			})
		: undefined;
	if (!proven || signer !== message.senderPublicKey.toLowerCase()) {
		opened = fail('unverified', 'this message is not signed by its sender');
	} else if (message.messageType === 'clear') {
		opened = { ...rest, content };
	} else {
		const privateKey = toPrivateKeyHex(reader.privateKey);
		const mine = message.sender.toLowerCase() === reader.address.toLowerCase();
		try {
			if (!message.recipientPublicKey) {
				throw new Error(`no key`);
			}
			const other = mine ? message.recipientPublicKey : message.senderPublicKey;
			const [nonce, ciphertext] = content.split(/:(.*)/s);
			const text = bytesToUtf8(
				xchacha20poly1305(
					sharedKey(privateKey, other),
					base64.decode(nonce),
					associatedData(scope, message.senderPublicKey, message.recipientPublicKey)
				).decrypt(base64.decode(ciphertext))
			);
			opened = { ...rest, content: text };
		} catch {
			opened = fail('undecryptable', 'this message cannot be decrypted with this key');
		}
	}
	openedCache.set(cacheID, opened);
	return opened;
}
