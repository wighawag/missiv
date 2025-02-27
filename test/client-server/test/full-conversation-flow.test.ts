import {describe, it, expect, beforeEach} from 'vitest';

import {
	api,
	USER_A,
	USER_B,
	USER_C,
	setupTestUsers,
	sendMessage,
	createConversation,
	getAcceptedConversations,
	getUnacceptedConversations,
	getMessages,
	getMessageContents,
	acceptConversation,
	rejectConversation,
} from './setup.js';

describe('full conversation flow', () => {
	beforeEach(async () => {
		await setupTestUsers([USER_A, USER_B]);
	});

	it('sending a message first time ends up in conversation request only', async () => {
		const time = Date.now();
		const sent = await sendMessage({
			from: USER_B,
			to: USER_A,
			content: 'Yo !',
		});

		expect(sent.timestampMS).toBeGreaterThan(time);

		const acceptedConversations = await getAcceptedConversations(USER_A);
		expect(acceptedConversations.length).toBe(0);

		const unacceptedConversations = await getUnacceptedConversations(USER_A);
		expect(unacceptedConversations.length).toBe(1);
	});

	it('accepting a conversation request make it end up in conversations', async () => {
		const conversationID = await createConversation({
			from: USER_B,
			to: USER_A,
			content: 'Yo !',
		});

		const unacceptedBefore = await getUnacceptedConversations(USER_A);
		expect(unacceptedBefore.length).toBe(1);

		await api.acceptConversation(
			{
				type: 'acceptConversation',
				domain: 'test.com',
				namespace: 'test',
				conversationID,
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_A.delegatePublicKey},
		);

		const unacceptedAfter = await getUnacceptedConversations(USER_A);
		expect(unacceptedAfter.length).toBe(0);

		const acceptedConversations = await getAcceptedConversations(USER_A);
		expect(acceptedConversations.length).toBe(1);
	});

	it('sending further message on an accepted conversation end up there', async () => {
		const conversationID = await createConversation({
			from: USER_B,
			to: USER_A,
			content: 'Yo !',
		});

		await acceptConversation({user: USER_A, conversationID});

		await sendMessage({
			from: USER_B,
			to: USER_A,
			content: 'Yo again !',
			conversationID,
		});

		const acceptedConversations = await getAcceptedConversations(USER_A);
		expect(acceptedConversations.length).toBe(1);

		const messagesA = await getMessages(USER_A, conversationID);
		expect(messagesA.length).toBe(2);

		const contentsA = await getMessageContents(USER_A, conversationID);
		const contentsB = await getMessageContents(USER_B, conversationID);

		expect(contentsA).toEqual(contentsB);
	});

	it('reply show up as unread', async () => {
		const firstReadingTimeB = Date.now();
		await sendMessage({
			from: USER_B,
			to: USER_A,
			content: 'Yo !',
			timestamp: firstReadingTimeB,
		});

		const unacceptedConversations = await getUnacceptedConversations(USER_A);
		expect(unacceptedConversations.length).toBe(1);

		const acceptingTimeA = Date.now();
		await api.acceptConversation(
			{
				type: 'acceptConversation',
				domain: 'test.com',
				namespace: 'test',
				conversationID: unacceptedConversations[0].conversationID,
				lastMessageReadTimestampMS: acceptingTimeA,
			},
			{publicKey: USER_A.delegatePublicKey},
		);

		const readingTimeB = Date.now();
		await sendMessage({
			from: USER_B,
			to: USER_A,
			content: 'How are you?',
			conversationID: '1',
			timestamp: readingTimeB,
		});

		const readingTimeA = Date.now();
		await sendMessage({
			from: USER_A,
			to: USER_B,
			content: 'I am good thanks',
			conversationID: '1',
			timestamp: readingTimeA,
		});

		const conversationsB = await getAcceptedConversations(USER_B);
		expect(conversationsB.length).toBe(1);
		expect(conversationsB[0].accepted).toBeTruthy();
		expect(conversationsB[0].lastRead).toBeLessThan(readingTimeA);

		const conversationsA = await getAcceptedConversations(USER_A);
		expect(conversationsA.length).toBe(1);
		expect(conversationsA[0].accepted).toBeTruthy();
		expect(conversationsA[0].lastRead).toBe(readingTimeA); // read because by replying to B, we automatically consider A reading B message
	});

	// New tests
	it('group conversations with multiple participants', async () => {
		await setupTestUsers([USER_A, USER_B, USER_C]);

		// Start a group conversation
		await sendMessage({
			from: USER_A,
			to: [USER_B, USER_C],
			content: 'Group chat started!',
			conversationID: 'group1',
		});

		// Check all recipients have unaccepted conversations
		const unacceptedB = await getUnacceptedConversations(USER_B);
		const unacceptedC = await getUnacceptedConversations(USER_C);
		expect(unacceptedB.length).toBe(1);
		expect(unacceptedC.length).toBe(1);

		// B accepts the conversation
		await api.acceptConversation(
			{
				type: 'acceptConversation',
				domain: 'test.com',
				namespace: 'test',
				conversationID: 'group1',
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_B.delegatePublicKey},
		);

		// B should now have the conversation in accepted
		const acceptedB = await getAcceptedConversations(USER_B);
		expect(acceptedB.length).toBe(1);

		// C still has it in unaccepted
		const stillUnacceptedC = await getUnacceptedConversations(USER_C);
		expect(stillUnacceptedC.length).toBe(1);

		// B replies to the group
		await sendMessage({
			from: USER_B,
			to: [USER_A, USER_C],
			content: 'Hi everyone!',
			conversationID: 'group1',
		});

		// Check message counts
		const messagesA = await getMessages(USER_A, 'group1');
		const messagesB = await getMessages(USER_B, 'group1');
		expect(messagesA.length).toBe(2);
		expect(messagesB.length).toBe(2);

		// C still hasn't accepted, but should still get messages
		const messagesC = await getMessages(USER_C, 'group1');
		expect(messagesC.length).toBe(2);
	});

	it('conversation with different message types', async () => {
		// Create a conversation with a clear text message
		const conversationID = await createConversation({
			from: USER_A,
			to: USER_B,
			content: 'Initial clear message',
		});

		// User B accepts
		await api.acceptConversation(
			{
				type: 'acceptConversation',
				domain: 'test.com',
				namespace: 'test',
				conversationID,
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_B.delegatePublicKey},
		);

		// Send an "encrypted" message (just simulated with different message type)
		await sendMessage({
			from: USER_A,
			to: USER_B,
			content: '{"encrypted":"content"}',
			conversationID,
			messageType: 'encrypted',
		});

		// Check messages
		const messages = await getMessages(USER_B, conversationID);
		expect(messages.length).toBe(2);

		expect(messages[0].message).toMatch(/.*encrypted.*/);
	});

	it('rejecting conversation requests', async () => {
		// User C attempts to message user A
		await setupTestUsers([USER_A, USER_B, USER_C]);

		await sendMessage({
			from: USER_C,
			to: USER_A,
			content: 'Hello there!',
		});

		// Check A has unaccepted conversation
		const unacceptedA = await getUnacceptedConversations(USER_A);
		expect(unacceptedA.length).toBe(1);

		await rejectConversation({
			from: USER_A,
			conversationID: unacceptedA[0].conversationID,
		});

		// after "rejection" message, conversation should be no more
		const stillUnaccepted = await getUnacceptedConversations(USER_A);
		expect(stillUnaccepted.length).toBe(0);

		const fromC = await getAcceptedConversations(USER_C);
		const messagesC = await getMessageContents(USER_C, fromC[0].conversationID);

		expect(messagesC).toContain('Hello there!');
		// reject by all ?
		// expect(fromC.)
	});
});
