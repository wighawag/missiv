// The per-message signature: the sender's Ed25519 signing key (its key set's,
// as the wallet's publication names it) signs each copy of a message as stored
// (the ciphertext for an encrypted copy, the text for a clear one), so a reader
// attributes it to its sender without decrypting it and without trusting the
// server. The server stores it and never checks it; the reading client does
// (@missiv/client's `openMessage`).
//
// 0.5's per-copy format on 0.6's keys, an interim until the one-ciphertext
// message format (ADR-0004, ADR-0006) replaces it. Ed25519 through
// `delegated-identity/ed25519`, so missiv accepts exactly the signatures the
// request verifiers accept.
import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';
import {ed25519Sign, ed25519Verify} from 'delegated-identity/ed25519';

type Hex = `0x${string}`;

/** One copy of a message, as the sender signs it and the reader checks it. */
export type MessageCopyToSign = {
	domain: string;
	namespace: string;
	conversationID: string;
	messageType: 'encrypted' | 'clear';
	/** the sender's address */
	from: Hex;
	/** the recipient of this copy */
	to: Hex;
	/** the X25519 encryption key this copy is encrypted to; none for a clear copy */
	toPublicKey?: Hex | null;
	/** the content as stored */
	content: string;
};

/**
 * What a sender's signing key signs for one copy (Ed25519 over its UTF-8
 * bytes). Its purpose line sets it apart from delegated-identity's request
 * envelope, signed by the same key. A copy moved to another recipient, key,
 * conversation, namespace or domain verifies for none of them.
 */
export function messageCopyMessage(copy: MessageCopyToSign): string {
	return [
		'missiv message copy v2',
		`domain: ${copy.domain}`,
		`namespace: ${copy.namespace}`,
		`conversation: ${copy.conversationID}`,
		`type: ${copy.messageType}`,
		`from: ${copy.from.toLowerCase()}`,
		`to: ${copy.to.toLowerCase()}`,
		`key: ${copy.toPublicKey ? copy.toPublicKey.toLowerCase() : 'none'}`,
		`content: 0x${bytesToHex(keccak_256(copy.content))}`,
	].join('\n');
}

const utf8 = new TextEncoder();

function toBytes(key: Uint8Array | string): Uint8Array {
	if (typeof key !== 'string') {
		return key;
	}
	return hexToBytes(key.startsWith('0x') ? key.slice(2) : key);
}

/** Sign one copy with the sender's Ed25519 signing private key: `0x` + the 64-byte signature. */
export async function signMessageCopy(copy: MessageCopyToSign, signingPrivateKey: Uint8Array | string): Promise<Hex> {
	const seed = toBytes(signingPrivateKey);
	if (seed.length !== 32) {
		throw new Error(`an Ed25519 private key is 32 bytes, got ${seed.length}`);
	}
	return `0x${bytesToHex(await ed25519Sign(utf8.encode(messageCopyMessage(copy)), seed))}`;
}

/**
 * Whether `signingPublicKey` (the Ed25519 key of the sender's key set, checked
 * against its ownership proof first) signed this copy. False on a malformed
 * signature or key, never a throw.
 */
export async function verifyMessageCopy(
	copy: MessageCopyToSign & {signature: string},
	signingPublicKey: string,
): Promise<boolean> {
	if (!/^0x[0-9a-fA-F]{128}$/.test(copy.signature) || !/^0x[0-9a-fA-F]{64}$/.test(signingPublicKey)) {
		return false;
	}
	try {
		return await ed25519Verify(
			hexToBytes(copy.signature.slice(2)),
			utf8.encode(messageCopyMessage(copy)),
			hexToBytes(signingPublicKey.slice(2)),
		);
	} catch {
		return false;
	}
}
