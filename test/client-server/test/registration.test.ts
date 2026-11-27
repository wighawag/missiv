// Registration of a key set (ADR-0004 decision 1, ADR-0006's `register`,
// `getDomainUser` and `getKeySet`): what the server refuses, what two devices of
// one account do, and the key directory a reader checks old messages against.
import {describe, it, expect, beforeEach} from 'vitest';
import {deriveKeySet, keySetRef, type KeySet} from 'delegated-identity';
import {encryptedCopies, openMessage, verifyKeySet} from '@missiv/client';
import {
	APP_ORIGIN,
	conversationIDOf,
	createHarness,
	createUser,
	DOMAIN,
	NAMESPACE,
	newKeySet,
	publicOf,
	type Harness,
	type TestUser,
} from './setup.js';

let h: Harness;
let A: TestUser;
let B: TestUser;

beforeEach(async () => {
	h = createHarness();
	[A, B] = await Promise.all([createUser(), createUser()]);
	await h.setupDatabase();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Register `keySet` for `user`, the request signed by `signer` (the key set's own signing key by default). */
function registerKeySet(
	user: TestUser,
	keySet: KeySet,
	ownershipSignature: `0x${string}`,
	options?: {signer?: KeySet; domain?: string; appOrigin?: string},
) {
	return h.api.register(
		{
			type: 'register',
			domain: options?.domain ?? DOMAIN,
			appOrigin: options?.appOrigin ?? APP_ORIGIN,
			address: user.address,
			keySet: publicOf(keySet),
			ownershipSignature,
		},
		{privateKey: (options?.signer ?? keySet).signing.privateKey},
	);
}

async function currentKeyRef(user: TestUser) {
	const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: user.address});
	return domainUser?.keyRef;
}

describe('registration refuses', () => {
	it('an ownership signature by another wallet', async () => {
		await expect(registerKeySet(A, A.keySet, await B.signPublication(A.keySet))).rejects.toMatchObject({status: 403});
		expect(await currentKeyRef(A)).toBeUndefined();
	});

	it("an ownership signature of another key set (the wallet's, over its own key set)", async () => {
		const other = newKeySet();
		await expect(registerKeySet(A, other, A.ownershipSignature)).rejects.toMatchObject({status: 403});
		// one key of the signed set is not enough either
		const mixed = {signing: A.keySet.signing, encryption: other.encryption};
		await expect(registerKeySet(A, mixed, A.ownershipSignature)).rejects.toMatchObject({status: 403});
		expect(await currentKeyRef(A)).toBeUndefined();
	});

	it('an ownership signature for another app origin', async () => {
		// http://test.com is an origin of the domain too, but the wallet signed for https://test.com
		await expect(
			registerKeySet(A, A.keySet, A.ownershipSignature, {appOrigin: 'http://test.com'}),
		).rejects.toMatchObject({status: 403});
		expect(await currentKeyRef(A)).toBeUndefined();
	});

	it('a malformed ownership signature', async () => {
		await expect(registerKeySet(A, A.keySet, '0x1234')).rejects.toMatchObject({status: 400});
	});

	it('a key set registered for another account', async () => {
		await h.register(A);
		// B's wallet signs A's key set (anyone can sign any keys), and A's signing key signs the request
		await expect(registerKeySet(B, A.keySet, await B.signPublication(A.keySet))).rejects.toMatchObject({status: 409});
		expect(await currentKeyRef(B)).toBeUndefined();
		expect(await currentKeyRef(A)).toBe(A.keyRef);
	});

	it('a key set registered for the same account in another domain', async () => {
		await h.register(A);
		const signature = await A.signPublication(A.keySet, 'https://other.com');
		await expect(
			registerKeySet(A, A.keySet, signature, {domain: 'other.com', appOrigin: 'https://other.com'}),
		).rejects.toMatchObject({status: 409});
	});

	it("a key set whose encryption key is another account's", async () => {
		await h.register(A);
		const stolen = {signing: newKeySet().signing, encryption: A.keySet.encryption};
		await expect(registerKeySet(B, stolen, await B.signPublication(stolen))).rejects.toMatchObject({status: 409});
	});

	it("a request not signed by the key set's signing key", async () => {
		await expect(registerKeySet(A, A.keySet, A.ownershipSignature, {signer: newKeySet()})).rejects.toMatchObject({
			status: 403,
		});
		await expect(
			h.app.request('http://localhost/api/user/register', {
				method: 'POST',
				headers: {'content-type': 'application/json'},
				body: JSON.stringify({
					type: 'register',
					domain: DOMAIN,
					appOrigin: APP_ORIGIN,
					address: A.address,
					keySet: publicOf(A.keySet),
					ownershipSignature: A.ownershipSignature,
				}),
			}),
		).resolves.toMatchObject({status: 401});
		expect(await currentKeyRef(A)).toBeUndefined();
	});

	it('a replayed registration (which could make a replaced key set current again)', async () => {
		let captured: {url: string; init: RequestInit} | undefined;
		const capture = new (h.api.constructor as any)('http://localhost', {
			fetch: async (url: string, init: RequestInit) => {
				captured = {url, init};
				return h.app.request(url, init);
			},
		});
		await capture.register(
			{
				type: 'register',
				domain: DOMAIN,
				appOrigin: APP_ORIGIN,
				address: A.address,
				keySet: publicOf(A.keySet),
				ownershipSignature: A.ownershipSignature,
			},
			{privateKey: A.keySet.signing.privateKey},
		);
		const replacement = newKeySet();
		await registerKeySet(A, replacement, await A.signPublication(replacement));

		const replay = await h.app.request(captured!.url, captured!.init);
		expect(replay.status).toBe(409);
		expect(await currentKeyRef(A)).toBe(await keySetRef(replacement));
	});
});

describe('two devices of one account', () => {
	it('derive the same key set from the origin key, and both register it', async () => {
		const first = deriveKeySet(A.originPrivateKey);
		const second = deriveKeySet(A.originPrivateKey);
		expect(publicOf(second)).toEqual(publicOf(first));

		await registerKeySet(A, first, A.ownershipSignature);
		await wait(2); // another device signs at another time
		await registerKeySet(A, second, A.ownershipSignature);
		expect(await currentKeyRef(A)).toBe(A.keyRef);

		// both sign as the account
		for (const device of [first, second]) {
			await h.api.getConversations(
				{type: 'getConversations', domain: DOMAIN, namespace: NAMESPACE},
				{privateKey: device.signing.privateKey},
			);
		}
	});
});

describe('the key directory', () => {
	it('getDomainUser returns the current key set with its proof', async () => {
		await h.register(A, {name: 'alice'});
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: A.address});
		expect(domainUser).toMatchObject({
			user: A.address,
			domain: DOMAIN,
			keyRef: A.keyRef,
			keySet: publicOf(A.keySet),
			ownershipSignature: A.ownershipSignature,
			appOrigin: APP_ORIGIN,
			name: 'alice',
		});
		// never a private key
		expect(JSON.stringify(domainUser)).not.toContain(A.keySet.signing.privateKey.slice(2));
	});

	it('getKeySet returns the current and a replaced key set, getDomainUser only the current', async () => {
		await h.register(A, {name: 'alice'});
		const replacement = newKeySet();
		await registerKeySet(A, replacement, await A.signPublication(replacement));
		const replacementRef = await keySetRef(replacement);

		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: A.address});
		expect(domainUser).toMatchObject({keyRef: replacementRef, keySet: publicOf(replacement), name: 'alice'});

		const {keySet: replaced} = await h.api.getKeySet({type: 'getKeySet', domain: DOMAIN, keyRef: A.keyRef});
		expect(replaced).toMatchObject({
			user: A.address,
			domain: DOMAIN,
			keyRef: A.keyRef,
			keySet: publicOf(A.keySet),
			ownershipSignature: A.ownershipSignature,
			appOrigin: APP_ORIGIN,
		});
		expect(await verifyKeySet(replaced!, {address: A.address, domain: DOMAIN, keyRef: A.keyRef})).toBe(true);

		const {keySet: current} = await h.api.getKeySet({type: 'getKeySet', domain: DOMAIN, keyRef: replacementRef});
		expect(current).toMatchObject({keyRef: replacementRef, keySet: publicOf(replacement)});
		expect(await verifyKeySet(current!, {address: A.address, domain: DOMAIN, keyRef: replacementRef})).toBe(true);
	});

	it('getKeySet answers nothing for an unknown key set or another domain', async () => {
		await h.register(A);
		expect((await h.api.getKeySet({type: 'getKeySet', domain: DOMAIN, keyRef: B.keyRef})).keySet).toBeUndefined();
		expect((await h.api.getKeySet({type: 'getKeySet', domain: 'other.com', keyRef: A.keyRef})).keySet).toBeUndefined();
	});

	it('re-registering a replaced key set makes it current again', async () => {
		await h.register(A);
		const replacement = newKeySet();
		await registerKeySet(A, replacement, await A.signPublication(replacement));
		await registerKeySet(A, A.keySet, A.ownershipSignature);
		expect(await currentKeyRef(A)).toBe(A.keyRef);
	});

	it("a message stays verifiable and readable after its sender's key set is replaced", async () => {
		await h.registerAll([A, B]);
		const conversationID = conversationIDOf([A.address, B.address]);
		const messages = await encryptedCopies({
			scope: {domain: DOMAIN, namespace: NAMESPACE, conversationID},
			sender: {address: A.address, keySet: A.keySet},
			recipient: {address: B.address, encryptionKey: B.keySet.encryption.publicKey},
			text: 'before the replacement',
		});
		await h.api.sendMessage(
			{
				type: 'sendMessage',
				domain: DOMAIN,
				namespace: NAMESPACE,
				conversationID,
				lastMessageReadTimestampMS: 0,
				messageType: 'encrypted',
				messages,
			},
			{privateKey: A.keySet.signing.privateKey},
		);
		const replacement = newKeySet();
		await registerKeySet(A, replacement, await A.signPublication(replacement));

		const [copy] = await h.messages(B, conversationID);
		expect(copy).toMatchObject({senderKeyRef: A.keyRef, senderKeySet: publicOf(A.keySet)});
		expect(await openMessage(copy, {address: B.address, domain: DOMAIN, keySet: B.keySet})).toMatchObject({
			content: 'before the replacement',
		});
	});
});
