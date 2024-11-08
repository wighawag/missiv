import {describe, expect, it, beforeAll, beforeEach} from 'vitest';
import {publicKeyAuthorizationMessage} from 'missiv-common';
import {webcrypto} from 'node:crypto';
import {api, USER_B} from './setup';
// @ts-ignore
if (!globalThis.crypto) globalThis.crypto = webcrypto;

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
			address: USER_B.address,
			publicKey: USER_B.delegatePublicKey,
		});
		const signature = await USER_B.account.signMessage({message: userBMessage});
		await api.register(
			{
				type: 'register',
				address: USER_B.address,
				signature: signature,
				domain: 'test',
			},
			{publicKey: USER_B.delegatePublicKey}
		);

		const {user} = await api.getUser({
			type: 'getUser',
			address: USER_B.address,
		});
		const {completeUser} = await api.getCompleteUser({
			address: USER_B.address,
			domain: 'test',
		});
		expect(user.address.toLowerCase()).toEqual(USER_B.address.toLowerCase());
		expect(completeUser.publicKey).toEqual(USER_B.delegatePublicKey);
	});
});
