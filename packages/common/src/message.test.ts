// The missiv message format pinned by test vectors (ADR-0006 "The message"):
// the signing payload, its Ed25519 signature and the `pairwise-v1` content of
// fixed keys, messageID and IV, identical through WebCrypto and through the
// `@noble` fallback; then what verification refuses.
import {ed25519} from '@noble/curves/ed25519';
import {sha256} from '@noble/hashes/sha2';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';
import {deriveKeySet, keySetRef} from 'delegated-identity';
import {afterEach, describe, expect, it} from 'vitest';
import {setCipherBackend, type CipherBackend} from './cipher.js';
import {
	decryptPairwise,
	encryptPairwise,
	keyRefsOfPairwiseKeyID,
	MessageSchema,
	MessageToSendSchema,
	messageSigningPayload,
	pairwiseKeyID,
	signMessage,
	verifyMessage,
	type MessageToSign,
} from './message.js';

const backends: CipherBackend[] = ['webcrypto', 'noble'];
afterEach(() => setCipherBackend(undefined));

// Alice and Bob, delegated-identity key sets of fixed origin keys.
const alice = deriveKeySet(`0x${'11'.repeat(32)}`);
const bob = deriveKeySet(`0x${'22'.repeat(32)}`);
const ALICE_KEY_REF = '0x34b33c375e48d0a74fbd42558a88d43034a54317f31c9c1b9970d4f40d097e2c';
const BOB_KEY_REF = '0x6732aeb1747705711f21b1615c9bbeb174460a6debf5b91d6bc308cdb5ba600e';
const ALICE = `0x${'a'.repeat(40)}` as const;
const BOB = `0x${'b'.repeat(40)}` as const;

const header = {
	domain: 'example.com',
	namespace: 'chat',
	conversationID: `${BOB}${ALICE}`,
	messageID: '01JDQ4ZK8Y3V5W6X7Y8Z9A0B1C',
	sender: ALICE,
	senderKeyRef: ALICE_KEY_REF,
	scheme: 'pairwise-v1',
	keyID: `${ALICE_KEY_REF}:${BOB_KEY_REF}`,
} as const;
const IV = new Uint8Array(12).map((_, i) => i);

const VECTORS = {
	pairwise: {
		text: 'hello bob',
		content: 'AAECAwQFBgcICQoLgMfWwlLKTj-vGZ4DDdj-P1L1C29jxUcRMw',
		payload: [
			'missiv message',
			'domain: example.com',
			'namespace: chat',
			'conversation: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'id: 01JDQ4ZK8Y3V5W6X7Y8Z9A0B1C',
			'sender: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'senderKey: 0x34b33c375e48d0a74fbd42558a88d43034a54317f31c9c1b9970d4f40d097e2c',
			'scheme: pairwise-v1',
			'keyID: 0x34b33c375e48d0a74fbd42558a88d43034a54317f31c9c1b9970d4f40d097e2c:0x6732aeb1747705711f21b1615c9bbeb174460a6debf5b91d6bc308cdb5ba600e',
			'content: 0x214bd28bd37b5039cd4c0037e8a5f6d9130698f8e7d360fedbddc08c5766d319',
		].join('\n'),
		signature:
			'0x8007f3b6a2a52316c7ddb7681688d905686ebd76383859ea442a52a2c5ec15ac973cad4b91c405447a82bc97ed8d61ffb490820579fa7e81ffbdbfaada556d0c',
	},
	clear: {
		content: 'hi\nbob',
		payload: [
			'missiv message',
			'domain: example.com',
			'namespace: chat',
			'conversation: 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'id: 01JDQ4ZK8Y3V5W6X7Y8Z9A0B1C',
			'sender: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'senderKey: 0x34b33c375e48d0a74fbd42558a88d43034a54317f31c9c1b9970d4f40d097e2c',
			'scheme: clear',
			'keyID: none',
			'content: 0x0fd4bbb9cd0b9db8ab17ca63480890a2b1eb1ca08bdd1b1cf1390ed23c24b083',
		].join('\n'),
		signature:
			'0xb2d6b1256df46e92f63a97b3c50d8f98ccb366fe7f3470f2602e5d3116da3ac1586348bb768c435108cac68654a02054eee34e2adf184b212baa805cf4dcdf0c',
	},
};

const pairwiseMessage: MessageToSign = {...header, content: VECTORS.pairwise.content};
const clearMessage: MessageToSign = {...header, scheme: 'clear', keyID: null, content: VECTORS.clear.content};

describe('the test vectors', () => {
	it('start from these keyRefs, sorted into the keyID', async () => {
		expect(await keySetRef(alice)).toBe(ALICE_KEY_REF);
		expect(await keySetRef(bob)).toBe(BOB_KEY_REF);
		expect(pairwiseKeyID(BOB_KEY_REF, ALICE_KEY_REF)).toBe(header.keyID);
		expect(pairwiseKeyID(ALICE_KEY_REF, BOB_KEY_REF)).toBe(header.keyID);
		expect(keyRefsOfPairwiseKeyID(header.keyID)).toEqual([ALICE_KEY_REF, BOB_KEY_REF]);
	});

	it('hash the content with SHA-256 in the payload', () => {
		const hash = bytesToHex(sha256(new TextEncoder().encode(VECTORS.pairwise.content)));
		expect(VECTORS.pairwise.payload.endsWith(`content: 0x${hash}`)).toBe(true);
	});

	it('are signatures any Ed25519 implementation verifies (here @noble, beside the WebCrypto signer)', () => {
		for (const vector of [VECTORS.pairwise, VECTORS.clear]) {
			expect(
				ed25519.verify(
					hexToBytes(vector.signature.slice(2)),
					new TextEncoder().encode(vector.payload),
					hexToBytes(alice.signing.publicKey.slice(2)),
				),
			).toBe(true);
			// Ed25519 is deterministic: @noble signs the same bytes.
			expect(
				`0x${bytesToHex(ed25519.sign(new TextEncoder().encode(vector.payload), hexToBytes(alice.signing.privateKey.slice(2))))}`,
			).toBe(vector.signature);
		}
	});

	describe.each(backends)('through %s', (backend) => {
		it('give the pinned payload and signature', async () => {
			setCipherBackend(backend);
			expect(await messageSigningPayload(pairwiseMessage)).toBe(VECTORS.pairwise.payload);
			expect(await signMessage(pairwiseMessage, alice.signing.privateKey)).toBe(VECTORS.pairwise.signature);
			expect(await messageSigningPayload(clearMessage)).toBe(VECTORS.clear.payload);
			expect(await signMessage(clearMessage, alice.signing.privateKey)).toBe(VECTORS.clear.signature);
		});

		it('give the pinned pairwise-v1 content, which both members decrypt', async () => {
			setCipherBackend(backend);
			const content = await encryptPairwise(
				header,
				VECTORS.pairwise.text,
				alice.encryption.privateKey,
				bob.encryption.publicKey,
				IV,
			);
			expect(content).toBe(VECTORS.pairwise.content);
			// Bob, the recipient, with his key and Alice's
			expect(await decryptPairwise({...header, content}, bob.encryption.privateKey, alice.encryption.publicKey)).toBe(
				VECTORS.pairwise.text,
			);
			// Alice, the sender, reads the same ciphertext
			expect(await decryptPairwise({...header, content}, alice.encryption.privateKey, bob.encryption.publicKey)).toBe(
				VECTORS.pairwise.text,
			);
		});
	});

	it('cross backends: sealed through one, opened through the other', async () => {
		setCipherBackend('noble');
		const content = await encryptPairwise(header, 'cross', alice.encryption.privateKey, bob.encryption.publicKey);
		setCipherBackend('webcrypto');
		expect(await decryptPairwise({...header, content}, bob.encryption.privateKey, alice.encryption.publicKey)).toBe(
			'cross',
		);
	});
});

describe('a message signature', () => {
	const signed = async (message: MessageToSign) => ({
		...message,
		signature: await signMessage(message, alice.signing.privateKey),
	});

	it("verifies for the sender's signing key only", async () => {
		const message = await signed(pairwiseMessage);
		expect(await verifyMessage(message, alice.signing.publicKey)).toBe(true);
		expect(await verifyMessage(message, bob.signing.publicKey)).toBe(false);
	});

	it('fails once the message is moved to another conversation, namespace, domain or messageID, or its content changed', async () => {
		for (const original of [pairwiseMessage, clearMessage]) {
			const message = await signed(original);
			for (const moved of [
				{...message, conversationID: `${BOB}0x${'c'.repeat(40)}`},
				{...message, namespace: 'other'},
				{...message, domain: 'other.example.com'},
				{...message, messageID: '01JDQ4ZK8Y3V5W6X7Y8Z9A0B1D'},
				{...message, content: original.scheme === 'clear' ? 'hi bob' : VECTORS.pairwise.content.slice(0, -1) + 'x'},
				{...message, sender: BOB},
				{...message, senderKeyRef: BOB_KEY_REF},
			]) {
				expect(await verifyMessage(moved, alice.signing.publicKey)).toBe(false);
			}
		}
		const message = await signed(pairwiseMessage);
		expect(await verifyMessage({...message, scheme: 'clear', keyID: null}, alice.signing.publicKey)).toBe(false);
	});

	it('refuses a malformed message, signature or key without throwing', async () => {
		const message = await signed(pairwiseMessage);
		expect(await verifyMessage({...message, signature: '0x00'}, alice.signing.publicKey)).toBe(false);
		expect(await verifyMessage(message, '0x1234')).toBe(false);
		expect(await verifyMessage({...message, namespace: 'chat\nscheme: clear'}, alice.signing.publicKey)).toBe(false);
	});

	it('is never computed over a field with a newline, or an unsorted keyID', async () => {
		await expect(signMessage({...clearMessage, namespace: 'a\nb'}, alice.signing.privateKey)).rejects.toThrow();
		await expect(signMessage({...clearMessage, domain: 'a\nb'}, alice.signing.privateKey)).rejects.toThrow();
		await expect(
			signMessage({...pairwiseMessage, keyID: `${BOB_KEY_REF}:${ALICE_KEY_REF}`}, alice.signing.privateKey),
		).rejects.toThrow();
	});
});

describe('a pairwise-v1 content', () => {
	it('is undecryptable under another keyID, or with a key set the keyID does not name', async () => {
		const carol = deriveKeySet(`0x${'33'.repeat(32)}`);
		const content = await encryptPairwise(header, 'secret', alice.encryption.privateKey, bob.encryption.publicKey);
		const otherKeyID = pairwiseKeyID(ALICE_KEY_REF, await keySetRef(carol));
		await expect(
			decryptPairwise({...header, keyID: otherKeyID, content}, bob.encryption.privateKey, alice.encryption.publicKey),
		).rejects.toThrow();
		await expect(
			decryptPairwise({...header, content}, carol.encryption.privateKey, alice.encryption.publicKey),
		).rejects.toThrow();
		await expect(
			decryptPairwise(
				{...header, messageID: '01JDQ4ZK8Y3V5W6X7Y8Z9A0B1D', content},
				bob.encryption.privateKey,
				alice.encryption.publicKey,
			),
		).rejects.toThrow();
		await expect(
			decryptPairwise({...header, content: 'AAAA'}, bob.encryption.privateKey, alice.encryption.publicKey),
		).rejects.toThrow();
	});

	it('has a fresh random IV each time', async () => {
		const one = await encryptPairwise(header, 'same', alice.encryption.privateKey, bob.encryption.publicKey);
		const two = await encryptPairwise(header, 'same', alice.encryption.privateKey, bob.encryption.publicKey);
		expect(one).not.toBe(two);
	});
});

describe('the message schemas', () => {
	it('accept a sent message and a stored one', async () => {
		const sent = {...pairwiseMessage, signature: VECTORS.pairwise.signature};
		expect(MessageToSendSchema.parse(sent)).toEqual(sent);
		const stored = {...sent, seq: 3, serverTimestamp: 1_700_000_000_000};
		expect(MessageSchema.parse(stored)).toEqual(stored);
	});

	it('refuse a clear message with a keyID, a pairwise one without, and a non-ULID messageID', () => {
		const sent = {...pairwiseMessage, signature: VECTORS.pairwise.signature};
		expect(MessageToSendSchema.safeParse({...sent, keyID: null}).success).toBe(false);
		expect(MessageToSendSchema.safeParse({...sent, scheme: 'clear'}).success).toBe(false);
		expect(MessageToSendSchema.safeParse({...sent, messageID: 'not-a-ulid'}).success).toBe(false);
		expect(MessageToSendSchema.safeParse({...sent, scheme: 'sender-key-v1'}).success).toBe(false);
	});
});
