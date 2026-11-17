// The client trusts no key it has not verified (S3-12): every key against its
// wallet's ownership proof, no clear text unless asked, every copy's signature
// checked on read, and one bad copy shown as such instead of breaking the thread.
// Against the in-process server; a lying server is the real one behind a fetch
// that rewrites its answers.
import {describe, it, expect, beforeEach} from 'vitest';
import {writable} from 'svelte/store';
import {
	createMissivRegistration,
	encryptedCopies,
	openMessage,
	openOneConversation,
	verifyDomainUser,
	type Account,
} from 'missiv-client';
import {signMessageCopy, type ConversationMessage} from 'missiv-common';
import {
	accountOf,
	conversationIDOf,
	createHarness,
	createUser,
	DOMAIN,
	APP_ORIGIN,
	NAMESPACE,
	SERVER_URL,
	until,
	type Harness,
	type TestUser,
} from './setup.js';

let h: Harness;
let A: TestUser;
let B: TestUser;
let C: TestUser;

beforeEach(async () => {
	h = createHarness();
	[A, B, C] = await Promise.all([createUser(), createUser(), createUser()]);
	await h.registerAll([A, B, C]);
});

/** The server's fetch, with getDomainUser's answer rewritten (a server handing out a key of its choice). */
function lyingFetch(rewrite: (domainUser: any) => any) {
	return (async (input: any, init?: any) => {
		const response: Response = await h.app.request(input, init);
		if (String(input).endsWith('/api/user/getDomainUser') && response.ok) {
			const body = await response.json();
			return new Response(JSON.stringify({domainUser: body.domainUser && rewrite(body.domainUser)}), {
				status: 200,
				headers: {'content-type': 'application/json'},
			});
		}
		return response;
	}) as typeof fetch;
}

function conversationOf(user: TestUser, other: TestUser, fetch: typeof globalThis.fetch = h.app.request as any) {
	const account = writable<Account>(accountOf(user));
	const registration = createMissivRegistration({
		endpoint: SERVER_URL,
		domain: DOMAIN,
		appOrigin: APP_ORIGIN,
		account,
		fetch,
	});
	return openOneConversation({
		registration,
		endpoint: SERVER_URL,
		domain: DOMAIN,
		namespace: NAMESPACE,
		otherUser: {address: other.address},
		fetch,
	});
}

const reader = (user: TestUser) => ({address: user.address, domain: DOMAIN, privateKey: user.delegatePrivateKey});

describe('keys are verified against their ownership proof', () => {
	it("accepts a domain user's key that its wallet signed for an origin of the domain", async () => {
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: B.address});
		expect(await verifyDomainUser(domainUser!, {address: B.address, domain: DOMAIN})).toBe(true);
	});

	it('refuses a key whose publication signature does not recover its address', async () => {
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: B.address});
		// the server hands out C's key under B's name, with C's proof or B's
		expect(
			await verifyDomainUser(
				{...domainUser!, publicKey: C.delegatePublicKey, signature: C.ownershipSignature},
				{address: B.address, domain: DOMAIN},
			),
		).toBe(false);
		expect(
			await verifyDomainUser({...domainUser!, publicKey: C.delegatePublicKey}, {address: B.address, domain: DOMAIN}),
		).toBe(false);
	});

	it('refuses a proof made for an origin of another domain', async () => {
		const signature = await B.signPublication(B.delegatePublicKey, 'https://other.com');
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: B.address});
		expect(
			await verifyDomainUser(
				{...domainUser!, signature, appOrigin: 'https://other.com'},
				{address: B.address, domain: DOMAIN},
			),
		).toBe(false);
	});

	it('the conversation encrypts nothing to a key the server swapped in', async () => {
		const conversation = conversationOf(
			A,
			B,
			lyingFetch((user) => (user.user === B.address ? {...user, publicKey: C.delegatePublicKey} : user)),
		);
		const stop = conversation.subscribe(() => {});
		const state = await until(conversation, (s) => !!s.otherUser.unverifiedKey);
		expect(state.otherUser.publicKey).toBeUndefined();
		await expect(conversation.sendMessage('for B only')).rejects.toThrow(/not proven/);
		expect(await h.messages(B, conversationIDOf([A.address, B.address]))).toEqual([]);
		stop();
	});
});

describe('nothing is sent in clear unless asked', () => {
	it('refuses to send to a user with no key, and sends an introduction when asked', async () => {
		const D = await createUser(); // never registered
		const conversation = conversationOf(A, D);
		const stop = conversation.subscribe(() => {});
		await until(conversation, (s) => s.step === 'Fetched');
		await expect(conversation.sendMessage('secret')).rejects.toThrow(/sendIntroduction/);
		expect(await h.messages(A, conversationIDOf([A.address, D.address]))).toEqual([]);

		await conversation.sendIntroduction('hello, register to read encrypted messages');
		const [copy] = await h.messages(A, conversationIDOf([A.address, D.address]));
		expect(copy.messageType).toBe('clear');
		stop();
	});

	it('sends encrypted to a verified key: the server stores no text', async () => {
		const conversation = conversationOf(A, B);
		const stop = conversation.subscribe(() => {});
		await until(conversation, (s) => s.step === 'Fetched' && !!s.otherUser.publicKey);
		await conversation.sendMessage('only for B');
		const [copy] = await h.messages(B, conversationIDOf([A.address, B.address]));
		expect(copy.messageType).toBe('encrypted');
		expect(copy.content).not.toContain('only for B');
		expect(await openMessage(copy, reader(B))).toMatchObject({content: 'only for B'});
		stop();
	});
});

describe("each copy's signature is verified on read", () => {
	async function sentByA(text: string) {
		const conversationID = conversationIDOf([A.address, B.address]);
		const messages = await encryptedCopies({
			scope: {domain: DOMAIN, namespace: NAMESPACE, conversationID},
			sender: {address: A.address, privateKey: A.delegatePrivateKey},
			recipient: {address: B.address, publicKey: B.delegatePublicKey},
			text,
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
			{privateKey: A.delegatePrivateKey},
		);
		const copies = await h.messages(B, conversationID);
		return copies[0];
	}

	it('opens a copy signed by its sender, for both members', async () => {
		const copy = await sentByA('hi B');
		expect(await openMessage(copy, reader(B))).toMatchObject({content: 'hi B', sender: A.address});
		const [own] = await h.messages(A, copy.conversationID);
		expect(await openMessage(own, reader(A))).toMatchObject({content: 'hi B'});
	});

	it('refuses a copy whose content, recipient or conversation was changed', async () => {
		const copy = await sentByA('original');
		const tampered: ConversationMessage[] = [
			{...copy, content: copy.content.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))},
			{...copy, conversationID: conversationIDOf([B.address, C.address])},
			{...copy, namespace: 'other'},
		];
		for (const message of tampered) {
			expect((await openMessage(message, reader(B))).error?.code).toBe('unverified');
		}
	});

	it("refuses a copy whose sender key is not the sender's (a server forging a sender)", async () => {
		const copy = await sentByA('from A');
		// C's key and proof, under A's name
		const forged = {...copy, senderPublicKey: C.delegatePublicKey, senderOwnershipSignature: C.ownershipSignature};
		expect((await openMessage(forged, reader(B))).error?.code).toBe('unverified');
	});

	it('shows an undecryptable copy as such and the rest of the thread as text', async () => {
		const conversationID = conversationIDOf([A.address, B.address]);
		await sentByA('readable');
		// a copy A signed, whose content is not a ciphertext B can open
		const garbage = 'AAAA:BBBB';
		const signed = async (to: TestUser) =>
			signMessageCopy(
				{
					domain: DOMAIN,
					namespace: NAMESPACE,
					conversationID,
					messageType: 'encrypted',
					from: A.address,
					to: to.address,
					toPublicKey: B.delegatePublicKey,
					content: garbage,
				},
				A.delegatePrivateKey,
			);
		await h.api.sendMessage(
			{
				type: 'sendMessage',
				domain: DOMAIN,
				namespace: NAMESPACE,
				conversationID,
				lastMessageReadTimestampMS: 0,
				messageType: 'encrypted',
				messages: [
					{to: A.address, toPublicKey: B.delegatePublicKey, content: garbage, signature: await signed(A)},
					{to: B.address, toPublicKey: B.delegatePublicKey, content: garbage, signature: await signed(B)},
				],
			},
			{privateKey: A.delegatePrivateKey},
		);

		const conversation = conversationOf(B, A);
		const state = await until(conversation, (s) => s.step === 'Fetched' && s.messages.length === 2);
		if (state.step !== 'Fetched') throw new Error('unreachable');
		expect(state.messages.map((m) => m.content ?? m.error?.code)).toEqual(['readable', 'undecryptable']);
	});
});
