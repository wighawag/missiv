// The per-message signature: the sender's delegate key signs each copy of a
// message as stored (the ciphertext for an encrypted copy, the text for a clear
// one), so a reader attributes it to its sender without decrypting it and
// without trusting the server. The server stores it and never checks it; the
// reading client does (@missiv/client's `openMessage`).
import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';
import {Signature, signAsync} from '@noble/secp256k1';

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
	/** the key this copy is encrypted to; none for a clear copy */
	toPublicKey?: Hex | null;
	/** the content as stored */
	content: string;
};

/**
 * What a sender's delegate key signs for one copy (EIP-191, so it can never be a
 * transaction hash, and its purpose line sets it apart from delegated-identity's
 * request envelope signed by the same key). A copy moved to another recipient,
 * key, conversation, namespace or domain verifies for none of them.
 */
export function messageCopyMessage(copy: MessageCopyToSign): string {
	return [
		'missiv message v1',
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

/** EIP-191 (`personal_sign`): keccak256 of "\x19Ethereum Signed Message:\n" + the byte length + the message. */
function hashMessage(message: string): Uint8Array {
	const bytes = utf8.encode(message);
	const prefix = utf8.encode(`\x19Ethereum Signed Message:\n${bytes.length}`);
	const prefixed = new Uint8Array(prefix.length + bytes.length);
	prefixed.set(prefix);
	prefixed.set(bytes, prefix.length);
	return keccak_256(prefixed);
}

function toPrivateKeyBytes(privateKey: Uint8Array | string): Uint8Array {
	if (typeof privateKey !== 'string') {
		return privateKey;
	}
	return hexToBytes(privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey);
}

/** Sign one copy with the sender's delegate key: `0x` + the 64-byte compact signature + the recovery byte. */
export async function signMessageCopy(copy: MessageCopyToSign, delegatePrivateKey: Uint8Array | string): Promise<Hex> {
	const signature = await signAsync(hashMessage(messageCopyMessage(copy)), toPrivateKeyBytes(delegatePrivateKey));
	return `0x${signature.toCompactHex()}0${signature.recovery}`;
}

/**
 * The delegate key (compressed, lowercase hex) that signed this copy, or
 * undefined when the signature is malformed. A signature over another copy
 * recovers another key: compare the result with the key the sender's ownership
 * proof names.
 */
export function recoverMessageCopySigner(copy: MessageCopyToSign & {signature: string}): Hex | undefined {
	if (!/^0x[0-9a-fA-F]{128}0[01]$/.test(copy.signature)) {
		return undefined;
	}
	try {
		const signature = Signature.fromCompact(copy.signature.slice(2, 130)).addRecoveryBit(
			Number(copy.signature.slice(131)),
		);
		return `0x${signature
			.recoverPublicKey(hashMessage(messageCopyMessage(copy)))
			.toHex()
			.toLowerCase()}`;
	} catch {
		return undefined;
	}
}
