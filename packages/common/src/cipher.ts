// The one cipher module of missiv's messages (ADR-0004 decision 2, ADR-0006
// "Crypto availability"): X25519 agreement, HKDF-SHA256 and AES-256-GCM through
// WebCrypto when the runtime has `crypto.subtle` (current browsers, Node,
// Cloudflare Workers, Bun), `@noble/curves`, `@noble/hashes` and
// `@noble/ciphers` otherwise (older browsers, and plain-http origins such as a
// LAN dev stack, which are not a secure context and so have no
// `crypto.subtle`). Both paths give the same bytes: the test vectors run on
// both (`cipher.test.ts`, `message.test.ts`).
//
// X25519 through WebCrypto is used only when it computes RFC 7748's test
// vector (Firefox 130, Chrome 133, Safari 17, Node, Workers, Bun 1.3.13): a
// runtime with `crypto.subtle` but no X25519 agrees in `@noble` and keeps
// WebCrypto for HKDF and AES-GCM. Ed25519 and SHA-256 are not here: they are
// `delegated-identity/ed25519`'s, so missiv accepts exactly the signatures its
// request verifiers accept.
//
// The backend switch is not exported from the package: tests import it from
// this module to force a backend.
import {gcm} from '@noble/ciphers/aes';
import {x25519} from '@noble/curves/ed25519';
import {hkdf} from '@noble/hashes/hkdf';
import {sha256} from '@noble/hashes/sha2';
import {hexToBytes} from '@noble/hashes/utils';

export type CipherBackend = 'webcrypto' | 'noble';

let forced: CipherBackend | undefined;
let x25519Detected: Promise<boolean> | undefined;

/** Force a backend (tests), or `undefined` to detect it again. */
export function setCipherBackend(backend: CipherBackend | undefined): void {
	forced = backend;
	x25519Detected = undefined;
}

function subtle(): SubtleCrypto | undefined {
	if (forced === 'noble') {
		return undefined;
	}
	return (globalThis as {crypto?: Crypto}).crypto?.subtle;
}

/** The backend HKDF and AES-GCM use: WebCrypto when `crypto.subtle` exists, `@noble` otherwise. */
export function cipherBackend(): CipherBackend {
	return subtle() ? 'webcrypto' : 'noble';
}

/** A copy whose buffer is a plain ArrayBuffer, as WebCrypto's types want. */
function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(bytes);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

// The PKCS #8 wrapping of a raw X25519 private key (RFC 8410): WebCrypto imports
// a private key only in this form or as a JWK.
const PKCS8_X25519_PREFIX = hexToBytes('302e020100300506032b656e04220420');

async function webCryptoX25519(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
	const webCrypto = subtle()!;
	const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + privateKey.length);
	pkcs8.set(PKCS8_X25519_PREFIX);
	pkcs8.set(privateKey, PKCS8_X25519_PREFIX.length);
	const ownKey = await webCrypto.importKey('pkcs8', pkcs8, {name: 'X25519'}, false, ['deriveBits']);
	const otherKey = await webCrypto.importKey('raw', buffer(publicKey), {name: 'X25519'}, false, []);
	return new Uint8Array(
		await webCrypto.deriveBits({name: 'X25519', public: otherKey} as EcdhKeyDeriveParams, ownKey, 256),
	);
}

// RFC 7748, section 6.1: Alice's private key, Bob's public key, their shared secret.
const PROBE_PRIVATE_KEY = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
const PROBE_PUBLIC_KEY = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';
const PROBE_SHARED_SECRET = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';

function webCryptoHasX25519(): Promise<boolean> {
	x25519Detected ??= (async () => {
		try {
			const secret = await webCryptoX25519(hexToBytes(PROBE_PRIVATE_KEY), hexToBytes(PROBE_PUBLIC_KEY));
			return equalBytes(secret, hexToBytes(PROBE_SHARED_SECRET));
		} catch {
			return false;
		}
	})();
	return x25519Detected;
}

/** The backend X25519 uses: WebCrypto when it computes RFC 7748's vector, `@noble` otherwise. */
export async function x25519Backend(): Promise<CipherBackend> {
	return subtle() && (await webCryptoHasX25519()) ? 'webcrypto' : 'noble';
}

/**
 * The X25519 shared secret (32 bytes) of a private key and another's public
 * key. Throws on a malformed key and on a low-order public key (an all-zero
 * secret), on both paths.
 */
export async function x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
	if (privateKey.length !== 32 || publicKey.length !== 32) {
		throw new Error('an X25519 key is 32 bytes');
	}
	if ((await x25519Backend()) === 'webcrypto') {
		const secret = await webCryptoX25519(privateKey, publicKey);
		if (secret.every((byte) => byte === 0)) {
			throw new Error('invalid public key: low order');
		}
		return secret;
	}
	return x25519.getSharedSecret(privateKey, publicKey);
}

/** HKDF-SHA256 (RFC 5869) with an empty salt: `length` bytes of `ikm` for `info`. */
export async function hkdfSha256(ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const webCrypto = subtle();
	if (webCrypto) {
		const key = await webCrypto.importKey('raw', buffer(ikm), 'HKDF', false, ['deriveBits']);
		return new Uint8Array(
			await webCrypto.deriveBits(
				{name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: buffer(info)},
				key,
				length * 8,
			),
		);
	}
	return hkdf(sha256, ikm, new Uint8Array(0), info, length);
}

/** AES-256-GCM encryption with a 96-bit IV and a 128-bit tag: the ciphertext then the tag. */
export async function aesGcmEncrypt(
	key: Uint8Array,
	iv: Uint8Array,
	plaintext: Uint8Array,
	associatedData: Uint8Array,
): Promise<Uint8Array> {
	checkAesGcm(key, iv);
	const webCrypto = subtle();
	if (webCrypto) {
		const cryptoKey = await webCrypto.importKey('raw', buffer(key), 'AES-GCM', false, ['encrypt']);
		return new Uint8Array(
			await webCrypto.encrypt(
				{name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(associatedData), tagLength: 128},
				cryptoKey,
				buffer(plaintext),
			),
		);
	}
	return gcm(key, iv, associatedData).encrypt(plaintext);
}

/** AES-256-GCM decryption of the ciphertext then the tag. Throws when the tag does not authenticate it. */
export async function aesGcmDecrypt(
	key: Uint8Array,
	iv: Uint8Array,
	sealed: Uint8Array,
	associatedData: Uint8Array,
): Promise<Uint8Array> {
	checkAesGcm(key, iv);
	if (sealed.length < 16) {
		throw new Error('an AES-GCM ciphertext ends with its 16-byte tag');
	}
	const webCrypto = subtle();
	if (webCrypto) {
		const cryptoKey = await webCrypto.importKey('raw', buffer(key), 'AES-GCM', false, ['decrypt']);
		return new Uint8Array(
			await webCrypto.decrypt(
				{name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(associatedData), tagLength: 128},
				cryptoKey,
				buffer(sealed),
			),
		);
	}
	return gcm(key, iv, associatedData).decrypt(sealed);
}

function checkAesGcm(key: Uint8Array, iv: Uint8Array): void {
	if (key.length !== 32) {
		throw new Error('an AES-256 key is 32 bytes');
	}
	if (iv.length !== 12) {
		throw new Error('an AES-GCM IV is 96 bits');
	}
}

/** `length` random bytes: `crypto.getRandomValues` exists on plain-http origins too. */
export function randomBytes(length: number): Uint8Array {
	return (globalThis as {crypto: Crypto}).crypto.getRandomValues(new Uint8Array(length));
}
