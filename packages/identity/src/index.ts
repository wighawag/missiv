// An account's identity across services. A wallet authorizes a DELEGATE key for
// an app's origin once (the ownership proof: an EIP-191 signature over the
// publication message), and the delegate key then signs each request (the
// request signature: over an envelope naming the server, the route, the time and
// the body). A service recovers both and so learns, without a wallet prompt per
// request, which account a request speaks for.
//
// missiv's server, push-notification-server and the trigger service check this
// same pair, so it lives here once.

import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';
import {getPublicKey, Signature, signAsync} from '@noble/secp256k1';
import {hashMessage, recoverMessageAddress} from 'viem';

export type Address = `0x${string}`;
/** A secp256k1 public key, compressed, as 0x-prefixed lowercase hex. */
export type PublicKey = `0x${string}`;
type PrivateKey = Uint8Array | `0x${string}`;

/** The HTTP header carrying the request signature: `<timestamp ms>:<compact signature hex>:<recovery bit>`. */
export const REQUEST_SIGNATURE_HEADER = 'SIGNATURE';

/** How far a request's timestamp may be from the server's clock, either way. */
export const DEFAULT_MAX_REQUEST_AGE_MS = 60_000;

/**
 * The origin an app's ownership proofs name, from what an app calls its domain:
 * an origin (`https://...` or `http://...`) is kept as it is; a bare host is
 * `http://` for localhost and `https://` otherwise.
 */
export function fromDomainToOrigin(domain: string): string {
	if (domain.startsWith('https://') || domain.startsWith('http://')) {
		return domain;
	}
	if (domain === 'localhost' || domain.startsWith('localhost:')) {
		return `http://${domain}`;
	}
	return `https://${domain}`;
}

/**
 * The message a wallet signs to authorize a delegate key for an app's origin.
 * Its text is fixed: it is byte-identical to `@etherplay/connect-core`'s, which
 * hosted accounts signed once and cannot sign again.
 */
export function originPublicKeyPublicationMessage(orig: string, publicKey: `0x${string}`): string {
	return `Origin: ${orig}\n\nIMPORTANT: Only sign on trusted websites.\n\nThis authorizes the following Public Key to represent your account:\n\n${publicKey}\n\nOthers can use this key to write encrypted messages to you securely.`;
}

function toPrivateKeyBytes(privateKey: PrivateKey): Uint8Array {
	return typeof privateKey === 'string' ? hexToBytes(privateKey.slice(2)) : privateKey;
}

/** The public key of a delegate private key, in the form the proofs name it. */
export function delegatePublicKey(privateKey: PrivateKey): PublicKey {
	return `0x${bytesToHex(getPublicKey(toPrivateKeyBytes(privateKey)))}`;
}

/**
 * The account (lowercase) whose wallet signed the ownership proof of this
 * delegate key for this app origin. A proof for another key or another origin
 * recovers another account. Throws on a malformed signature.
 */
export async function recoverAccount(proof: {
	appOrigin: string;
	publicKey: PublicKey;
	ownershipSignature: `0x${string}`;
}): Promise<Address> {
	const message = originPublicKeyPublicationMessage(proof.appOrigin, proof.publicKey);
	const address = await recoverMessageAddress({message, signature: proof.ownershipSignature});
	return address.toLowerCase() as Address;
}

/** What a request signature covers: which server, which route, when, and the body. */
export type RequestToSign = {
	/** the origin of the server the request is for, e.g. `https://push.example` */
	serverOrigin: string;
	/** the HTTP method, e.g. `POST` */
	method: string;
	/** the path and query, e.g. `/api/register` */
	path: string;
	/** the raw body, exactly as sent (`''` for none) */
	body: string;
};

/**
 * The envelope a delegate key signs (EIP-191, so it can never be a transaction
 * hash): a purpose line, then the server origin, the route, the timestamp and
 * the body's keccak256. A signature for one server, route or body verifies for
 * no other.
 */
export function requestMessage(request: RequestToSign & {timestamp: number}): string {
	return [
		'missiv-identity request v1',
		`origin: ${request.serverOrigin}`,
		`route: ${request.method.toUpperCase()} ${request.path}`,
		`timestamp: ${request.timestamp}`,
		`body: 0x${bytesToHex(keccak_256(request.body))}`,
	].join('\n');
}

/** Sign a request with the delegate key: the value of the SIGNATURE header. */
export async function signRequest(
	request: RequestToSign & {timestamp?: number},
	delegatePrivateKey: PrivateKey,
): Promise<string> {
	const timestamp = request.timestamp ?? Date.now();
	const hash = hexToBytes(hashMessage(requestMessage({...request, timestamp})).slice(2));
	const signature = await signAsync(hash, toPrivateKeyBytes(delegatePrivateKey));
	return `${timestamp}:${signature.toCompactHex()}:${signature.recovery}`;
}

export type RecoveredRequest =
	| {ok: true; publicKey: PublicKey; timestamp: number}
	| {ok: false; reason: 'malformed' | 'expired'};

/**
 * The delegate key that signed this request. A valid signature over another
 * request recovers another key, so the caller compares the result with the key
 * it expects (a registered key, or the one the ownership proof names).
 * `expired` when its timestamp is further than `maxAgeMs` from `now`. A server
 * that must refuse a replay within the window keeps the signatures it accepted
 * for that long.
 */
export function recoverRequestSigner(
	request: RequestToSign & {signature: string},
	options?: {now?: number; maxAgeMs?: number},
): RecoveredRequest {
	const parts = request.signature.split(':');
	if (
		parts.length !== 3 ||
		!/^[0-9]+$/.test(parts[0]) ||
		!/^[0-9a-fA-F]{128}$/.test(parts[1]) ||
		!/^[01]$/.test(parts[2])
	) {
		return {ok: false, reason: 'malformed'};
	}
	const timestamp = Number(parts[0]);
	const now = options?.now ?? Date.now();
	if (Math.abs(now - timestamp) > (options?.maxAgeMs ?? DEFAULT_MAX_REQUEST_AGE_MS)) {
		return {ok: false, reason: 'expired'};
	}
	try {
		const hash = hexToBytes(hashMessage(requestMessage({...request, timestamp})).slice(2));
		const signature = Signature.fromCompact(parts[1]).addRecoveryBit(Number(parts[2]));
		const publicKey = `0x${signature.recoverPublicKey(hash).toHex().toLowerCase()}` as PublicKey;
		return {ok: true, publicKey, timestamp};
	} catch {
		return {ok: false, reason: 'malformed'};
	}
}

export type VerifiedRequest =
	| {ok: true; address: Address; publicKey: PublicKey; timestamp: number}
	| {ok: false; reason: 'malformed' | 'expired' | 'not-authorized'};

/**
 * Both proofs together: does this request, signed by a delegate key, speak for
 * `address` in the app at `appOrigin`? `malformed` when a signature cannot be
 * parsed; `expired` outside the time window; `not-authorized` when the proofs
 * are well formed but do not recover `address` (another account's proof, a
 * proof for another app origin, a request signed by another key, or for another
 * server, route or body).
 */
export async function verifyRequest(
	request: RequestToSign & {
		signature: string;
		appOrigin: string;
		address: string;
		ownershipSignature: `0x${string}`;
	},
	options?: {now?: number; maxAgeMs?: number},
): Promise<VerifiedRequest> {
	const signer = recoverRequestSigner(request, options);
	if (!signer.ok) {
		return signer;
	}
	let recovered: Address;
	try {
		recovered = await recoverAccount({
			appOrigin: request.appOrigin,
			publicKey: signer.publicKey,
			ownershipSignature: request.ownershipSignature,
		});
	} catch {
		return {ok: false, reason: 'malformed'};
	}
	if (recovered !== request.address.toLowerCase()) {
		return {ok: false, reason: 'not-authorized'};
	}
	return {ok: true, address: recovered, publicKey: signer.publicKey, timestamp: signer.timestamp};
}
