// An account's identity across services: a wallet authorizes a DELEGATE key for
// an origin once (the ownership proof, an EIP-191 signature over the publication
// message), and the delegate key then signs each request (the request signature,
// over the raw body). A service recovers both and so learns, without a wallet
// prompt per request, which account a request speaks for.
//
// missiv's server, push-notification-server and the trigger service all check
// this same pair, so it lives here once.

import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';
import {getPublicKey, Signature, signAsync} from '@noble/secp256k1';
import {recoverMessageAddress} from 'viem';

export type Address = `0x${string}`;
/** A secp256k1 public key, compressed, as 0x-prefixed lowercase hex. */
export type PublicKey = `0x${string}`;

/** The HTTP header carrying the request signature. */
export const REQUEST_SIGNATURE_HEADER = 'SIGNATURE';

/** The origin a domain's ownership proofs name: `https://<domain>`, or `http://` for localhost. */
export function fromDomainToOrigin(domain: string): string {
	if (domain.startsWith('https://')) {
		return domain;
	}
	if (domain === 'localhost' || domain.startsWith('localhost:')) {
		return `http://${domain}`;
	}
	return `https://${domain}`;
}

/**
 * The message a wallet signs to authorize a delegate key for an origin. Its text
 * is fixed: every proof already made was signed over it, byte for byte.
 */
export function originPublicKeyPublicationMessage(orig: string, publicKey: `0x${string}`): string {
	return `Origin: ${orig}\n\nIMPORTANT: Only sign on trusted websites.\n\nThis authorizes the following Public Key to represent your account:\n\n${publicKey}\n\nOthers can use this key to write encrypted messages to you securely.`;
}

function toPrivateKeyBytes(privateKey: Uint8Array | `0x${string}`): Uint8Array {
	return typeof privateKey === 'string' ? hexToBytes(privateKey.slice(2)) : privateKey;
}

/** The public key of a delegate private key, in the form the proofs name it. */
export function delegatePublicKey(privateKey: Uint8Array | `0x${string}`): PublicKey {
	return `0x${bytesToHex(getPublicKey(toPrivateKeyBytes(privateKey)))}`;
}

/** Sign a request body with the delegate key: the value of the SIGNATURE header, `<compact hex>:<recovery bit>`. */
export async function signRequest(body: string, delegatePrivateKey: Uint8Array | `0x${string}`): Promise<string> {
	const signature = await signAsync(keccak_256(body), toPrivateKeyBytes(delegatePrivateKey));
	return `${signature.toCompactHex()}:${signature.recovery}`;
}

/**
 * The delegate key that signed this body. A valid signature over another body
 * recovers another key, so the caller compares the result with the key it
 * expects. Throws on a malformed signature.
 */
export function recoverRequestSigner(requestSignature: string, body: string): PublicKey {
	const splitted = requestSignature.split(':');
	const recoveryBit = Number(splitted[1]);
	const signature = Signature.fromCompact(splitted[0]).addRecoveryBit(recoveryBit);
	const msgHash = keccak_256(body);
	const recoveredPubKey = signature.recoverPublicKey(msgHash);
	return `0x${recoveredPubKey.toHex().toLowerCase()}` as PublicKey;
}

/**
 * The account (lowercase) whose wallet signed the ownership proof of this
 * delegate key for this domain. A proof for another key or another domain
 * recovers another account. Throws on a malformed signature.
 */
export async function recoverAccount(proof: {
	domain: string;
	publicKey: PublicKey;
	ownershipSignature: `0x${string}`;
}): Promise<Address> {
	const message = originPublicKeyPublicationMessage(fromDomainToOrigin(proof.domain), proof.publicKey);
	const address = await recoverMessageAddress({message, signature: proof.ownershipSignature});
	return address.toLowerCase() as Address;
}

export type VerifiedRequest =
	| {ok: true; address: Address; publicKey: PublicKey}
	| {ok: false; reason: 'malformed' | 'not-authorized'};

/**
 * Both proofs together: does this request, signed by a delegate key, speak for
 * `address` on `domain`? `malformed` when a signature cannot be parsed;
 * `not-authorized` when the proofs are well formed but do not recover `address`
 * (another account's proof, a proof for another domain, a body signed by
 * another key, a body changed after signing).
 */
export async function verifyRequest(request: {
	domain: string;
	body: string;
	requestSignature: string;
	address: string;
	ownershipSignature: `0x${string}`;
}): Promise<VerifiedRequest> {
	let publicKey: PublicKey;
	let recovered: Address;
	try {
		publicKey = recoverRequestSigner(request.requestSignature, request.body);
		recovered = await recoverAccount({
			domain: request.domain,
			publicKey,
			ownershipSignature: request.ownershipSignature,
		});
	} catch {
		return {ok: false, reason: 'malformed'};
	}
	if (recovered !== request.address.toLowerCase()) {
		return {ok: false, reason: 'not-authorized'};
	}
	return {ok: true, address: recovered, publicKey};
}
