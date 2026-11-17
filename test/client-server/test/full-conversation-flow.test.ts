import {describe, it, expect, beforeEach} from 'vitest';
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
		expect(sent.timestampMS).toBeGreaterThanOrEqual(time);

		expect((await h.accepted(A)).length).toBe(0);
		expect((await h.unaccepted(A)).length).toBe(1);
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
		await h.send({from: B, to: A, content: 'Yo again !'});

		expect((await h.accepted(A)).length).toBe(1);
		expect((await h.messages(A, conversationID)).length).toBe(2);
		expect(await h.contents(A, conversationID)).toEqual(await h.contents(B, conversationID));
	});

	it('reply show up as unread', async () => {
		const conversationID = conversationIDOf([A.address, B.address]);
		await h.send({from: B, to: A, content: 'Yo !', timestamp: Date.now()});
		expect((await h.unaccepted(A)).length).toBe(1);

		await h.accept(A, conversationID, Date.now());

		const readingTimeB = Date.now();
		await h.send({from: B, to: A, content: 'How are you?', timestamp: readingTimeB});
		const readingTimeA = Date.now();
		await h.send({from: A, to: B, content: 'I am good thanks', timestamp: readingTimeA});

		const conversationsB = await h.accepted(B);
		expect(conversationsB.length).toBe(1);
		expect(conversationsB[0].accepted).toBeTruthy();
		expect(conversationsB[0].lastRead).toBe(readingTimeB);
		expect(conversationsB[0].lastRead).toBeLessThanOrEqual(readingTimeA);

		const conversationsA = await h.accepted(A);
		expect(conversationsA.length).toBe(1);
		expect(conversationsA[0].accepted).toBeTruthy();
		// replying to B counts as A having read B's messages
		expect(conversationsA[0].lastRead).toBe(readingTimeA);
	});

	it('group conversations with multiple participants', async () => {
		await h.register(C);
		const group = conversationIDOf([A.address, B.address, C.address]);

		await h.send({from: A, to: [B, C], content: 'Group chat started!'});
		expect((await h.unaccepted(B)).length).toBe(1);
		expect((await h.unaccepted(C)).length).toBe(1);

		await h.accept(B, group);
		expect((await h.accepted(B)).length).toBe(1);
		expect((await h.unaccepted(C)).length).toBe(1);

		await h.send({from: B, to: [A, C], content: 'Hi everyone!'});
		expect((await h.messages(A, group)).length).toBe(2);
		expect((await h.messages(B, group)).length).toBe(2);
		// C has not accepted, and still receives the messages
		expect((await h.messages(C, group)).length).toBe(2);
	});

	it('conversation with different message types', async () => {
		const conversationID = conversationIDOf([A.address, B.address]);
		await h.send({from: A, to: B, content: 'Initial clear message'});
		await h.accept(B, conversationID);
		await h.send({from: A, to: B, content: '{"encrypted":"content"}', messageType: 'encrypted'});

		const messages = await h.messages(B, conversationID);
		expect(messages.length).toBe(2);
		expect(messages[0].messageType).toBe('encrypted');
	});

	it('rejecting conversation requests', async () => {
		await h.register(C);
		await h.send({from: C, to: A, content: 'Hello there!'});

		const unacceptedA = await h.unaccepted(A);
		expect(unacceptedA.length).toBe(1);

		await h.reject(A, unacceptedA[0].conversationID);
		expect((await h.unaccepted(A)).length).toBe(0);

		const fromC = await h.accepted(C);
		expect(await h.contents(C, fromC[0].conversationID)).toContain('Hello there!');
	});
});
