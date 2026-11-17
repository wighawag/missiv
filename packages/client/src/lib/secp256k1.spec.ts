// The primitives missiv's messages rest on: a delegate key's recoverable
// signature, ECDH between two keys, and xchacha20poly1305 under keccak256 of the
// shared secret. Moved here from the retired test/end-to-end.
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { utf8ToBytes } from '@noble/ciphers/utils';
import { randomBytes } from '@noble/ciphers/webcrypto';

import { describe, expect, it } from 'vitest';

describe('@noble/secp256k1', () => {
	it('encrypt / decrypt via shared key', async () => {
		const bobPrivKey = secp.utils.randomPrivateKey();
		const bobPubKey = secp.getPublicKey(bobPrivKey);

		const msgHash = keccak_256(utf8ToBytes('hello'));
		const signatureObject = await secp.signAsync(msgHash, bobPrivKey); // Sync methods below
		const signatureString = `${signatureObject.toCompactHex()}:${signatureObject.recovery}`;

		const splitted = signatureString.split(':');
		const recoveryBit = Number(splitted[1]);
		const signature = secp.Signature.fromCompact(splitted[0]).addRecoveryBit(recoveryBit);

		const isValid = secp.verify(signature, msgHash, bobPubKey);
		expect(isValid).toBe(true);
		const recoveredPubKey = signature.recoverPublicKey(msgHash); // Public key recovery
		expect(recoveredPubKey.toRawBytes()).toEqual(bobPubKey);

		// console.log(recoveredPubKey.toHex());

		const alicesPrivKey = secp.utils.randomPrivateKey();
		const alicesPubkey = secp.getPublicKey(alicesPrivKey);
		const sharedKey = secp.getSharedSecret(bobPrivKey, alicesPubkey); // Elliptic curve diffie-hellman

		const sharedKeyFromAlice = secp.getSharedSecret(alicesPrivKey, bobPubKey);
		expect(sharedKeyFromAlice).toEqual(sharedKey);

		const sharedSecret = keccak_256(sharedKey);

		const nonce = randomBytes(24);
		const chacha = xchacha20poly1305(sharedSecret, nonce);
		const data = utf8ToBytes('hello, noble');
		const ciphertext = chacha.encrypt(data);
		const recoveredData = chacha.decrypt(ciphertext); // ut
		expect(recoveredData).toEqual(data);
	});
});
