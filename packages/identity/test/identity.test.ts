import {describe, expect, it} from 'vitest';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {signAsync, utils as secpUtils} from '@noble/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {
	delegatePublicKey,
	fromDomainToOrigin,
	originPublicKeyPublicationMessage,
	recoverAccount,
	recoverRequestSigner,
	signRequest,
	verifyRequest,
} from '../src/index.js';

async function createAccount(domain: string) {
	const wallet = privateKeyToAccount(generatePrivateKey());
	const delegatePrivateKey = secpUtils.randomPrivateKey();
	const publicKey = delegatePublicKey(delegatePrivateKey);
	const ownershipSignature = await wallet.signMessage({
		message: originPublicKeyPublicationMessage(fromDomainToOrigin(domain), publicKey),
	});
	return {address: wallet.address.toLowerCase() as `0x${string}`, delegatePrivateKey, publicKey, ownershipSignature};
}

describe('the publication message', () => {
	it('is the text every existing proof was signed over, byte for byte', () => {
		expect(originPublicKeyPublicationMessage('https://game.example', '0x02ab')).toBe(
			'Origin: https://game.example\n\nIMPORTANT: Only sign on trusted websites.\n\nThis authorizes the following Public Key to represent your account:\n\n0x02ab\n\nOthers can use this key to write encrypted messages to you securely.',
		);
	});

	it('names the origin of a domain', () => {
		expect(fromDomainToOrigin('game.example')).toBe('https://game.example');
		expect(fromDomainToOrigin('https://game.example')).toBe('https://game.example');
		expect(fromDomainToOrigin('localhost')).toBe('http://localhost');
		expect(fromDomainToOrigin('localhost:5173')).toBe('http://localhost:5173');
	});
});

describe('the request signature', () => {
	it('recovers the delegate key that signed the body', async () => {
		const privateKey = secpUtils.randomPrivateKey();
		const body = JSON.stringify({hello: 'world'});
		const signature = await signRequest(body, privateKey);
		expect(signature).toMatch(/^[0-9a-f]{128}:[01]$/);
		expect(recoverRequestSigner(signature, body)).toBe(delegatePublicKey(privateKey));
	});

	it('accepts a 0x-prefixed private key', async () => {
		const privateKey = generatePrivateKey();
		const signature = await signRequest('body', privateKey);
		expect(recoverRequestSigner(signature, 'body')).toBe(delegatePublicKey(privateKey));
	});

	it("recovers a signature made the way missiv-client's API makes it", async () => {
		const privateKey = secpUtils.randomPrivateKey();
		const signature = await signAsync(keccak_256('body'), privateKey);
		const header = `${signature.toCompactHex()}:${signature.recovery}`;
		expect(recoverRequestSigner(header, 'body')).toBe(delegatePublicKey(privateKey));
	});

	it('recovers another key for another body', async () => {
		const privateKey = secpUtils.randomPrivateKey();
		const signature = await signRequest('body', privateKey);
		expect(recoverRequestSigner(signature, 'other body')).not.toBe(delegatePublicKey(privateKey));
	});
});

describe('the ownership proof', () => {
	it('recovers the account whose wallet authorized the delegate key for that domain', async () => {
		const account = await createAccount('game.example');
		expect(
			await recoverAccount({
				domain: 'game.example',
				publicKey: account.publicKey,
				ownershipSignature: account.ownershipSignature,
			}),
		).toBe(account.address);
	});

	it('recovers another account for another domain', async () => {
		const account = await createAccount('game.example');
		expect(
			await recoverAccount({
				domain: 'other.example',
				publicKey: account.publicKey,
				ownershipSignature: account.ownershipSignature,
			}),
		).not.toBe(account.address);
	});
});

describe('verifyRequest: both proofs together', () => {
	it('answers the account and the delegate key of a request', async () => {
		const account = await createAccount('game.example');
		const body = JSON.stringify({address: account.address});
		const result = await verifyRequest({
			domain: 'game.example',
			body,
			requestSignature: await signRequest(body, account.delegatePrivateKey),
			address: account.address.toUpperCase().replace('0X', '0x'),
			ownershipSignature: account.ownershipSignature,
		});
		expect(result).toEqual({ok: true, address: account.address, publicKey: account.publicKey});
	});

	it('refuses an address the proofs do not recover', async () => {
		const account = await createAccount('game.example');
		const other = await createAccount('game.example');
		const body = 'body';
		const result = await verifyRequest({
			domain: 'game.example',
			body,
			requestSignature: await signRequest(body, account.delegatePrivateKey),
			address: other.address,
			ownershipSignature: account.ownershipSignature,
		});
		expect(result).toEqual({ok: false, reason: 'not-authorized'});
	});

	it('refuses a request signed by a key the wallet did not authorize (a public proof replayed)', async () => {
		const account = await createAccount('game.example');
		const mallory = await createAccount('game.example');
		const body = 'body';
		const result = await verifyRequest({
			domain: 'game.example',
			body,
			requestSignature: await signRequest(body, mallory.delegatePrivateKey),
			address: account.address,
			ownershipSignature: account.ownershipSignature,
		});
		expect(result).toEqual({ok: false, reason: 'not-authorized'});
	});

	it('refuses a malformed signature as malformed', async () => {
		const account = await createAccount('game.example');
		for (const requestSignature of ['', 'zz:1', '00:7', 'abc']) {
			const result = await verifyRequest({
				domain: 'game.example',
				body: 'body',
				requestSignature,
				address: account.address,
				ownershipSignature: account.ownershipSignature,
			});
			expect(result).toEqual({ok: false, reason: 'malformed'});
		}
		const result = await verifyRequest({
			domain: 'game.example',
			body: 'body',
			requestSignature: await signRequest('body', account.delegatePrivateKey),
			address: account.address,
			ownershipSignature: '0x1234',
		});
		expect(result).toEqual({ok: false, reason: 'malformed'});
	});
});
