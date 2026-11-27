// The Bun platform booted as its CLI boots it (`createBunServer` on bun:sqlite,
// served by Bun.serve on a free port) and driven over real HTTP with the 0.6
// messaging API, with the client-server tests' users and actions. The Bun
// platform once went unrun for a release (observation
// `bun-and-cf-worker-platforms-not-run-since-0-4`): this runs it.
import {afterAll, beforeAll, describe, expect, it} from 'bun:test';
import {createBunServer} from '../src/server.js';
import {INBOX_WS_PATH, INBOX_WS_PROTOCOL, type InboxServerFrame} from '@missiv/common';
import {
	conversationIDOf,
	createRemoteActions,
	createUser,
	type TestUser,
} from '../../../test/client-server/test/setup.js';

let server: ReturnType<typeof Bun.serve>;
let actions: ReturnType<typeof createRemoteActions>;

beforeAll(async () => {
	const {app, websocket} = await createBunServer({
		db: ':memory:',
		env: {DB: ':memory:', SESSION_SECRET: 'test-secret'},
	});
	server = Bun.serve({port: 0, fetch: app.fetch, websocket});
	actions = createRemoteActions(`http://127.0.0.1:${server.port}`);
});

afterAll(() => {
	server.stop(true);
});

describe('bun platform', () => {
	it('boots on a fresh database and serves the 0.6 messaging API', async () => {
		const [a, b]: TestUser[] = await Promise.all([createUser(), createUser()]);
		await actions.registerAll([a, b]);
		const conversationID = conversationIDOf([a.address, b.address]);

		const first = await actions.send({from: a, to: b, content: 'hello', scheme: 'pairwise-v1'});
		expect(first.seq).toBe(1);
		// a retry answers the stored seq, in one bun:sqlite transaction
		expect(await actions.sendMessage(a, first.message)).toEqual({seq: 1, serverTimestamp: first.serverTimestamp});
		await actions.send({from: b, to: a, content: 'hi'});

		expect((await actions.messages(b, conversationID, {after: 1})).map((m) => [m.seq, m.content])).toEqual([[2, 'hi']]);
		const [forB] = await actions.conversations(b);
		expect([forB.status, forB.lastSeq, forB.lastReadSeq]).toEqual(['accepted', 2, 2]);
		const [forA] = await actions.conversations(a);
		expect([forA.status, forA.lastSeq, forA.lastReadSeq]).toEqual(['accepted', 2, 1]);
	});

	it("serves the live inbox channel: a message reaches the recipient's open socket, a bad token is refused", async () => {
		const [a, b]: TestUser[] = await Promise.all([createUser(), createUser()]);
		await actions.registerAll([a, b]);
		const wsURL = `ws://127.0.0.1:${server.port}${INBOX_WS_PATH}`;

		const refused = new WebSocket(wsURL, [INBOX_WS_PROTOCOL, 'not.a-token']);
		const refusedOutcome = await new Promise<string>((resolve) => {
			refused.addEventListener('open', () => resolve('open'));
			refused.addEventListener('error', () => resolve('refused'));
			refused.addEventListener('close', () => resolve('refused'));
		});
		expect(refusedOutcome).toBe('refused');

		const {token} = await actions.api.getSession('test.com', {privateKey: b.keySet.signing.privateKey});
		const ws = new WebSocket(wsURL, [INBOX_WS_PROTOCOL, token]);
		const frames: InboxServerFrame[] = [];
		const received = new Promise<void>((resolve) =>
			ws.addEventListener('message', (event) => {
				frames.push(JSON.parse(String(event.data)));
				if (frames.some((frame) => frame.type === 'conversation')) resolve();
			}),
		);
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve);
			ws.addEventListener('error', reject);
		});
		expect(ws.protocol).toBe(INBOX_WS_PROTOCOL);
		await actions.send({from: a, to: b, content: 'live on bun'});
		await received;
		expect(frames.map((frame) => frame.type)).toEqual(['message', 'conversation']);
		expect(frames[0].type === 'message' && frames[0].message.content).toBe('live on bun');
		ws.close();
	});

	it('answers its root', async () => {
		expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe('missiv');
	});
});
