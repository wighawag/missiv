import {describe, it, expect, beforeEach} from 'vitest';

import {api, FAKE_SIG, USER_A, USER_B} from './setup.js';

describe('full conversation flow', () => {
	beforeEach(async () => {
		await api.clear();
		await api.register(
			{
				type: 'register',
				address: USER_B.address,
				signature: USER_B.signatureForDelegation,
				domain: 'test.com',
			},
			{privateKey: USER_B.delegatePrivateKey},
		);
		await api.register(
			{
				type: 'register',
				address: USER_A.address,
				signature: USER_A.signatureForDelegation,
				domain: 'test.com',
			},
			{privateKey: USER_A.delegatePrivateKey},
		);
	});

	it('sending a message first time ends up in conversation request only', async () => {
		const time = Date.now();
		const sent = await api.sendMessage(
			{
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				messages: [
					{content: 'Yo !', to: USER_A.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_A.delegatePublicKey,
					{content: 'Yo !', to: USER_B.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_B.delegatePublicKey,
				],
				messageType: 'clear',
				conversationID: '1', // TODO not specified (generated from hash of user addresses)
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_B.delegatePublicKey},
		);
		expect(sent.timestampMS).to.toBeGreaterThan(time);
		const {acceptedConversations} = await api.getAcceptedConversations(
			{type: 'getAcceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(acceptedConversations.length).toBe(0);
		const {unacceptedConversations} = await api.getUnacceptedConversations(
			{type: 'getUnacceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(unacceptedConversations.length).toBe(1);
	});

	it('accepting a conversation request make it end up in conversations', async () => {
		await api.sendMessage(
			{
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				messages: [
					{content: 'Yo !', to: USER_A.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_A.delegatePublicKey,
					{content: 'Yo !', to: USER_B.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_B.delegatePublicKey,
				],
				messageType: 'clear',
				conversationID: '1', // TODO not specified (generated from hash of user addresses)
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_B.delegatePublicKey},
		);
		const {unacceptedConversations} = await api.getUnacceptedConversations(
			{type: 'getUnacceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(unacceptedConversations.length).toBe(1);
		await api.acceptConversation(
			{
				type: 'acceptConversation',
				domain: 'test.com',
				namespace: 'test',
				conversationID: unacceptedConversations[0].conversationID,
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_A.delegatePublicKey},
		);
		const {unacceptedConversations: unacceptedConversationsAfter} = await api.getUnacceptedConversations(
			{type: 'getUnacceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(unacceptedConversationsAfter.length).toBe(0);
		const {acceptedConversations} = await api.getAcceptedConversations(
			{type: 'getAcceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(acceptedConversations.length).toBe(1);
	});

	it('sending further message on an accepted conversation end up there', async () => {
		await api.sendMessage(
			{
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				messages: [
					{content: 'Yo !', to: USER_A.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_A.delegatePublicKey,
					{content: 'Yo !', to: USER_B.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_B.delegatePublicKey,
				],
				messageType: 'clear',
				conversationID: '1', // TODO not specified (generated from hash of user addresses)
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_B.delegatePublicKey},
		);
		const {unacceptedConversations} = await api.getUnacceptedConversations(
			{type: 'getUnacceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(unacceptedConversations.length).toBe(1);

		await api.acceptConversation(
			{
				type: 'acceptConversation',
				domain: 'test.com',
				namespace: 'test',
				conversationID: unacceptedConversations[0].conversationID,
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_A.delegatePublicKey},
		);
		await api.sendMessage(
			{
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				messages: [
					{content: 'Yo again !', to: USER_A.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_A.delegatePublicKey,
					{content: 'Yo again !', to: USER_B.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_B.delegatePublicKey,
				],
				messageType: 'clear',
				conversationID: '1', // TODO not specified (generated from hash of user addresses)
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_B.delegatePublicKey},
		);
		const {acceptedConversations} = await api.getAcceptedConversations(
			{type: 'getAcceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(acceptedConversations.length).toBe(1);
		const {messages: messagesA} = await api.getMessages(
			{
				type: 'getMessages',
				domain: 'test.com',
				namespace: 'test',
				conversationID: acceptedConversations[0].conversationID,
			},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(messagesA.length).toBe(2);
		console.log(messagesA);
		const messagesContentA = messagesA.map((v) => JSON.parse(v.message).content);
		const {messages: messagesB} = await api.getMessages(
			{
				type: 'getMessages',
				domain: 'test.com',
				namespace: 'test',
				conversationID: acceptedConversations[0].conversationID,
			},
			{publicKey: USER_B.delegatePublicKey},
		);
		const messagesContentB = messagesB.map((v) => JSON.parse(v.message).content);
		// console.log({ messagesA });
		expect(messagesContentA).to.toEqual(messagesContentB);
	});

	it('reply show up as unread', async () => {
		const firstReadingTimeB = Date.now();
		await api.sendMessage(
			{
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				messages: [
					{content: 'Yo !', to: USER_A.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_A.delegatePublicKey,
					{content: 'Yo !', to: USER_B.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_B.delegatePublicKey,
				],
				messageType: 'clear',
				conversationID: '1', // TODO not specified (generated from hash of user addresses)
				lastMessageReadTimestampMS: firstReadingTimeB,
			},
			{publicKey: USER_B.delegatePublicKey},
		);
		const {unacceptedConversations} = await api.getUnacceptedConversations(
			{type: 'getUnacceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
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
		await api.sendMessage(
			{
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				messages: [
					{content: 'How are you?', to: USER_A.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_A.delegatePublicKey,
					{content: 'How are you?', to: USER_B.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_B.delegatePublicKey,
				],
				messageType: 'clear',
				conversationID: '1', // TODO not specified (generated from hash of user addresses)
				lastMessageReadTimestampMS: Date.now(),
			},
			{publicKey: USER_B.delegatePublicKey},
		);
		const readingTimeA = Date.now();
		await api.sendMessage(
			{
				type: 'sendMessage',
				domain: 'test.com',
				namespace: 'test',
				messages: [
					{content: 'I am good thanks', to: USER_B.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_B.delegatePublicKey,
					{content: 'I am good thanks', to: USER_A.address, signature: FAKE_SIG, toPublicKey: '0xff'}, //// toPublicKey: USER_A.delegatePublicKey,
				],
				messageType: 'clear',
				conversationID: '1', // TODO not specified (generated from hash of user addresses)
				lastMessageReadTimestampMS: readingTimeA,
			},
			{publicKey: USER_A.delegatePublicKey},
		);
		const {acceptedConversations: conversationsB} = await api.getAcceptedConversations(
			{type: 'getAcceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_B.delegatePublicKey},
		);
		expect(conversationsB.length).toBe(1);
		expect(conversationsB[0].accepted).toBeTruthy();

		// console.log({
		// 	firstReadingTimeB,
		// 	acceptingTimeA,
		// 	readingTimeB,
		// 	readingTimeA,
		// });
		// console.log(conversationsB);

		expect(conversationsB[0].lastRead).toBeLessThan(readingTimeA);
		const {acceptedConversations: conversationsA} = await api.getAcceptedConversations(
			{type: 'getAcceptedConversations', domain: 'test.com', namespace: 'test'},
			{publicKey: USER_A.delegatePublicKey},
		);
		expect(conversationsA.length).toBe(1);
		expect(conversationsA[0].accepted).toBeTruthy();
		expect(conversationsA[0].lastRead).toBe(readingTimeA); // read because by replying to B, we automatically consider A reading B message
	});
});
