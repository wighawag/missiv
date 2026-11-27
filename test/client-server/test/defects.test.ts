// One test per defect the S3 review reproduced (missiv work/notes/observations/),
// each written before its fix as an `it.fails` and turned into an `it` by the fix,
// then the tests of what S3b built around them.
import {describe, it, expect, beforeEach} from 'vitest';
import {signRequest} from 'delegated-identity';
import {pushKey, pushMessage, type NewMessageNotification} from '@missiv/server';
import {
	createHarness,
	createUser,
	newKeySet,
	publicOf,
	conversationIDOf,
	DOMAIN,
	APP_ORIGIN,
	UNCHECKED_SIGNATURE,
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
			headers: {'content-type': 'application/json', SIGNATURE: `FAKE:${A.keySet.signing.publicKey}`},
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
					appOrigin: APP_ORIGIN,
					address: user.address,
					keySet: publicOf(user.keySet),
					ownershipSignature: '0x0000000000000000000000000000000000000000000000000000000000000000',
				},
				{privateKey: user.keySet.signing.privateKey},
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

	it('runs db-reset with the admin token', async () => {
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
	it('refuses a send naming another domain', async () => {
		await expect(h.send({from: A, to: B, content: 'cross', domain: 'other.com'})).rejects.toThrow();
	});

	it('refuses a read naming another domain', async () => {
		await expect(h.messages(A, conversationIDOf([A.address, B.address]), 'other.com')).rejects.toThrow();
	});
});

describe('conversations the server keeps honest (send-message-trusts-client-conversation-id)', () => {
	it('refuses a send into a conversation whose members do not include the sender', async () => {
		await h.send({from: A, to: B, content: 'from A'});
		await expect(
			h.send({from: C, to: B, content: 'injected', conversationID: conversationIDOf([A.address, B.address])}),
		).rejects.toThrow();
		expect(await h.contents(B, conversationIDOf([A.address, B.address]))).toEqual(['from A']);
	});

	it('refuses a conversationID that is not its members', async () => {
		await expect(h.send({from: A, to: B, content: 'x', conversationID: 'free-form'})).rejects.toThrow();
	});
});

describe('reject blocks the sender (S3-9)', () => {
	it('a rejected sender reaches the recipient under no conversation', async () => {
		await h.send({from: A, to: B, content: 'spam 1'});
		const [request] = await h.unaccepted(B);
		await h.reject(B, request.conversationID);
		await h.send({from: A, to: [B, C], content: 'spam 2'}).catch(() => {});
		expect(await h.unaccepted(B)).toEqual([]);
	});
});

describe('signed requests are not replayable (signed-requests-are-replayable-and-undomained)', () => {
	it('refuses the same signed send twice', async () => {
		const body = JSON.stringify({
			type: 'sendMessage',
			domain: DOMAIN,
			namespace: 'test',
			conversationID: conversationIDOf([A.address, B.address]),
			lastMessageReadTimestampMS: 0,
			messageType: 'clear',
			messages: [
				{to: A.address, toPublicKey: A.keySet.encryption.publicKey, content: 'once', signature: UNCHECKED_SIGNATURE},
				{to: B.address, toPublicKey: B.keySet.encryption.publicKey, content: 'once', signature: UNCHECKED_SIGNATURE},
			],
		});
		let headers: Record<string, string> | undefined;
		const capture = new (h.api.constructor as any)('http://localhost', {
			fetch: async (url: string, init: RequestInit) => {
				headers = init.headers as Record<string, string>;
				return h.app.request(url, init);
			},
		});
		await capture.sendMessage(JSON.parse(body), {privateKey: A.keySet.signing.privateKey});
		const replay = await h.app.request('http://localhost/api/private/sendMessage', {method: 'POST', headers, body});
		expect(replay.ok).toBe(false);
		expect((await h.messages(B, conversationIDOf([A.address, B.address]))).length).toBe(1);
	});
});

describe('a second key set for the same wallet (re-registering-a-new-key-keeps-the-old-one)', () => {
	it('replaces the first, so the new key set authenticates', async () => {
		const second = newKeySet();
		await h.api.register(
			{
				type: 'register',
				domain: DOMAIN,
				appOrigin: APP_ORIGIN,
				address: A.address,
				keySet: publicOf(second),
				ownershipSignature: await A.signPublication(second),
			},
			{privateKey: second.signing.privateKey},
		);
		await h.api.getConversations(
			{type: 'getConversations', domain: DOMAIN, namespace: 'test'},
			{privateKey: second.signing.privateKey},
		);
	});
});

describe('the request envelope (S3-6)', () => {
	async function signedGetConversations(serverOrigin: string, timestamp?: number) {
		const body = JSON.stringify({type: 'getConversations', domain: DOMAIN, namespace: 'test'});
		const signature = await signRequest(
			{serverOrigin, method: 'POST', path: '/api/private/getConversations', body, timestamp},
			A.keySet.signing.privateKey,
		);
		return h.app.request('http://localhost/api/private/getConversations', {
			method: 'POST',
			headers: {'content-type': 'application/json', SIGNATURE: signature},
			body,
		});
	}

	it('accepts a request signed for this server', async () => {
		expect((await signedGetConversations('http://localhost')).status).toBe(200);
	});

	it('refuses a request signed for another server', async () => {
		expect((await signedGetConversations('https://elsewhere.example')).status).toBe(401);
	});

	it('refuses a request signed more than 60 s ago', async () => {
		expect((await signedGetConversations('http://localhost', Date.now() - 61_000)).status).toBe(401);
	});

	it('refuses a registration whose origin is not the domain', async () => {
		const user = await createUser();
		await expect(
			h.api.register(
				{
					type: 'register',
					domain: DOMAIN,
					appOrigin: 'https://evil.example',
					address: user.address,
					keySet: publicOf(user.keySet),
					ownershipSignature: await user.signPublication(user.keySet, 'https://evil.example'),
				},
				{privateKey: user.keySet.signing.privateKey},
			),
		).rejects.toThrow();
	});
});

describe('conversation checks (S3-8)', () => {
	it('refuses an encrypted copy not encrypted to its recipient encryption key', async () => {
		await expect(
			h.api.sendMessage(
				{
					type: 'sendMessage',
					domain: DOMAIN,
					namespace: 'test',
					conversationID: conversationIDOf([A.address, B.address]),
					lastMessageReadTimestampMS: 0,
					messageType: 'encrypted',
					messages: [
						{to: A.address, toPublicKey: B.keySet.encryption.publicKey, content: 'x', signature: UNCHECKED_SIGNATURE},
						{to: B.address, toPublicKey: C.keySet.encryption.publicKey, content: 'x', signature: UNCHECKED_SIGNATURE},
					],
				},
				{privateKey: A.keySet.signing.privateKey},
			),
		).rejects.toMatchObject({status: 409});
	});

	it("refuses a send without the sender's own copy", async () => {
		await expect(
			h.api.sendMessage(
				{
					type: 'sendMessage',
					domain: DOMAIN,
					namespace: 'test',
					conversationID: conversationIDOf([B.address, C.address]),
					lastMessageReadTimestampMS: 0,
					messageType: 'clear',
					messages: [
						{to: B.address, content: 'x', signature: UNCHECKED_SIGNATURE},
						{to: C.address, content: 'x', signature: UNCHECKED_SIGNATURE},
					],
				},
				{privateKey: A.keySet.signing.privateKey},
			),
		).rejects.toMatchObject({status: 400});
	});

	it('pages messages newest first', async () => {
		for (let i = 0; i < 5; i++) {
			await h.send({from: A, to: B, content: `m${i}`});
		}
		const conversationID = conversationIDOf([A.address, B.address]);
		const first = await h.api.getMessages(
			{type: 'getMessages', domain: DOMAIN, namespace: 'test', conversationID, limit: 2},
			{privateKey: B.keySet.signing.privateKey},
		);
		expect(first.messages.map((m) => m.content)).toEqual(['m4', 'm3']);
		expect(first.cursor).toBeDefined();
		const rest = await h.api.getMessages(
			{type: 'getMessages', domain: DOMAIN, namespace: 'test', conversationID, limit: 10, before: first.cursor},
			{privateKey: B.keySet.signing.privateKey},
		);
		expect(rest.messages.map((m) => m.content)).toEqual(['m2', 'm1', 'm0']);
		expect(rest.cursor).toBeUndefined();
	});

	it('pages conversations by their last message', async () => {
		await h.send({from: A, to: B, content: 'ab'});
		await h.send({from: C, to: B, content: 'cb'});
		const first = await h.api.getConversations(
			{type: 'getConversations', domain: DOMAIN, namespace: 'test', limit: 1},
			{privateKey: B.keySet.signing.privateKey},
		);
		expect(first.conversations.map((c) => c.conversationID)).toEqual([conversationIDOf([B.address, C.address])]);
		const rest = await h.api.getConversations(
			{type: 'getConversations', domain: DOMAIN, namespace: 'test', limit: 1, before: first.cursor},
			{privateKey: B.keySet.signing.privateKey},
		);
		expect(rest.conversations.map((c) => c.conversationID)).toEqual([conversationIDOf([A.address, B.address])]);
		expect(rest.cursor).toBeUndefined();
	});
});

describe('unblock (S3-9)', () => {
	it('lets a blocked sender reach the recipient again', async () => {
		await h.send({from: A, to: B, content: 'first'});
		await h.reject(B, conversationIDOf([A.address, B.address]));
		await h.api.unblock(
			{type: 'unblock', domain: DOMAIN, address: A.address},
			{privateKey: B.keySet.signing.privateKey},
		);
		await h.send({from: A, to: B, content: 'again'});
		expect(await h.contents(B, conversationIDOf([A.address, B.address]))).toContain('again');
	});
});

describe('key replacement (S3-10)', () => {
	it('re-registering the same key set is idempotent and keeps it', async () => {
		await h.register(A, {name: 'alice'});
		const {domainUser} = await h.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: A.address});
		expect(domainUser?.keySet).toEqual(publicOf(A.keySet));
		expect(domainUser?.keyRef).toBe(A.keyRef);
		expect(domainUser?.name).toBe('alice');
	});

	it('the replaced key set no longer authenticates', async () => {
		const second = newKeySet();
		await h.api.register(
			{
				type: 'register',
				domain: DOMAIN,
				appOrigin: APP_ORIGIN,
				address: A.address,
				keySet: publicOf(second),
				ownershipSignature: await A.signPublication(second),
			},
			{privateKey: second.signing.privateKey},
		);
		await expect(
			h.api.getConversations(
				{type: 'getConversations', domain: DOMAIN, namespace: 'test'},
				{privateKey: A.keySet.signing.privateKey},
			),
		).rejects.toMatchObject({status: 401});
	});
});

describe('a push on a new message (S3-2)', () => {
	function recordingNotifier() {
		const notified: NewMessageNotification[] = [];
		return {notified, notifier: {notify: async (n: NewMessageNotification) => void notified.push(n)}};
	}

	it('notifies each recipient once, never the sender, keyed by the message and naming no content', async () => {
		const {notified, notifier} = recordingNotifier();
		const p = createHarness({}, {notifier});
		await p.registerAll([A, B, C]);
		await p.send({from: A, to: [B, C], content: 'secret words'});
		expect(notified.map((n) => n.recipient).sort()).toEqual([B.address, C.address].sort());
		expect(notified.every((n) => n.sender === A.address && n.domain === DOMAIN)).toBe(true);
		const [message] = await p.messages(B, conversationIDOf([A.address, B.address, C.address]));
		expect(notified.map((n) => pushKey(n))).toContain(`missiv:${DOMAIN}:${message.id}:${B.address}`);
		expect(JSON.stringify(notified.map((n) => pushMessage(n)))).not.toContain('secret words');
	});

	it('does not notify a recipient who blocked the sender', async () => {
		const {notified, notifier} = recordingNotifier();
		const p = createHarness({}, {notifier});
		await p.registerAll([A, B]);
		await p.send({from: A, to: B, content: 'first'});
		await p.reject(B, conversationIDOf([A.address, B.address]));
		notified.length = 0;
		await p.send({from: A, to: B, content: 'second'});
		expect(notified).toEqual([]);
	});
});
