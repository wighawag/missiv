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
		const response = await h.app.request('http://localhost/api/private/listConversations', {
			method: 'POST',
			headers: {'content-type': 'application/json', SIGNATURE: `FAKE:${A.keySet.signing.publicKey}`},
			body: JSON.stringify({type: 'listConversations', domain: DOMAIN, namespace: 'test'}),
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
		await expect(h.messages(A, conversationIDOf([A.address, B.address]), {domain: 'other.com'})).rejects.toThrow();
	});
});

describe('conversations the server keeps honest (send-message-trusts-client-conversation-id)', () => {
	it('refuses a send into a conversation whose members do not include the sender', async () => {
		await h.send({from: A, to: B, content: 'from A'});
		const injected = await h.compose({from: C, to: B, content: 'injected'});
		await expect(
			h.sendMessage(C, {...injected, conversationID: conversationIDOf([A.address, B.address])}),
		).rejects.toMatchObject({status: 403});
		expect(await h.contents(B, conversationIDOf([A.address, B.address]))).toEqual(['from A']);
	});

	it('refuses a conversationID that is not its members', async () => {
		const message = await h.compose({from: A, to: B, content: 'x'});
		await expect(h.sendMessage(A, {...message, conversationID: 'free-form'})).rejects.toMatchObject({status: 400});
	});
});

describe('reject blocks the sender (S3-9)', () => {
	it('a rejected sender reaches the recipient under no conversation', async () => {
		await h.send({from: A, to: B, content: 'spam 1'});
		const [request] = await h.unaccepted(B);
		await h.reject(B, request.conversationID);
		await h.send({from: A, to: B, content: 'spam 2'});
		expect(await h.unaccepted(B)).toEqual([]);
		expect(await h.contents(B, request.conversationID)).toEqual(['spam 1']);
	});
});

describe('a send is not replayable (signed-requests-are-replayable-and-undomained)', () => {
	it('answers the same send twice with the stored seq, storing it once', async () => {
		const message = await h.compose({from: A, to: B, content: 'once'});
		const first = await h.sendMessage(A, message);
		const replay = await h.sendMessage(A, message);
		expect(replay).toEqual(first);
		expect(await h.contents(B, message.conversationID)).toEqual(['once']);
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
		await h.api.listConversations(
			{type: 'listConversations', domain: DOMAIN, namespace: 'test'},
			{privateKey: second.signing.privateKey},
		);
	});
});

describe('the request envelope (S3-6)', () => {
	// a signed request opens a session (the routes after it take its token)
	async function signedOpenSession(serverOrigin: string, timestamp?: number) {
		const body = JSON.stringify({domain: DOMAIN});
		const signature = await signRequest(
			{serverOrigin, method: 'POST', path: '/api/session', body, timestamp},
			A.keySet.signing.privateKey,
		);
		return h.app.request('http://localhost/api/session', {
			method: 'POST',
			headers: {'content-type': 'application/json', SIGNATURE: signature},
			body,
		});
	}

	it('accepts a request signed for this server', async () => {
		expect((await signedOpenSession('http://localhost')).status).toBe(200);
	});

	it('refuses a request signed for another server', async () => {
		expect((await signedOpenSession('https://elsewhere.example')).status).toBe(401);
	});

	it('refuses a request signed more than 60 s ago', async () => {
		expect((await signedOpenSession('http://localhost', Date.now() - 61_000)).status).toBe(401);
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
	it("refuses a pairwise-v1 message whose keyID does not name the sender's key set", async () => {
		const message = await h.compose({from: A, to: B, scheme: 'pairwise-v1'});
		const keyID = [B.keyRef, C.keyRef].sort().join(':');
		await expect(h.sendMessage(A, {...message, keyID})).rejects.toMatchObject({status: 400});
	});

	it('pages messages by seq: the newest page, then back with before', async () => {
		for (let i = 0; i < 5; i++) {
			await h.send({from: A, to: B, content: `m${i}`});
		}
		const conversationID = conversationIDOf([A.address, B.address]);
		const first = await h.api.listMessages(
			{type: 'listMessages', domain: DOMAIN, namespace: 'test', conversationID, limit: 2},
			{privateKey: B.keySet.signing.privateKey},
		);
		expect(first.messages.map((m) => m.content)).toEqual(['m3', 'm4']);
		expect(first.hasMore).toBe(true);
		const rest = await h.api.listMessages(
			{
				type: 'listMessages',
				domain: DOMAIN,
				namespace: 'test',
				conversationID,
				limit: 10,
				before: first.messages[0].seq,
			},
			{privateKey: B.keySet.signing.privateKey},
		);
		expect(rest.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
		expect(rest.hasMore).toBe(false);
	});

	it('pages conversations by their last message', async () => {
		await h.send({from: A, to: B, content: 'ab'});
		await h.send({from: C, to: B, content: 'cb'});
		const first = await h.api.listConversations(
			{type: 'listConversations', domain: DOMAIN, namespace: 'test', limit: 1},
			{privateKey: B.keySet.signing.privateKey},
		);
		expect(first.conversations.map((c) => c.conversationID)).toEqual([conversationIDOf([B.address, C.address])]);
		const rest = await h.api.listConversations(
			{type: 'listConversations', domain: DOMAIN, namespace: 'test', limit: 1, before: first.cursor},
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
		await h.send({from: A, to: B, content: 'while blocked'});
		await h.api.unblock(
			{type: 'unblock', domain: DOMAIN, address: A.address},
			{privateKey: B.keySet.signing.privateKey},
		);
		await h.send({from: A, to: B, content: 'again'});
		expect(await h.contents(B, conversationIDOf([A.address, B.address]))).toEqual(['first', 'again']);
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
			h.api.listConversations(
				{type: 'listConversations', domain: DOMAIN, namespace: 'test'},
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

	it('notifies the recipient once, never the sender, keyed by the message and naming no content', async () => {
		const {notified, notifier} = recordingNotifier();
		const p = createHarness({}, {notifier});
		await p.registerAll([A, B, C]);
		const {message} = await p.send({from: A, to: B, content: 'secret words'});
		await p.sendMessage(A, message); // a retry is not pushed again
		expect(notified.map((n) => n.recipient)).toEqual([B.address]);
		expect(notified.every((n) => n.sender === A.address && n.domain === DOMAIN)).toBe(true);
		expect(notified[0].appOrigin).toBe(APP_ORIGIN);
		expect(notified.map((n) => pushKey(n))).toEqual([`missiv:${DOMAIN}:${message.messageID}:${B.address}`]);
		expect(JSON.stringify(notified.map((n) => pushMessage(n)))).not.toContain('secret words');
	});

	it('does not notify a recipient who is not registered', async () => {
		const {notified, notifier} = recordingNotifier();
		const p = createHarness({}, {notifier});
		const unregistered = await createUser();
		await p.registerAll([A]);
		await p.send({from: A, to: unregistered, content: 'hello'});
		expect(notified).toEqual([]);
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
