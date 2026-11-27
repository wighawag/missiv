// The cipher module on both of its backends: WebCrypto (Node's) and the `@noble`
// fallback a plain-http origin uses. Each primitive checked against a published
// vector or Node's own implementation, and both backends against each other.
import {createCipheriv} from 'node:crypto';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils';
import {afterEach, describe, expect, it} from 'vitest';
import {
	aesGcmDecrypt,
	aesGcmEncrypt,
	cipherBackend,
	hkdfSha256,
	setCipherBackend,
	x25519Backend,
	x25519SharedSecret,
	type CipherBackend,
} from './cipher.js';

const backends: CipherBackend[] = ['webcrypto', 'noble'];

afterEach(() => setCipherBackend(undefined));

describe('backend detection', () => {
	it('uses WebCrypto on Node, X25519 included', async () => {
		expect(cipherBackend()).toBe('webcrypto');
		expect(await x25519Backend()).toBe('webcrypto');
	});

	it('falls back to @noble when forced (as without crypto.subtle)', async () => {
		setCipherBackend('noble');
		expect(cipherBackend()).toBe('noble');
		expect(await x25519Backend()).toBe('noble');
	});
});

describe.each(backends)('through %s', (backend) => {
	afterEach(() => setCipherBackend(undefined));
	const use = () => setCipherBackend(backend);

	it('agrees X25519 as RFC 7748 section 6.1', async () => {
		use();
		const secret = await x25519SharedSecret(
			hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
			hexToBytes('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'),
		);
		expect(bytesToHex(secret)).toBe('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
	});

	it('refuses a low-order X25519 public key', async () => {
		use();
		await expect(x25519SharedSecret(new Uint8Array(32).fill(7), new Uint8Array(32))).rejects.toThrow();
	});

	it('derives HKDF-SHA256 as RFC 5869 test case 3 (empty salt and info)', async () => {
		use();
		const okm = await hkdfSha256(new Uint8Array(22).fill(0x0b), new Uint8Array(0), 42);
		expect(bytesToHex(okm)).toBe(
			'8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
		);
	});

	it("seals AES-256-GCM as Node's crypto does, and opens only what it sealed", async () => {
		use();
		const key = new Uint8Array(32).map((_, i) => i);
		const iv = new Uint8Array(12).map((_, i) => 100 + i);
		const plaintext = new TextEncoder().encode('one ciphertext per message');
		const aad = new TextEncoder().encode('the header');
		const sealed = await aesGcmEncrypt(key, iv, plaintext, aad);

		const node = createCipheriv('aes-256-gcm', key, iv);
		node.setAAD(aad);
		const expected = Buffer.concat([node.update(plaintext), node.final(), node.getAuthTag()]);
		expect(bytesToHex(sealed)).toBe(expected.toString('hex'));

		expect(await aesGcmDecrypt(key, iv, sealed, aad)).toEqual(plaintext);
		await expect(aesGcmDecrypt(key, iv, sealed, new TextEncoder().encode('another header'))).rejects.toThrow();
		const tampered = sealed.slice();
		tampered[0] ^= 1;
		await expect(aesGcmDecrypt(key, iv, tampered, aad)).rejects.toThrow();
	});
});
