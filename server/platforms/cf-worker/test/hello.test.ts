import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App, publicKeyAuthorizationMessage } from 'missiv-server-app';
import { hc } from 'hono/client';
import { unstable_dev } from 'wrangler';
import type { UnstableDevWorker } from 'wrangler';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getPublicKey } from '@noble/secp256k1';
import { toHex } from 'viem';
import { utils as secpUtils } from '@noble/secp256k1';
import { webcrypto } from 'node:crypto';
import { beforeEach } from 'node:test';
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

describe('Hello', () => {
	let worker: UnstableDevWorker;
	let client: ReturnType<typeof hc<App>>;

	beforeAll(async () => {
		worker = await unstable_dev(__dirname + '/../src/worker.ts', {
			experimental: { disableExperimentalWarning: true },
		});
		const workerFetch = worker.fetch.bind(worker) as typeof fetch;
		client = hc<App>('http://localhost', {
			fetch: async (input: string | URL | globalThis.Request, init?: RequestInit) => {
				if (typeof init?.body === 'string') {
					console.log(init?.body);
					// const signature = await signAsync(keccak_256(body), options.privateKey); // Sync methods below
					// init.headers.SIGNATURE = `${signature.toCompactHex()}:${signature.recovery}`;
					if (init.headers) {
						if (init.headers instanceof Map) {
							init.headers.set('SIGNATURE', `FAKE:${USER_B.publicKey}`);
						} else if (Array.isArray(init.headers)) {
							init.headers.push(['SIGNATURE', `FAKE:${USER_B.publicKey}`]);
						} else if (init.headers instanceof Headers) {
							init.headers.set('SIGNATURE', `FAKE:${USER_B.publicKey}`);
						} else {
							init.headers['SIGNATURE'] = `FAKE:${USER_B.publicKey}`;
						}
					}
				} else {
					console.log(typeof init?.body);
				}

				return workerFetch(input, init);
			},
		});
	});

	beforeEach(async () => {
		await client.api.admin['db-reset'].$post({
			json: {
				reset: true,
			},
		});
	});

	afterAll(async () => {
		await worker.stop();
	});

	it('should return Hello World', async () => {
		const resp = await client.api.public.$get();
		if (resp) {
			const text = await resp.text();
			expect(text).toMatchInlineSnapshot(`"Hello World!"`);
		}
	});

	it('should register', async () => {
		const userBMessage = publicKeyAuthorizationMessage({
			address: userBAccount.address,
			publicKey: userBDelegatePublicKey,
		});
		const signature = await userBAccount.signMessage({ message: userBMessage });

		const resp = await client.api.user.register.$post({
			json: { address: USER_B.address, signature: signature, domain: 'test' },
		});

		// const { user } = await api.getUser({
		// 	address: USER_B.address,
		// });
		// const { completeUser } = await api.getCompleteUser({
		// 	address: USER_B.address,
		// 	domain: 'test',
		// });
		// expect(user?.address.toLowerCase()).toEqual(USER_B.address.toLowerCase());
		// expect(completeUser?.publicKey.toLowerCase()).toEqual(USER_B.publicKey.toLowerCase());
	});
});
