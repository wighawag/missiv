// One test per defect the S3 review reproduced (missiv work/notes/observations/),
// written before its fix. A test marked `it.fails` is a known defect: it passes
// while the defect is there, and the fix turns it into a plain `it`.
import {describe, it, expect, beforeEach} from 'vitest';
import {
	createHarness,
	createUser,
	newDelegateKey,
	conversationIDOf,
	DOMAIN,
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

describe('production configuration (no DEV)', () => {
	it('refuses FAKE: request authentication', async () => {
		const response = await h.app.request('http://localhost/api/private/getConversations', {
			method: 'POST',
			headers: {'content-type': 'application/json', SIGNATURE: `FAKE:${A.delegatePublicKey}`},
			body: JSON.stringify({type: 'getConversations', domain: DOMAIN, namespace: 'test'}),
		});
		expect(response.ok).toBe(false);
	});

	it('refuses the all-zero registration signature', async () => {
		const user = await createUser();
		await expect(
			h.api.register(
				{
					type: 'register',
					domain: DOMAIN,
					address: user.address,
					signature: '0x0000000000000000000000000000000000000000000000000000000000000000',
				},
				{privateKey: user.delegatePrivateKey},
			),
		).rejects.toThrow();
	});

	it('refuses db-reset without the admin token', async () => {
		const response = await h.app.request('http://localhost/api/admin/db-reset', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({reset: true}),
		});
		expect(response.ok).toBe(false);
	});

	it.fails('runs db-reset with the admin token', async () => {
		const withToken = createHarness({ADMIN_TOKEN: 'secret'});
		await withToken.setupDatabase();
		const response = await withToken.app.request('http://localhost/api/admin/db-reset', {
			method: 'POST',
			headers: {'content-type': 'application/json', Authorization: 'Bearer secret'},
			body: JSON.stringify({reset: true}),
		});
		expect(response.ok).toBe(true);
	});
});

describe('a key acts only in its domain (request-key-acts-in-any-domain)', () => {
	it.fails('refuses a send naming another domain', async () => {
		await expect(h.send({from: A, to: B, content: 'cross', domain: 'other.com'})).rejects.toThrow();
	});

	it.fails('refuses a read naming another domain', async () => {
		await expect(h.messages(A, conversationIDOf([A.address, B.address]), 'other.com')).rejects.toThrow();
	});
});

describe('conversations the server keeps honest (send-message-trusts-client-conversation-id)', () => {
	it.fails('refuses a send into a conversation whose members do not include the sender', async () => {
		await h.send({from: A, to: B, content: 'from A'});
		await expect(
			h.send({from: C, to: B, content: 'injected', conversationID: conversationIDOf([A.address, B.address])}),
		).rejects.toThrow();
		expect(await h.contents(B, conversationIDOf([A.address, B.address]))).toEqual(['from A']);
	});

	it.fails('refuses a conversationID that is not its members', async () => {
		await expect(h.send({from: A, to: B, content: 'x', conversationID: 'free-form'})).rejects.toThrow();
	});
});

describe('reject blocks the sender (S3-9)', () => {
	it.fails('a rejected sender reaches the recipient under no conversation', async () => {
		await h.send({from: A, to: B, content: 'spam 1'});
		const [request] = await h.unaccepted(B);
		await h.reject(B, request.conversationID);
		await h.send({from: A, to: [B, C], content: 'spam 2'}).catch(() => {});
		expect(await h.unaccepted(B)).toEqual([]);
	});
});

describe('signed requests are not replayable (signed-requests-are-replayable-and-undomained)', () => {
	it.fails('refuses the same signed send twice', async () => {
		const body = JSON.stringify({
			type: 'sendMessage',
			domain: DOMAIN,
			namespace: 'test',
			conversationID: conversationIDOf([A.address, B.address]),
			lastMessageReadTimestampMS: 0,
			messageType: 'clear',
			signature: '0x00',
			messages: [
				{to: A.address, toPublicKey: A.delegatePublicKey, content: 'once'},
				{to: B.address, toPublicKey: B.delegatePublicKey, content: 'once'},
			],
		});
		let headers: Record<string, string> | undefined;
		const capture = new (h.api.constructor as any)('http://localhost', {
			fetch: async (url: string, init: RequestInit) => {
				headers = init.headers as Record<string, string>;
				return h.app.request(url, init);
			},
		});
		await capture.sendMessage(JSON.parse(body), {privateKey: A.delegatePrivateKey});
		const replay = await h.app.request('http://localhost/api/private/sendMessage', {method: 'POST', headers, body});
		expect(replay.ok).toBe(false);
		expect((await h.messages(B, conversationIDOf([A.address, B.address]))).length).toBe(1);
	});
});

describe('a second key for the same wallet (re-registering-a-new-key-keeps-the-old-one)', () => {
	it.fails('replaces the first, so the new key authenticates', async () => {
		const second = newDelegateKey();
		await h.api.register(
			{type: 'register', domain: DOMAIN, address: A.address, signature: await A.signPublication(second.publicKey)},
			{privateKey: second.privateKey},
		);
		await h.api.getConversations(
			{type: 'getConversations', domain: DOMAIN, namespace: 'test'},
			{privateKey: second.privateKey},
		);
	});
});
