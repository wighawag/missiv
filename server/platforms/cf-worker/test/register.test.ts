import { unstable_dev } from 'wrangler';
import type { UnstableDevWorker } from 'wrangler';
import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { API, FetchFunction, getPublicKey, publicKeyAuthorizationMessage } from 'missiv-client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { utils as secpUtils } from '@noble/secp256k1';
import { webcrypto } from 'node:crypto';
// @ts-ignore
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const userAPrivateKey = generatePrivateKey();
const userAAccount = privateKeyToAccount(userAPrivateKey);
const userADelegatePrivateKey = secpUtils.randomPrivateKey();
const userADelegatePublicKey = toHex(getPublicKey(userADelegatePrivateKey));
const USER_A = {
	publicKey: userADelegatePublicKey,
	address: userAAccount.address,
} as const;

const userBPrivateKey = generatePrivateKey();
const userBAccount = privateKeyToAccount(userBPrivateKey);
const userBDelegatePrivateKey = secpUtils.randomPrivateKey();
const userBDelegatePublicKey = toHex(getPublicKey(userBDelegatePrivateKey));

const USER_B = {
	publicKey: userBDelegatePublicKey,
	address: userBAccount.address,
} as const;

describe('Registration of keys', () => {
	let worker: UnstableDevWorker;
	let api: API;

	beforeAll(async () => {
		worker = await unstable_dev(__dirname + '/../src/worker.ts', {
			experimental: { disableExperimentalWarning: true },
		});
		api = new API('http://localhost/api/private', {
			fetch: worker.fetch.bind(worker) as FetchFunction,
		});
	});

	beforeEach(async () => {
		await api.clear();
	});

	afterAll(async () => {
		await worker.stop();
	});

	it('should be able to register', async () => {
		const userBMessage = publicKeyAuthorizationMessage({
			address: userBAccount.address,
			publicKey: userBDelegatePublicKey,
		});
		const signature = await userBAccount.signMessage({ message: userBMessage });
		await api.register(
			{
				address: USER_B.address,
				signature: signature,
				domain: 'test',
			},
			{ publicKey: USER_B.publicKey },
		);

		const { user } = await api.getUser({
			address: USER_B.address,
		});
		const { completeUser } = await api.getCompleteUser({
			address: USER_B.address,
			domain: 'test',
		});
		expect(user?.address.toLowerCase()).toEqual(USER_B.address.toLowerCase());
		expect(completeUser?.publicKey.toLowerCase()).toEqual(USER_B.publicKey.toLowerCase());
	});
});
