import { unstable_dev } from 'wrangler';
import type { UnstableDevWorker } from 'wrangler';
import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { WorkerAPI } from './utils';

const USER_A = {
	publicKey: '0xFAKE_AA',
	address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;

const USER_B = {
	publicKey: '0xFAKE_BB',
	address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
} as const;

describe('Registration of keys', () => {
	let worker: UnstableDevWorker;
	let api: WorkerAPI;

	beforeAll(async () => {
		worker = await unstable_dev(__dirname + '/../src/worker.ts', {
			experimental: { disableExperimentalWarning: true },
		});
		api = new WorkerAPI(worker);
	});

	beforeEach(async () => {
		await api.clear();
	});

	afterAll(async () => {
		await worker.stop();
	});

	it('should be able to register', async () => {
		await api.register(
			{
				address: USER_B.address,
				signature: '0x',
			},
			{ publicKey: USER_B.publicKey },
		);

		const user = await api.getUser({
			address: USER_B.address,
		});
		expect(user?.address.toLowerCase()).toEqual(USER_B.address.toLowerCase());
		expect(user?.publicKey.toLowerCase()).toEqual(USER_B.publicKey.toLowerCase());
	});
});
