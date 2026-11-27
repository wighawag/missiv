import {describe, it, expect, beforeEach} from 'vitest';
import {isUnread} from '@missiv/common';
import {createHarness, createUser, conversationIDOf, type Harness, type TestUser} from './setup.js';

let h: Harness;
let A: TestUser;
let B: TestUser;
let C: TestUser;

describe('full conversation flow', () => {
	beforeEach(async () => {
		h = createHarness();
		[A, B, C] = await Promise.all([createUser(), createUser(), createUser()]);
		await h.registerAll([A, B]);
	});

	it('sending a message first time ends up in conversation request only', async () => {
		const time = Date.now();
		const sent = await h.send({from: B, to: A, content: 'Yo !'});
		expect(sent.seq).toBe(1);
		expect(sent.serverTimestamp).toBeGreaterThanOrEqual(time);

		expect((await h.accepted(A)).length).toBe(0);
		expect((await h.unaccepted(A)).length).toBe(1);
		// the sender's own side is accepted
		expect((await h.accepted(B)).length).toBe(1);
	});

	it('accepting a conversation request make it end up in conversations', async () => {
		await h.send({from: B, to: A, content: 'Yo !'});
		const [request] = await h.unaccepted(A);

		await h.accept(A, request.conversationID);

		expect((await h.unaccepted(A)).length).toBe(0);
		expect((await h.accepted(A)).length).toBe(1);
	});

	it('sending further message on an accepted conversation end up there', async () => {
		const conversationID = conversationIDOf([A.address, B.address]);
		await h.send({from: B, to: A, content: 'Yo !'});
		await h.accept(A, conversationID);
		await h.send({from: B, to: A, content: 'Yo again !', scheme: 'pairwise-v1'});

		expect((await h.accepted(A)).length).toBe(1);
		const messages = await h.messages(A, conversationID);
		expect(messages.map((m) => [m.seq, m.scheme])).toEqual([
			[1, 'clear'],
			[2, 'pairwise-v1'],
		]);
		// one row per message, the same for both members
		expect(await h.messages(B, conversationID)).toEqual(messages);
	});

	it('a reply shows up as unread, from lastReadSeq', async () => {
		const conversationID = conversationIDOf([A.address, B.address]);
		await h.send({from: B, to: A, content: 'Yo !'});
		await h.accept(A, conversationID);
		await h.markRead(A, conversationID, 1);
		expect(isUnread((await h.accepted(A))[0])).toBe(false);

		await h.send({from: B, to: A, content: 'How are you?'});
		const [unread] = await h.accepted(A);
		expect([unread.lastSeq, unread.lastReadSeq, isUnread(unread)]).toEqual([2, 1, true]);

		await h.send({from: A, to: B, content: 'I am good thanks'});
		// replying counts as A having read B's messages
		const [replied] = await h.accepted(A);
		expect([replied.lastSeq, replied.lastReadSeq, isUnread(replied)]).toEqual([3, 3, false]);
		const [forB] = await h.accepted(B);
		expect([forB.lastSeq, forB.lastReadSeq, isUnread(forB)]).toEqual([3, 2, true]);
	});

	it('a conversation is of two: a group conversationID is refused', async () => {
		await h.register(C);
		const group = conversationIDOf([A.address, B.address, C.address]);
		const message = await h.compose({from: A, to: B});
		await expect(h.sendMessage(A, {...message, conversationID: group})).rejects.toMatchObject({status: 400});
	});

	it('rejecting conversation requests', async () => {
		await h.register(C);
		await h.send({from: C, to: A, content: 'Hello there!'});

		const unacceptedA = await h.unaccepted(A);
		expect(unacceptedA.length).toBe(1);

		await h.reject(A, unacceptedA[0].conversationID);
		expect((await h.unaccepted(A)).length).toBe(0);
		expect((await h.conversations(A, 'rejected')).length).toBe(1);

		const fromC = await h.accepted(C);
		expect(await h.contents(C, fromC[0].conversationID)).toContain('Hello there!');
	});
});
