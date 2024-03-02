import * as secp from '@noble/secp256k1';
import { webcrypto } from 'node:crypto';
// @ts-ignore
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { keccak_256 } from '@noble/hashes/sha3';

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { utf8ToBytes } from '@noble/ciphers/utils';
import { randomBytes } from '@noble/ciphers/webcrypto';

import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';

function publicKeyToAddress(publicKey: `0x${string}`): `0x${string}` {
	const publicKeyRaw = secp.ProjectivePoint.fromHex(publicKey.slice(2)).toRawBytes(false);
	return (`0x` + toHex(keccak_256(publicKeyRaw.slice(1))).slice(26)) as `0x${string}`;
}

function toHex(arr: Uint8Array): `0x${string}` {
	let str = `0x`;
	for (const element of arr) {
		str += element.toString(16).padStart(2, '0');
	}
	return str as `0x${string}`;
}

describe('@noble/secp256k1', () => {
	it('encrypt / decrypt via shared key', async () => {
		const bobPrivKey = secp.utils.randomPrivateKey();
		const bobPubKey = secp.getPublicKey(bobPrivKey);

		const msgHash = keccak_256(utf8ToBytes('hello'));
		const signature = await secp.signAsync(msgHash, bobPrivKey); // Sync methods below

		const isValid = secp.verify(signature, msgHash, bobPubKey);
		expect(isValid).toBe(true);
		const recoveredPubKey = signature.recoverPublicKey(msgHash); // Public key recovery
		expect(recoveredPubKey.toRawBytes()).toEqual(bobPubKey);

		const alicesPrivKey = secp.utils.randomPrivateKey();
		const alicesPubkey = secp.getPublicKey(alicesPrivKey);
		const sharedKey = secp.getSharedSecret(bobPrivKey, alicesPubkey); // Elliptic curve diffie-hellman

		const sharedKeyFromAlice = secp.getSharedSecret(alicesPrivKey, bobPubKey);
		expect(sharedKeyFromAlice).toEqual(sharedKey);

		const sharedSecret = keccak_256(sharedKey);
		const conversationID = keccak_256(sharedSecret);

		const nonce = randomBytes(24);
		const chacha = xchacha20poly1305(sharedSecret, nonce);
		const data = utf8ToBytes('hello, noble');
		const ciphertext = chacha.encrypt(data);
		const recoveredData = chacha.decrypt(ciphertext); // ut
		expect(recoveredData).toEqual(data);
	});
});
