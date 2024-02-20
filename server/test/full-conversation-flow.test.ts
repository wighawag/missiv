import { unstable_dev } from 'wrangler';
import type { UnstableDevWorker } from 'wrangler';
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { ResponseGetConversations, ResponseSendMessage } from '../src/types';
import { WorkerAPI } from './utils';

describe('Worker', () => {
	let worker: UnstableDevWorker;
	let api: WorkerAPI;

	beforeAll(async () => {
		worker = await unstable_dev(__dirname + '/../src/worker.ts', {
			experimental: { disableExperimentalWarning: true },
		});
		api = new WorkerAPI(worker);
	});

	afterEach(async () => {
		await api.clear();
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
				to: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
				message: 'Yo !',
			},
			{ account: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
		);
		expect(sent.timestampMS).to.toBeGreaterThan(time);
		const conversations = await api.getConversations({ account: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
		expect(conversations.length).toBe(0);
		const conversationRequests = await api.getConversationRequests({ account: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
		expect(conversationRequests.length).toBe(1);
	});

	it('accepting a conversation request make it end up in conmversations', async () => {
		await api.sendMessage(
			{
				to: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
				message: 'Yo !',
			},
			{ account: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
		);
		const conversationRequests = await api.getConversationRequests({ account: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
		await api.acceptConversation(
			{ with: `0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`, unacceptedID: conversationRequests[0].id },
			{ account: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
		);
		const conversationRequestsAfter = await api.getConversationRequests({ account: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
		expect(conversationRequestsAfter.length).toBe(0);
		const conversations = await api.getConversations({ account: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
		expect(conversations.length).toBe(1);
	});
});
