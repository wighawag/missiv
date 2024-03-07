import { unstable_dev } from 'wrangler';
import type { UnstableDevWorker } from 'wrangler';
import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { API, FetchFunction, publicKeyAuthorizationMessage } from 'missiv-client';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { getPublicKey, utils as secpUtils } from '@noble/secp256k1';
import { webcrypto } from 'node:crypto';
// @ts-ignore
if (!globalThis.crypto) globalThis.crypto = webcrypto;

function toHex(arr: Uint8Array): `0x${string}` {
	let str = `0x`;
	for (const element of arr) {
		str += element.toString(16).padStart(2, '0');
	}
	return str as `0x${string}`;
}

const userAPrivateKey = generatePrivateKey();
const userAAccount = privateKeyToAccount(userAPrivateKey);
const userADelegatePrivateKey = secpUtils.randomPrivateKey();
const userADelegatePublicKey = toHex(getPublicKey(userADelegatePrivateKey));
const userAMessage = publicKeyAuthorizationMessage({
	address: userAAccount.address,
	publicKey: userADelegatePublicKey,
});
const USER_A = {
	publicKey: userADelegatePublicKey,
	address: userAAccount.address,
	signature: await userAAccount.signMessage({ message: userAMessage }),
} as const;

const userBPrivateKey = generatePrivateKey();
const userBAccount = privateKeyToAccount(userBPrivateKey);
const userBDelegatePrivateKey = secpUtils.randomPrivateKey();
const userBDelegatePublicKey = toHex(getPublicKey(userBDelegatePrivateKey));
const userBMessage = publicKeyAuthorizationMessage({
	address: userBAccount.address,
	publicKey: userBDelegatePublicKey,
});
const USER_B = {
	publicKey: userBDelegatePublicKey,
	address: userBAccount.address,
	signature: await userBAccount.signMessage({ message: userBMessage }),
} as const;

console.log({
	userAMessage,
	userBMessage,
});

describe('Worker', () => {
	let worker: UnstableDevWorker;
	let api: API;

	beforeAll(async () => {
		worker = await unstable_dev(__dirname + '/../src/worker.ts', {
			experimental: { disableExperimentalWarning: true },
		});
		api = new API('http://localhost/api', {
			fetch: worker.fetch.bind(worker) as FetchFunction,
		});
	});

	beforeEach(async () => {
		await api.clear();
		await api.register(
			{
				address: USER_B.address,
				signature: USER_B.signature,
				domain: 'test.com',
			},
			{ privateKey: userBDelegatePrivateKey },
		);
		await api.register(
			{
				address: USER_A.address,
				signature: USER_A.signature,
				domain: 'test.com',
			},
			{ privateKey: userADelegatePrivateKey },
		);
	});

	afterAll(async () => {
		await worker.stop();
	});

	it('should return Hello World', async () => {
		const resp = await worker.fetch();
		if (resp) {
			const text = await resp.text();
			expect(text).toMatchInlineSnapshot(`"Hello world\n"`);
		}
	});

	it('sending a message first time ends up in conversation request only', async () => {
		const time = Date.now();
		const sent = await api.sendMessage(
			{
				domain: 'test.com',
				namespace: 'test',
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
				toPublicKey: USER_A.publicKey,
			},
			{ publicKey: USER_B.publicKey },
		);
		expect(sent.timestampMS).to.toBeGreaterThan(time);
		const { acceptedConversations } = await api.getAcceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(acceptedConversations.length).toBe(0);
		const { unacceptedConversations } = await api.getUnacceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(unacceptedConversations.length).toBe(1);
	});

	it('accepting a conversation request make it end up in conversations', async () => {
		await api.sendMessage(
			{
				domain: 'test.com',
				namespace: 'test',
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
				toPublicKey: USER_A.publicKey,
			},
			{ publicKey: USER_B.publicKey },
		);
		const { unacceptedConversations } = await api.getUnacceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(unacceptedConversations.length).toBe(1);
		await api.acceptConversation(
			{
				domain: 'test.com',
				namespace: 'test',
				conversationID: unacceptedConversations[0].conversationID,
			},
			{ publicKey: USER_A.publicKey },
		);
		const { unacceptedConversations: unacceptedConversationsAfter } = await api.getUnacceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(unacceptedConversationsAfter.length).toBe(0);
		const { acceptedConversations } = await api.getAcceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(acceptedConversations.length).toBe(1);
	});

	it('sending further message on an accepted conversation end up there', async () => {
		await api.sendMessage(
			{
				domain: 'test.com',
				namespace: 'test',
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
				toPublicKey: USER_A.publicKey,
			},
			{ publicKey: USER_B.publicKey },
		);
		const { unacceptedConversations } = await api.getUnacceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(unacceptedConversations.length).toBe(1);

		await api.acceptConversation(
			{
				domain: 'test.com',
				namespace: 'test',
				conversationID: unacceptedConversations[0].conversationID,
			},
			{ publicKey: USER_A.publicKey },
		);
		await api.sendMessage(
			{
				domain: 'test.com',
				namespace: 'test',
				to: USER_A.address,
				message: 'Yo again!',
				signature: '0x',
				toPublicKey: USER_A.publicKey,
			},
			{ publicKey: USER_B.publicKey },
		);
		const { acceptedConversations } = await api.getAcceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(acceptedConversations.length).toBe(1);
		const { messages: messagesA } = await api.getMessages(
			{ domain: 'test.com', namespace: 'test', conversationID: acceptedConversations[0].conversationID },
			{ publicKey: USER_A.publicKey },
		);
		expect(messagesA.length).toBe(2);
		const { messages: messagesB } = await api.getMessages(
			{ domain: 'test.com', namespace: 'test', conversationID: acceptedConversations[0].conversationID },
			{ publicKey: USER_B.publicKey },
		);
		expect(messagesA).to.toEqual(messagesB);
	});

	it('reply show up as unread', async () => {
		await api.sendMessage(
			{
				domain: 'test.com',
				namespace: 'test',
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
				toPublicKey: USER_A.publicKey,
			},
			{ publicKey: USER_B.publicKey },
		);
		const { unacceptedConversations } = await api.getUnacceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(unacceptedConversations.length).toBe(1);
		await api.acceptConversation(
			{
				domain: 'test.com',
				namespace: 'test',
				conversationID: unacceptedConversations[0].conversationID,
			},
			{ publicKey: USER_A.publicKey },
		);
		await api.sendMessage(
			{
				domain: 'test.com',
				namespace: 'test',
				to: USER_A.address,
				message: 'how are you?',
				signature: '0x',
				toPublicKey: USER_A.publicKey,
			},
			{ publicKey: USER_B.publicKey },
		);
		await api.sendMessage(
			{
				domain: 'test.com',
				namespace: 'test',
				to: USER_B.address,
				message: 'I am good thanks',
				signature: '0x',
				toPublicKey: USER_B.publicKey,
			},
			{ publicKey: USER_A.publicKey },
		);
		const { acceptedConversations: conversationsB } = await api.getAcceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_B.publicKey },
		);
		expect(conversationsB.length).toBe(1);
		expect(conversationsB[0].state).toBe('unread');
		const { acceptedConversations: conversationsA } = await api.getAcceptedConversations(
			{ domain: 'test.com', namespace: 'test' },
			{ publicKey: USER_A.publicKey },
		);
		expect(conversationsA.length).toBe(1);
		expect(conversationsA[0].state).toBe('read'); // read because by replying to B, we automatically consider A reading B message
	});
});
