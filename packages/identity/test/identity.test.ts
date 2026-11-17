import {describe, expect, it} from 'vitest';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {utils as secpUtils} from '@noble/secp256k1';
import {
	delegatePublicKey,
	fromDomainToOrigin,
	originPublicKeyPublicationMessage,
	recoverAccount,
	recoverRequestSigner,
	requestMessage,
	signRequest,
	verifyRequest,
} from '../src/index.js';

const APP = 'https://game.example';
const SERVER = 'https://push.example';
const NOW = 1_800_000_000_000;

async function createAccount(appOrigin: string) {
	const wallet = privateKeyToAccount(generatePrivateKey());
	const delegatePrivateKey = secpUtils.randomPrivateKey();
	const publicKey = delegatePublicKey(delegatePrivateKey);
	const ownershipSignature = await wallet.signMessage({
		message: originPublicKeyPublicationMessage(appOrigin, publicKey),
	});
	return {address: wallet.address.toLowerCase() as `0x${string}`, delegatePrivateKey, publicKey, ownershipSignature};
}

function request(body = '{"hello":"world"}') {
	return {serverOrigin: SERVER, method: 'POST', path: '/api/register', body};
}

describe('the publication message', () => {
	it('is the text every existing proof was signed over, byte for byte (@etherplay/connect-core)', () => {
		expect(originPublicKeyPublicationMessage('https://game.example', '0x02ab')).toBe(
			'Origin: https://game.example\n\nIMPORTANT: Only sign on trusted websites.\n\nThis authorizes the following Public Key to represent your account:\n\n0x02ab\n\nOthers can use this key to write encrypted messages to you securely.',
		);
	});

	it('names the origin of a domain, and keeps an origin as it is', () => {
		expect(fromDomainToOrigin('game.example')).toBe('https://game.example');
		expect(fromDomainToOrigin('https://game.example')).toBe('https://game.example');
		expect(fromDomainToOrigin('http://192.168.1.10:5173')).toBe('http://192.168.1.10:5173');
		expect(fromDomainToOrigin('localhost')).toBe('http://localhost');
		expect(fromDomainToOrigin('localhost:5173')).toBe('http://localhost:5173');
	});
});

describe('the request envelope', () => {
	it('names the purpose, the server, the route, the time and the body hash', () => {
		expect(requestMessage({...request('body'), method: 'post', timestamp: 42})).toBe(
			[
				'missiv-identity request v1',
				'origin: https://push.example',
				'route: POST /api/register',
				'timestamp: 42',
				'body: 0x512227571b4b801d3bbe8f01e3b651e6c4462eb9780ee5b9fb9ea4fb6899a5c4',
			].join('\n'),
		);
	});

	it('hashes the body exactly as sent', () => {
		const a = requestMessage({...request('{"a":1}'), timestamp: 1});
		const b = requestMessage({...request('{"a": 1}'), timestamp: 1});
		expect(a).not.toBe(b);
	});
});

describe('the request signature', () => {
	it('recovers the delegate key that signed the request, and its timestamp', async () => {
		const privateKey = secpUtils.randomPrivateKey();
		const signature = await signRequest({...request(), timestamp: NOW}, privateKey);
		expect(signature).toMatch(/^1800000000000:[0-9a-f]{128}:[01]$/);
		expect(recoverRequestSigner({...request(), signature}, {now: NOW + 1000})).toEqual({
			ok: true,
			publicKey: delegatePublicKey(privateKey),
			timestamp: NOW,
		});
	});

	it('accepts a 0x-prefixed private key', async () => {
		const privateKey = generatePrivateKey();
		const signature = await signRequest(request(), privateKey);
		const recovered = recoverRequestSigner({...request(), signature});
		expect(recovered).toMatchObject({ok: true, publicKey: delegatePublicKey(privateKey)});
	});

	it('recovers another key for another server, route, method or body', async () => {
		const privateKey = secpUtils.randomPrivateKey();
		const signature = await signRequest({...request(), timestamp: NOW}, privateKey);
		const expected = delegatePublicKey(privateKey);
		for (const other of [
			{...request(), serverOrigin: 'https://missiv.example'},
			{...request(), path: '/api/unregister'},
			{...request(), method: 'PUT'},
			{...request('{"hello":"mallory"}')},
		]) {
			const recovered = recoverRequestSigner({...other, signature}, {now: NOW});
			expect(recovered.ok && recovered.publicKey).not.toBe(expected);
		}
	});

	it('refuses a timestamp outside the window, either way', async () => {
		const privateKey = secpUtils.randomPrivateKey();
		const signature = await signRequest({...request(), timestamp: NOW}, privateKey);
		expect(recoverRequestSigner({...request(), signature}, {now: NOW + 60_001})).toEqual({
			ok: false,
			reason: 'expired',
		});
		expect(recoverRequestSigner({...request(), signature}, {now: NOW - 60_001})).toEqual({
			ok: false,
			reason: 'expired',
		});
		expect(recoverRequestSigner({...request(), signature}, {now: NOW + 5000, maxAgeMs: 1000})).toEqual({
			ok: false,
			reason: 'expired',
		});
	});

	it('refuses a malformed signature', () => {
		for (const signature of [
			'',
			'zz:1',
			`${NOW}:00:1`,
			`${NOW}:${'a'.repeat(128)}:7`,
			'abc',
			`x:${'a'.repeat(128)}:0`,
		]) {
			expect(recoverRequestSigner({...request(), signature}, {now: NOW})).toEqual({ok: false, reason: 'malformed'});
		}
	});
});

describe('the ownership proof', () => {
	it('recovers the account whose wallet authorized the delegate key for that app origin', async () => {
		const account = await createAccount(APP);
		expect(
			await recoverAccount({
				appOrigin: APP,
				publicKey: account.publicKey,
				ownershipSignature: account.ownershipSignature,
			}),
		).toBe(account.address);
	});

	it('recovers another account for another origin, even the same host over http', async () => {
		const account = await createAccount(APP);
		for (const appOrigin of ['https://other.example', 'http://game.example']) {
			expect(
				await recoverAccount({appOrigin, publicKey: account.publicKey, ownershipSignature: account.ownershipSignature}),
			).not.toBe(account.address);
		}
	});
});

describe('verifyRequest: both proofs together', () => {
	async function signedBy(account: Awaited<ReturnType<typeof createAccount>>, body = 'body') {
		return {
			...request(body),
			signature: await signRequest({...request(body), timestamp: NOW}, account.delegatePrivateKey),
		};
	}

	it('answers the account, the delegate key and the timestamp of a request', async () => {
		const account = await createAccount(APP);
		const result = await verifyRequest(
			{
				...(await signedBy(account)),
				appOrigin: APP,
				address: account.address.toUpperCase().replace('0X', '0x'),
				ownershipSignature: account.ownershipSignature,
			},
			{now: NOW},
		);
		expect(result).toEqual({ok: true, address: account.address, publicKey: account.publicKey, timestamp: NOW});
	});

	it('verifies an app on a LAN address over http, the origin the wallet signed', async () => {
		const lan = 'http://192.168.1.10:5173';
		const account = await createAccount(lan);
		const result = await verifyRequest(
			{
				...(await signedBy(account)),
				appOrigin: lan,
				address: account.address,
				ownershipSignature: account.ownershipSignature,
			},
			{now: NOW},
		);
		expect(result.ok).toBe(true);
	});

	it('refuses an address the proofs do not recover', async () => {
		const account = await createAccount(APP);
		const other = await createAccount(APP);
		const result = await verifyRequest(
			{
				...(await signedBy(account)),
				appOrigin: APP,
				address: other.address,
				ownershipSignature: account.ownershipSignature,
			},
			{now: NOW},
		);
		expect(result).toEqual({ok: false, reason: 'not-authorized'});
	});

	it('refuses a proof made for another app origin', async () => {
		const account = await createAccount('https://other.example');
		const result = await verifyRequest(
			{
				...(await signedBy(account)),
				appOrigin: APP,
				address: account.address,
				ownershipSignature: account.ownershipSignature,
			},
			{now: NOW},
		);
		expect(result).toEqual({ok: false, reason: 'not-authorized'});
	});

	it('refuses a request signed by a key the wallet did not authorize (a public proof replayed)', async () => {
		const account = await createAccount(APP);
		const mallory = await createAccount(APP);
		const result = await verifyRequest(
			{
				...(await signedBy(mallory)),
				appOrigin: APP,
				address: account.address,
				ownershipSignature: account.ownershipSignature,
			},
			{now: NOW},
		);
		expect(result).toEqual({ok: false, reason: 'not-authorized'});
	});

	it('refuses an expired request and a malformed ownership proof', async () => {
		const account = await createAccount(APP);
		const signed = await signedBy(account);
		expect(
			await verifyRequest(
				{...signed, appOrigin: APP, address: account.address, ownershipSignature: account.ownershipSignature},
				{now: NOW + 120_000},
			),
		).toEqual({ok: false, reason: 'expired'});
		expect(
			await verifyRequest(
				{...signed, appOrigin: APP, address: account.address, ownershipSignature: '0x1234'},
				{now: NOW},
			),
		).toEqual({ok: false, reason: 'malformed'});
	});
});
