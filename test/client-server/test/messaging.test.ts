// The 0.6 messaging API (ADR-0006 "Sending" and "API") end to end, against the
// in-process server: a send authorized by the session token plus the message's
// own signature against the sender's current key set, the messageID window, a
// retry and a conflict, conversations per (domain, namespace, conversationID),
// reads by seq, and blocks the sender never learns of. The stores below the
// routes have their own contract suite (`packages/server/test/store-contract.ts`).
import {describe, it, expect, beforeEach} from 'vitest';
import {MissivAPIError} from '@missiv/client';
import {keySetRef} from 'delegated-identity';
import {MESSAGE_ID_WINDOW_MS, signMessage, ulidAt, type MessageToSend} from '@missiv/common';
import {
	APP_ORIGIN,
	conversationIDOf,
	createHarness,
	createUser,
	DOMAIN,
	newKeySet,
	publicOf,
	type Harness,
	type TestUser,
} from './setup.js';

let h: Harness;
let A: TestUser;
let B: TestUser;
let C: TestUser;
let AB: string;

beforeEach(async () => {
	h = createHarness();
	[A, B, C] = await Promise.all([createUser(), createUser(), createUser()]);
	await h.registerAll([A, B, C]);
	AB = conversationIDOf([A.address, B.address]);
});

/** `message` with some fields changed, signed again by `signer`'s signing key. */
async function resigned(message: MessageToSend, changes: Partial<MessageToSend>, signer: TestUser = A) {
	const {signature: _, ...rest} = {...message, ...changes} as MessageToSend;
	return {...rest, signature: await signMessage(rest, signer.keySet.signing.privateKey)} as MessageToSend;
}

async function refusal(call: Promise<unknown>) {
	const error = await call.then(
		() => undefined,
		(e) => e,
	);
	expect(error).toBeInstanceOf(MissivAPIError);
	return error as MissivAPIError;
}

/** Nothing of A's conversation with B is stored: no message, no inbox row on either side. */
async function nothingStored() {
	expect(await h.messages(A, AB)).toEqual([]);
	expect(await h.conversations(A)).toEqual([]);
	expect(await h.conversations(B)).toEqual([]);
}

describe('a send is authorized by its session and its own signature', () => {
	it('stores a message signed by the current key set of the session, under seq 1', async () => {
		const {message, seq, serverTimestamp} = await h.send({from: A, to: B, content: 'hello', scheme: 'pairwise-v1'});
		expect(seq).toBe(1);
		const [stored] = await h.messages(B, AB);
		expect(stored).toEqual({...message, seq, serverTimestamp});
	});

	it('refuses a forged signature, storing nothing', async () => {
		const message = await h.compose({from: A, to: B, content: 'genuine'});
		const forged = [
			{...message, content: 'changed after signing'},
			{...message, signature: `0x${'00'.repeat(64)}` as `0x${string}`},
			await resigned(message, {}, C), // signed by another account's key
		];
		for (const candidate of forged) {
			expect(await refusal(h.sendMessage(A, candidate))).toMatchObject({status: 403, code: 'forbidden'});
		}
		await nothingStored();
	});

	it('refuses a wrong sender key: another account, another key set, a replaced key set', async () => {
		const message = await h.compose({from: A, to: B});
		// on A's session, a message from C, or naming B's key set
		expect(await refusal(h.sendMessage(A, await h.compose({from: C, to: B})))).toMatchObject({status: 403});
		expect(await refusal(h.sendMessage(A, await resigned(message, {senderKeyRef: B.keyRef})))).toMatchObject({
			status: 403,
		});

		// A's session opened with a key set A has since replaced: the token is still
		// valid (an hour), the key set is no longer current
		await h.api.listConversations(
			{type: 'listConversations', domain: DOMAIN, namespace: message.namespace},
			{privateKey: A.keySet.signing.privateKey},
		);
		const replacement = newKeySet();
		await h.api.register(
			{
				type: 'register',
				domain: DOMAIN,
				appOrigin: APP_ORIGIN,
				address: A.address,
				keySet: publicOf(replacement),
				ownershipSignature: await A.signPublication(replacement),
			},
			{privateKey: replacement.signing.privateKey},
		);
		expect(await refusal(h.sendMessage(A, await h.compose({from: A, to: B})))).toMatchObject({
			status: 403,
			code: 'forbidden',
		});
		await nothingStored();
	});

	it('refuses a messageID outside the 10-minute window as stale, with the server time, storing nothing', async () => {
		for (const offset of [-(MESSAGE_ID_WINDOW_MS + 60_000), MESSAGE_ID_WINDOW_MS + 60_000]) {
			const before = Date.now();
			const message = await h.compose({from: A, to: B, messageID: ulidAt(Date.now() + offset)});
			const error = await refusal(h.sendMessage(A, message));
			expect(error).toMatchObject({status: 400, code: 'stale'});
			expect((error.details as {serverTime: number}).serverTime).toBeGreaterThanOrEqual(before);
		}
		await nothingStored();
		// within the window is accepted
		await h.sendMessage(A, await h.compose({from: A, to: B, messageID: ulidAt(Date.now() - 60_000)}));
	});

	it('answers a retry (same messageID, same signature) with the stored seq, and refuses another signature', async () => {
		const first = await h.send({from: A, to: B, content: 'once'});
		await h.send({from: A, to: B, content: 'twice'});
		expect(await h.sendMessage(A, first.message)).toEqual({seq: 1, serverTimestamp: first.serverTimestamp});
		const conflict = await resigned(first.message, {content: 'another message, the same messageID'});
		expect(await refusal(h.sendMessage(A, conflict))).toMatchObject({status: 409, code: 'conflict'});
		expect(await h.contents(B, AB)).toEqual(['once', 'twice']);
	});

	it('costs a bounded number of statements in one transaction, whatever the history', async () => {
		await h.send({from: A, to: B});
		const measure = async () => {
			const message = await h.compose({from: A, to: B});
			h.queries.length = 0;
			await h.sendMessage(A, message);
			return [...h.queries];
		};
		const early = await measure();
		for (let i = 0; i < 100; i++) {
			await h.send({from: i % 2 ? A : B, to: i % 2 ? B : A});
		}
		const late = await measure();
		// the directory read of the sender's key set, and the append's five
		expect(late).toEqual(early);
		expect(late.length).toBeLessThanOrEqual(6);
		expect(late.filter((sql) => /RequestSignatures/.test(sql))).toEqual([]);
	});
});

/** The same account in `other.com`: its key set there (a key set belongs to one domain), registered for that origin. */
async function inOtherDomain(user: TestUser): Promise<TestUser> {
	const keySet = newKeySet();
	const other = {
		...user,
		keySet,
		keyRef: await keySetRef(keySet),
		ownershipSignature: await user.signPublication(keySet, 'https://other.com'),
	};
	await h.api.register(
		{
			type: 'register',
			domain: 'other.com',
			appOrigin: 'https://other.com',
			address: user.address,
			keySet: publicOf(keySet),
			ownershipSignature: other.ownershipSignature,
		},
		{privateKey: keySet.signing.privateKey},
	);
	return other;
}

describe('a conversation is (domain, namespace, conversationID)', () => {
	it('keeps the same two members apart per namespace and per domain', async () => {
		const [A2, B2] = [await inOtherDomain(A), await inOtherDomain(B)];
		await h.send({from: A, to: B, namespace: 'one'});
		await h.send({from: A, to: B, namespace: 'one'});
		expect((await h.send({from: A, to: B, namespace: 'two'})).seq).toBe(1);
		expect((await h.send({from: A2, to: B2, domain: 'other.com'})).seq).toBe(1);

		await h.accept(B, AB, {namespace: 'one'});
		expect((await h.accepted(B, {namespace: 'one'})).map((c) => c.lastSeq)).toEqual([2]);
		expect((await h.unaccepted(B, {namespace: 'two'})).map((c) => c.lastSeq)).toEqual([1]);
		expect((await h.accepted(B, {namespace: 'two'})).length).toBe(0);
		await h.send({from: A2, to: B2, domain: 'other.com', namespace: 'one'});
		expect((await h.unaccepted(B2, {domain: 'other.com'})).map((c) => c.lastSeq)).toEqual([1]);
		expect((await h.unaccepted(B2, {domain: 'other.com', namespace: 'one'})).map((c) => c.lastSeq)).toEqual([1]);
		expect((await h.messages(B, AB, {namespace: 'two'})).length).toBe(1);
	});
});

describe('reading by seq', () => {
	it('after returns only newer messages in seq order; before pages back', async () => {
		for (let i = 1; i <= 6; i++) {
			await h.send({from: i % 2 ? A : B, to: i % 2 ? B : A, content: `m${i}`});
		}
		expect((await h.messages(B, AB, {after: 4})).map((m) => [m.seq, m.content])).toEqual([
			[5, 'm5'],
			[6, 'm6'],
		]);
		expect((await h.messages(B, AB, {after: 6})).length).toBe(0);
		expect((await h.messages(B, AB, {before: 3})).map((m) => m.seq)).toEqual([1, 2]);
		expect((await h.messages(B, AB, {limit: 2})).map((m) => m.seq)).toEqual([5, 6]);
		await expect(h.messages(B, AB, {after: 1, before: 3})).rejects.toMatchObject({status: 400});
	});

	it('is for the members only', async () => {
		await h.send({from: A, to: B});
		await expect(h.messages(C, AB)).rejects.toMatchObject({status: 403});
	});
});

describe('blocks', () => {
	it('reject blocks the other member across the domain; unblock lifts it; the sender is never told', async () => {
		await h.send({from: A, to: B, content: 'first'});
		await h.reject(B, AB);

		// acknowledged like any other, seen by the sender, never by B
		const hidden = await h.send({from: A, to: B, content: 'while blocked'});
		expect(hidden.seq).toBe(2);
		const elsewhere = await h.send({from: A, to: B, content: 'in another namespace', namespace: 'other'});
		expect(elsewhere.seq).toBe(1);
		expect(await h.contents(A, AB)).toEqual(['first', 'while blocked']);
		expect(await h.contents(B, AB)).toEqual(['first']);
		expect(await h.conversations(B, undefined, {namespace: 'other'})).toEqual([]);
		// A's view of the conversation gives nothing away
		const [forA] = await h.conversations(A);
		expect([forA.status, forA.lastSeq]).toEqual(['accepted', 2]);
		expect((await h.conversations(B, 'rejected')).map((c) => c.lastSeq)).toEqual([1]);

		await h.api.unblock(
			{type: 'unblock', domain: DOMAIN, address: A.address},
			{privateKey: B.keySet.signing.privateKey},
		);
		await h.send({from: A, to: B, content: 'after unblock'});
		expect(await h.contents(B, AB)).toEqual(['first', 'after unblock']);
	});
});
