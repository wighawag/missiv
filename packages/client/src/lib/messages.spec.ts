// The primitives missiv's messages rest on since 0.6's keys: a key set derived
// by delegated-identity (never a copy of the derivation here), a copy's Ed25519
// signature, and the public half of a key set as it is registered and sent.
import { deriveKeySet } from 'delegated-identity';
import { signMessageCopy, verifyMessageCopy, type MessageCopyToSign } from '@missiv/common';
import { describe, expect, it } from 'vitest';
import { publicKeySetOf, sameKeySet } from './messages.js';

const origin = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;

describe('a copy signature', () => {
	const alice = deriveKeySet(origin('11'));
	const bob = deriveKeySet(origin('22'));
	const copy: MessageCopyToSign = {
		domain: 'test.com',
		namespace: 'test',
		conversationID: 'c',
		messageType: 'encrypted',
		from: '0x000000000000000000000000000000000000000a',
		to: '0x000000000000000000000000000000000000000b',
		toPublicKey: bob.encryption.publicKey,
		content: 'ciphertext'
	};

	it("verifies for the signer's Ed25519 key only", async () => {
		const signature = await signMessageCopy(copy, alice.signing.privateKey);
		expect(signature).toMatch(/^0x[0-9a-f]{128}$/);
		expect(await verifyMessageCopy({ ...copy, signature }, alice.signing.publicKey)).toBe(true);
		expect(await verifyMessageCopy({ ...copy, signature }, bob.signing.publicKey)).toBe(false);
	});

	it('verifies for no other copy', async () => {
		const signature = await signMessageCopy(copy, alice.signing.privateKey);
		for (const other of [
			{ ...copy, content: 'other' },
			{ ...copy, to: copy.from },
			{ ...copy, toPublicKey: alice.encryption.publicKey },
			{ ...copy, namespace: 'other' }
		]) {
			expect(await verifyMessageCopy({ ...other, signature }, alice.signing.publicKey)).toBe(false);
		}
	});

	it('refuses a malformed signature or key without throwing', async () => {
		expect(await verifyMessageCopy({ ...copy, signature: '0x00' }, alice.signing.publicKey)).toBe(
			false
		);
		const signature = await signMessageCopy(copy, alice.signing.privateKey);
		expect(await verifyMessageCopy({ ...copy, signature }, '0x1234')).toBe(false);
	});
});

describe('a key set as registered', () => {
	it('is the public keys only', () => {
		const keySet = deriveKeySet(origin('33'));
		const registered = publicKeySetOf(keySet);
		expect(registered).toEqual({
			signing: { publicKey: keySet.signing.publicKey },
			encryption: { publicKey: keySet.encryption.publicKey }
		});
		expect(sameKeySet(registered, keySet)).toBe(true);
		expect(sameKeySet(registered, deriveKeySet(origin('44')))).toBe(false);
	});
});
