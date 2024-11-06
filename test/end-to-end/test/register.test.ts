
import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { API, FetchFunction, getPublicKey } from 'missiv-client';
import {publicKeyAuthorizationMessage} from 'missiv-common';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { utils as secpUtils } from '@noble/secp256k1';
import { webcrypto } from 'node:crypto';
import { MISSIV_URL } from './prool/pool';
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

const api = new API(MISSIV_URL);

describe('Registration of keys', () => {
	
// --------------------------------------------------------------------------------------------
	// wakeup worker
	//   the first time the worker is called, it setups itself and this can take time
	//   hence we have a dummy test to ensure the other tests have normal timeout
	//   We also call setChainOverride to ensure the api is talking to the proper eth node
	// --------------------------------------------------------------------------------------------
	beforeAll(async () => {
		await api.clear();
	});
	// --------------------------------------------------------------------------------------------

	beforeEach(async () => {
		await api.clear();
	});


	it('should be able to register', async () => {
		const userBMessage = publicKeyAuthorizationMessage({
			address: userBAccount.address,
			publicKey: userBDelegatePublicKey,
		});
		const signature = await userBAccount.signMessage({ message: userBMessage });
		await api.register(
			{
				type: 'register',
				address: USER_B.address,
				signature: signature,
				domain: 'test',
			},
			{ publicKey: USER_B.publicKey },
		);

		const { user } = await api.getUser({
			type: 'getUser',
			address: USER_B.address,
		});
		const { domainUser } = await api.getCompleteUser({
			address: USER_B.address,
			domain: 'test',
		});
		expect(user?.address.toLowerCase()).toEqual(USER_B.address.toLowerCase());
		expect(domainUser?.publicKey.toLowerCase()).toEqual(USER_B.publicKey.toLowerCase());
	});
});
