// What the client trusts, and how: missiv's server is an untrusted relay, so
// every key set the client uses is checked against the wallet's ownership proof
// (delegated-identity) before use, every message it sends is signed by the
// sender's Ed25519 signing key, and every message it reads is checked and
// decrypted on its own, into a content or an error, never a verdict thrown
// that would stop the rest of the thread.
//
// The missiv message (ADR-0004, ADR-0006 "The message"; `@missiv/common`'s
// `Message`): one ciphertext per message, signed once, `pairwise-v1` or
// `clear`. `composeMessage` / `composeIntroduction` build one to send,
// `openMessage` reads one, fetching the sender's key set by `senderKeyRef`.
import { keySetRef, recoverAccount } from 'delegated-identity';
import {
	conversationIDOf,
	decryptPairwise,
	encryptPairwise,
	isOriginOfDomain,
	keyRefsOfPairwiseKeyID,
	membersOfConversationID,
	MESSAGE_SCHEMES,
	MessageSchema,
	newULID,
	pairwiseKeyID,
	signMessage,
	verifyMessage,
	type ActionGetKeySet,
	type Address,
	type DomainUser,
	type KeySet,
	type Message,
	type MessageToSend,
	type PublicKey,
	type PublicKeySet,
	type RegisteredKeySet,
	type ResponseGetKeySet,
	type String0x
} from '@missiv/common';

/**
 * The keys of the account using the client: its key set in the app, private
 * halves included (`@etherplay/connect`'s `account.keySet`, derived by
 * delegated-identity's `deriveKeySet`).
 */
export type AccountKeys = { keySet: KeySet };

/** The public half of a key set: what is registered and sent, never a private key. */
export function publicKeySetOf(keySet: PublicKeySet): PublicKeySet {
	return {
		signing: { publicKey: keySet.signing.publicKey.toLowerCase() as PublicKey },
		encryption: { publicKey: keySet.encryption.publicKey.toLowerCase() as PublicKey }
	};
}

/** Whether two key sets have the same two public keys. */
export function sameKeySet(a: PublicKeySet, b: PublicKeySet): boolean {
	return (
		a.signing.publicKey.toLowerCase() === b.signing.publicKey.toLowerCase() &&
		a.encryption.publicKey.toLowerCase() === b.encryption.publicKey.toLowerCase()
	);
}

const proofCache = new Map<string, Promise<boolean>>();

/**
 * Whether `keySet` is a key set `address` authorized for an app of `domain`:
 * the ownership proof recovers `address` for `appOrigin` (delegated-identity's
 * `recoverAccount`), and `appOrigin` is an origin of `domain`. The server's word
 * is never enough.
 */
export function verifyOwnership(proof: {
	address: Address;
	domain: string;
	keySet: PublicKeySet;
	appOrigin: string;
	ownershipSignature: `0x${string}`;
}): Promise<boolean> {
	const cacheID = [
		proof.address,
		proof.domain,
		proof.keySet?.signing?.publicKey,
		proof.keySet?.encryption?.publicKey,
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
					keySet: proof.keySet,
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

/**
 * Whether a registered key set the server returned (`getDomainUser`'s current
 * one, or `getKeySet`'s) is what it claims: its keys proven by its wallet for
 * its domain, and its reference the `keySetRef` of its keys.
 */
export async function verifyKeySet(
	registered: Pick<
		RegisteredKeySet,
		'user' | 'domain' | 'keyRef' | 'keySet' | 'ownershipSignature' | 'appOrigin'
	>,
	expected: { address: Address; domain: string; keyRef?: string }
): Promise<boolean> {
	if (
		registered.user.toLowerCase() !== expected.address.toLowerCase() ||
		registered.domain !== expected.domain ||
		(expected.keyRef !== undefined && registered.keyRef !== expected.keyRef.toLowerCase())
	) {
		return false;
	}
	try {
		if ((await keySetRef(registered.keySet)) !== registered.keyRef) {
			return false;
		}
	} catch {
		return false;
	}
	return verifyOwnership({
		address: registered.user,
		domain: registered.domain,
		keySet: registered.keySet,
		appOrigin: registered.appOrigin,
		ownershipSignature: registered.ownershipSignature
	});
}

/** Whether a domain user the server returned is what it claims: its current key set proven by its wallet, for its domain. */
export function verifyDomainUser(
	domainUser: DomainUser,
	expected: { address: Address; domain: string }
): Promise<boolean> {
	return verifyKeySet(domainUser, expected);
}

export type MessageErrorCode =
	/** the sender's key set is not proven by the sender's wallet, or this message is not signed by it */
	| 'unverified'
	/** it is signed, but its content cannot be decrypted with this account's key set */
	| 'undecryptable';

// ------------------------------------------------------------------------------------------------
// the missiv message: one ciphertext per message (ADR-0004, ADR-0006)
// ------------------------------------------------------------------------------------------------

const keyRefCache = new Map<string, Promise<String0x>>();

/** The keyRef (delegated-identity's `keySetRef`) of a key set, cached. */
export function keyRefOf(keySet: PublicKeySet): Promise<String0x> {
	const cacheID = `${keySet.signing.publicKey}:${keySet.encryption.publicKey}`.toLowerCase();
	let keyRef = keyRefCache.get(cacheID);
	if (!keyRef) {
		keyRef = keySetRef(publicKeySetOf(keySet));
		keyRefCache.set(cacheID, keyRef);
		keyRef.catch(() => keyRefCache.delete(cacheID));
	}
	return keyRef;
}

/** Where a 1:1 message goes: the domain and namespace of the conversation of its two members. */
export type MessageDestination = { domain: string; namespace: string };

/**
 * A `pairwise-v1` message from `sender` to `recipient`, encrypted and signed:
 * one ciphertext both members read. `recipient.keySet` must be a verified key
 * set (`verifyDomainUser`); `keyID` names it and the sender's. `messageID` is a
 * fresh ULID unless given (a retry of the same message reuses its messageID
 * and signature).
 */
export async function composeMessage(params: {
	destination: MessageDestination;
	sender: { address: Address } & AccountKeys;
	recipient: { address: Address; keySet: PublicKeySet };
	text: string;
	messageID?: string;
}): Promise<MessageToSend> {
	const { keySet } = params.sender;
	const senderKeyRef = await keyRefOf(keySet);
	const recipientKeyRef = await keyRefOf(params.recipient.keySet);
	const header = {
		...messageHeaderFields(params),
		senderKeyRef,
		scheme: 'pairwise-v1' as const,
		keyID: pairwiseKeyID(senderKeyRef, recipientKeyRef)
	};
	const content = await encryptPairwise(
		header,
		params.text,
		keySet.encryption.privateKey,
		params.recipient.keySet.encryption.publicKey
	);
	const message = { ...header, content };
	return { ...message, signature: await signMessage(message, keySet.signing.privateKey) };
}

/**
 * A `clear` message (an introduction) from `sender` to `recipient`, signed: the
 * server and anyone it shows it to can read it. Only when the user asks, to
 * reach a recipient with no verified key set; never a fallback.
 */
export async function composeIntroduction(params: {
	destination: MessageDestination;
	sender: { address: Address } & AccountKeys;
	recipient: { address: Address };
	text: string;
	messageID?: string;
}): Promise<MessageToSend> {
	const message = {
		...messageHeaderFields(params),
		senderKeyRef: await keyRefOf(params.sender.keySet),
		scheme: 'clear' as const,
		keyID: null,
		content: params.text
	};
	return {
		...message,
		signature: await signMessage(message, params.sender.keySet.signing.privateKey)
	};
}

function messageHeaderFields(params: {
	destination: MessageDestination;
	sender: { address: Address };
	recipient: { address: Address };
	messageID?: string;
}) {
	const sender = params.sender.address.toLowerCase() as Address;
	const recipient = params.recipient.address.toLowerCase() as Address;
	if (sender === recipient) {
		throw new Error('a 1:1 message goes to another account');
	}
	return {
		domain: params.destination.domain,
		namespace: params.destination.namespace,
		conversationID: conversationIDOf([sender, recipient]),
		messageID: params.messageID ?? newULID(),
		sender
	};
}

/** Where `openMessage` reads key sets by keyRef: `API`'s `getKeySet`, or anything answering as it does. */
export type KeySetSource = {
	getKeySet(action: ActionGetKeySet): Promise<ResponseGetKeySet>;
};

const keySetCaches = new WeakMap<
	KeySetSource,
	Map<string, Promise<RegisteredKeySet | undefined>>
>();

/**
 * A registered key set by (domain, keyRef), as `source` answers it. A key set
 * never changes once registered, so the answer is cached per source (checked
 * on every use all the same); a fetch that throws is not.
 */
function fetchKeySet(
	source: KeySetSource,
	domain: string,
	keyRef: String0x
): Promise<RegisteredKeySet | undefined> {
	let cache = keySetCaches.get(source);
	if (!cache) {
		cache = new Map();
		keySetCaches.set(source, cache);
	}
	const cacheID = `${domain}:${keyRef}`;
	let keySet = cache.get(cacheID);
	if (!keySet) {
		keySet = source.getKeySet({ type: 'getKeySet', domain, keyRef }).then((r) => r.keySet);
		cache.set(cacheID, keySet);
		keySet.catch(() => cache.delete(cacheID));
	}
	return keySet;
}

/** A message as the client shows it: its text, or why it cannot be shown. */
export type OpenedMessage = Omit<Message, 'content'> &
	(
		| { content: string; error?: undefined }
		| { content?: undefined; error: { code: MessageErrorCode; message: string } }
	);

const openedCache = new Map<string, OpenedMessage>();

/**
 * Check one message and decrypt it for the reader: the sender's key set,
 * fetched by `senderKeyRef` through `getKeySet` (current or replaced), against
 * its keyRef and the sender's ownership proof; the signature against its
 * signing key; then, for `pairwise-v1`, the ciphertext with the key of the two
 * key sets `keyID` names, one of which must be the reader's. The sender reading
 * its own message fetches the other key set of `keyID` the same way (its
 * keyRef, which the signature covers, is all it needs checking against).
 *
 * Each message on its own, so one bad message never hides the others: a
 * message that fails a check is `unverified`, one that is signed but cannot be
 * read with the reader's key set (another keyID, a replaced key set, a
 * tampered ciphertext, an unknown scheme) is `undecryptable`. Neither is
 * thrown. A `getKeySet` that throws (the server unreachable) is not a verdict
 * on the message: it is thrown, and nothing is cached, so a later call retries.
 */
export async function openMessage(
	message: Message,
	reader: { address: Address; domain: string } & AccountKeys,
	keySets: KeySetSource
): Promise<OpenedMessage> {
	const readerKeys = reader.keySet;
	// everything the verdict depends on: every signed field, and whose keys read it
	const cacheID = JSON.stringify([
		message.domain,
		message.namespace,
		message.conversationID,
		message.messageID,
		message.sender,
		message.senderKeyRef,
		message.scheme,
		message.keyID,
		message.content,
		message.signature,
		reader.address,
		reader.domain,
		readerKeys.encryption.publicKey
	]);
	const cached = openedCache.get(cacheID);
	if (cached) {
		return cached;
	}
	const { content, ...rest } = message;
	const fail = (code: MessageErrorCode, text: string): OpenedMessage => ({
		...rest,
		error: { code, message: text }
	});
	const opened = await (async (): Promise<OpenedMessage> => {
		const unverified = () => fail('unverified', 'this message is not signed by its sender');
		const undecryptable = () =>
			fail('undecryptable', 'this message cannot be decrypted with this key set');

		if (!(MESSAGE_SCHEMES as readonly string[]).includes(message.scheme)) {
			// a later scheme (sender-key-v1, mls-v1) this client does not read
			return undecryptable();
		}
		const parsed = MessageSchema.safeParse(message);
		if (!parsed.success || message.domain !== reader.domain) {
			return unverified();
		}
		const valid = parsed.data;
		// a 1:1 conversationID (two addresses, in getConversationID's order) names its sender
		const pair = /^0x[0-9a-f]{40}0x[0-9a-f]{40}$/.test(valid.conversationID);
		const members = membersOfConversationID(valid.conversationID);
		if (pair && !members?.includes(valid.sender)) {
			return unverified();
		}
		const senderKeySet = await fetchKeySet(keySets, valid.domain, valid.senderKeyRef);
		if (
			!senderKeySet ||
			!(await verifyKeySet(senderKeySet, {
				address: valid.sender,
				domain: valid.domain,
				keyRef: valid.senderKeyRef
			})) ||
			!(await verifyMessage(valid, senderKeySet.keySet.signing.publicKey))
		) {
			return unverified();
		}
		if (valid.scheme === 'clear') {
			// a clear message is shown only to a member of its conversation: one the
			// server moved in from a conversation the reader is not in is refused, as
			// 0.5's recipient check did (an encrypted one is undecryptable there anyway)
			if (pair && !members?.includes(reader.address.toLowerCase() as Address)) {
				return unverified();
			}
			return { ...rest, content: valid.content };
		}
		const keyRefs = keyRefsOfPairwiseKeyID(valid.keyID);
		const readerKeyRef = await keyRefOf(readerKeys);
		if (!keyRefs.includes(valid.senderKeyRef) || !keyRefs.includes(readerKeyRef)) {
			return undecryptable();
		}
		let otherEncryptionKey: PublicKey;
		if (readerKeyRef === valid.senderKeyRef) {
			const otherKeyRef = keyRefs[0] === readerKeyRef ? keyRefs[1] : keyRefs[0];
			const other = await fetchKeySet(keySets, valid.domain, otherKeyRef);
			if (!other || (await keyRefOf(other.keySet).catch(() => undefined)) !== otherKeyRef) {
				return undecryptable();
			}
			otherEncryptionKey = other.keySet.encryption.publicKey;
		} else {
			otherEncryptionKey = senderKeySet.keySet.encryption.publicKey;
		}
		try {
			const text = await decryptPairwise(
				valid,
				readerKeys.encryption.privateKey,
				otherEncryptionKey
			);
			return { ...rest, content: text };
		} catch {
			return undecryptable();
		}
	})();
	openedCache.set(cacheID, opened);
	return opened;
}
