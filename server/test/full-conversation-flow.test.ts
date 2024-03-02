import { unstable_dev } from 'wrangler';
import type { UnstableDevWorker } from 'wrangler';
import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { WorkerAPI } from './utils';
import { getConversationID } from '../src/api';

const USER_A = {
	publicKey: '0xFAKE_AA',
	address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;

const USER_B = {
	publicKey: '0xFAKE_BB',
	address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
} as const;

describe('Worker', () => {
	let worker: UnstableDevWorker;
	let api: WorkerAPI;

	beforeAll(async () => {
		worker = await unstable_dev(__dirname + '/../src/worker.ts', {
			experimental: { disableExperimentalWarning: true },
		});
		api = new WorkerAPI(worker);
	});

	beforeEach(async () => {
		await api.clear();
		await api.register(
			{
				address: USER_B.address,
				signature: '0x',
			},
			{ publicKey: USER_B.publicKey },
		);
		await api.register(
			{
				address: USER_A.address,
				signature: '0x',
			},
			{ publicKey: USER_A.publicKey },
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
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
			},
			{ publicKey: USER_B.publicKey },
		);
		expect(sent.timestampMS).to.toBeGreaterThan(time);
		const conversations = await api.getConversations({ publicKey: USER_A.publicKey });
		expect(conversations.length).toBe(0);
		const unacceptedConversations = await api.getUnacceptedConversations({ publicKey: USER_A.publicKey });
		expect(unacceptedConversations.length).toBe(1);
	});

	it('accepting a conversation request make it end up in conversations', async () => {
		await api.sendMessage(
			{
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
			},
			{ publicKey: USER_B.publicKey },
		);
		const unacceptedConversations = await api.getUnacceptedConversations({ publicKey: USER_A.publicKey });
		expect(unacceptedConversations.length).toBe(1);
		await api.acceptConversation(
			{
				conversationID: unacceptedConversations[0].conversationID,
			},
			{ publicKey: USER_A.publicKey },
		);
		const unacceptedConversationsAfter = await api.getUnacceptedConversations({ publicKey: USER_A.publicKey });
		expect(unacceptedConversationsAfter.length).toBe(0);
		const conversations = await api.getConversations({ publicKey: USER_A.publicKey });
		expect(conversations.length).toBe(1);
	});

	it('sending further message on an accepted conversation end up there', async () => {
		await api.sendMessage(
			{
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
			},
			{ publicKey: USER_B.publicKey },
		);
		const unacceptedConversations = await api.getUnacceptedConversations({ publicKey: USER_A.publicKey });
		expect(unacceptedConversations.length).toBe(1);

		await api.acceptConversation(
			{
				conversationID: unacceptedConversations[0].conversationID,
			},
			{ publicKey: USER_A.publicKey },
		);
		await api.sendMessage(
			{
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
			},
			{ publicKey: USER_B.publicKey },
		);
		const conversations = await api.getConversations({ publicKey: USER_A.publicKey });
		expect(conversations.length).toBe(1);
		const messagesA = await api.getMessages({ conversationID: conversations[0].conversationID }, { publicKey: USER_A.publicKey });
		expect(messagesA.length).toBe(2);
		const messagesB = await api.getMessages({ conversationID: conversations[0].conversationID }, { publicKey: USER_B.publicKey });
		expect(messagesA).to.toEqual(messagesB);
	});

	it('reply show up as unread', async () => {
		await api.sendMessage(
			{
				to: USER_A.address,
				message: 'Yo !',
				signature: '0x',
			},
			{ publicKey: USER_B.publicKey },
		);
		const unacceptedConversations = await api.getUnacceptedConversations({ publicKey: USER_A.publicKey });
		expect(unacceptedConversations.length).toBe(1);
		await api.acceptConversation(
			{
				conversationID: unacceptedConversations[0].conversationID,
			},
			{ publicKey: USER_A.publicKey },
		);
		await api.sendMessage(
			{
				to: USER_A.address,
				message: 'how are you?',
				signature: '0x',
			},
			{ publicKey: USER_B.publicKey },
		);
		await api.sendMessage(
			{
				to: USER_B.address,
				message: 'I am good thanks',
				signature: '0x',
			},
			{ publicKey: USER_A.publicKey },
		);
		const conversationsB = await api.getConversations({ publicKey: USER_B.publicKey });
		expect(conversationsB.length).toBe(1);
		expect(conversationsB[0].read).toBe(false);
		const conversationsA = await api.getConversations({ publicKey: USER_A.publicKey });
		expect(conversationsA.length).toBe(1);
		expect(conversationsA[0].read).toBe(true);
	});
});
