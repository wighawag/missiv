// The client trusts no key it has not verified (S3-12): every key against its
// wallet's ownership proof, no clear text unless asked, every message's
// signature checked on read, and one bad message shown as such instead of
// breaking the thread.
// Against the in-process server; a lying server is the real one behind a fetch
// that rewrites its answers.
import {describe, it, expect, beforeEach} from 'vitest';
import {writable} from 'svelte/store';
import {
	createMissivRegistration,
	openMessage,
	openOneConversation,
	verifyDomainUser,
	type Account,
} from '@missiv/client';
import {signMessage, type Message} from '@missiv/common';
import {
	accountOf,
	conversationIDOf,
	createHarness,
	createUser,
	DOMAIN,
	APP_ORIGIN,
	NAMESPACE,
	publicOf,
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

const reader = (user: TestUser) => ({address: user.address, domain: DOMAIN, keySet: user.keySet});

describe('key sets are verified against their ownership proof', () => {
	it("accepts a domain user's key set that its wallet signed for an origin of the domain", async () => {
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: B.address});
		expect(await verifyDomainUser(domainUser!, {address: B.address, domain: DOMAIN})).toBe(true);
	});

	it('refuses a key set whose ownership signature does not recover its address', async () => {
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: B.address});
		// the server hands out C's key set under B's name, with C's proof or B's, and C's keyRef or B's
		for (const forged of [
			{...domainUser!, keySet: publicOf(C.keySet), keyRef: C.keyRef, ownershipSignature: C.ownershipSignature},
			{...domainUser!, keySet: publicOf(C.keySet), keyRef: C.keyRef},
			{...domainUser!, keySet: publicOf(C.keySet)},
			// one key of each
			{...domainUser!, keySet: {signing: C.keySet.signing, encryption: B.keySet.encryption}},
		]) {
			expect(await verifyDomainUser(forged, {address: B.address, domain: DOMAIN})).toBe(false);
		}
	});

	it("refuses a key set under another key set's reference", async () => {
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: B.address});
		expect(await verifyDomainUser({...domainUser!, keyRef: C.keyRef}, {address: B.address, domain: DOMAIN})).toBe(
			false,
		);
	});

	it('refuses a proof made for an origin of another domain', async () => {
		const signature = await B.signPublication(B.keySet, 'https://other.com');
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: B.address});
		expect(
			await verifyDomainUser(
				{...domainUser!, ownershipSignature: signature, appOrigin: 'https://other.com'},
				{address: B.address, domain: DOMAIN},
			),
		).toBe(false);
	});

	it('the conversation encrypts nothing to a key set the server swapped in', async () => {
		const conversation = conversationOf(
			A,
			B,
			lyingFetch((user) => (user.user === B.address ? {...user, keySet: publicOf(C.keySet), keyRef: C.keyRef} : user)),
		);
		const stop = conversation.subscribe(() => {});
		const state = await until(conversation, (s) => !!s.otherUser.unverifiedKey);
		expect(state.otherUser.keySet).toBeUndefined();
		await expect(conversation.sendMessage('for B only')).rejects.toThrow(/not proven/);
		expect(await h.messages(B, conversationIDOf([A.address, B.address]))).toEqual([]);
		stop();
	});
});

describe('nothing is sent in clear unless asked', () => {
	it('refuses to send to a user with no key set, and sends an introduction when asked', async () => {
		const D = await createUser(); // never registered
		const conversation = conversationOf(A, D);
		const stop = conversation.subscribe(() => {});
		await until(conversation, (s) => s.step === 'Fetched');
		await expect(conversation.sendMessage('secret')).rejects.toThrow(/sendIntroduction/);
		expect(await h.messages(A, conversationIDOf([A.address, D.address]))).toEqual([]);

		await conversation.sendIntroduction('hello, register to read encrypted messages');
		const [message] = await h.messages(A, conversationIDOf([A.address, D.address]));
		expect(message.scheme).toBe('clear');
		stop();
	});

	it('sends encrypted to a verified key set: the server stores no text', async () => {
		const conversation = conversationOf(A, B);
		const stop = conversation.subscribe(() => {});
		await until(conversation, (s) => s.step === 'Fetched' && !!s.otherUser.keySet);
		await conversation.sendMessage('only for B');
		const [message] = await h.messages(B, conversationIDOf([A.address, B.address]));
		expect(message.scheme).toBe('pairwise-v1');
		expect(message.content).not.toContain('only for B');
		expect(await openMessage(message, reader(B), h.api)).toMatchObject({content: 'only for B'});
		stop();
	});
});

describe("each message's signature is verified on read", () => {
	async function sentByA(text: string) {
		await h.send({from: A, to: B, content: text, scheme: 'pairwise-v1'});
		const [message] = await h.messages(B, conversationIDOf([A.address, B.address]));
		return message;
	}

	it('opens a stored message signed by its sender, for both members', async () => {
		const message = await sentByA('hi B');
		expect(await openMessage(message, reader(B), h.api)).toMatchObject({content: 'hi B', sender: A.address});
		const [own] = await h.messages(A, message.conversationID);
		expect(own).toEqual(message);
		expect(await openMessage(own, reader(A), h.api)).toMatchObject({content: 'hi B'});
	});

	it('refuses a message a server changed: its content, conversation, namespace or sender key set', async () => {
		const message = await sentByA('original');
		const tampered: Message[] = [
			{...message, content: message.content.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))},
			{...message, conversationID: conversationIDOf([B.address, C.address])},
			{...message, namespace: 'other'},
			{...message, senderKeyRef: C.keyRef},
		];
		for (const forged of tampered) {
			expect((await openMessage(forged, reader(B), h.api)).error?.code).toBe('unverified');
		}
	});

	it('shows an undecryptable message as such and the rest of the thread as text', async () => {
		await sentByA('readable');
		// a message A signed, whose content is not a ciphertext B can open: the
		// server stores it (the signature is A's), the reader cannot decrypt it
		const composed = await h.compose({from: A, to: B, scheme: 'pairwise-v1'});
		const {signature: _, ...unsigned} = {...composed, content: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'};
		await h.sendMessage(A, {...unsigned, signature: await signMessage(unsigned, A.keySet.signing.privateKey)});

		const conversation = conversationOf(B, A);
		const state = await until(conversation, (s) => s.step === 'Fetched' && s.messages.length === 2);
		if (state.step !== 'Fetched') throw new Error('unreachable');
		expect(state.messages.map((m) => m.content ?? m.error?.code)).toEqual(['readable', 'undecryptable']);
	});
});
