// The live inbox's switchable transport (`@missiv/common`'s inbox.ts, ADR-0006
// "Amendment: the inbox version and polling"): `POST /api/inbox/changes`
// against the in-process server, and `@missiv/client`'s channel on `poll` and
// `auto` against the same app on a loopback port (the socket a real one). What
// is checked is what a client receives and what the server reads, never how
// the channel schedules itself.
import {describe, it, expect, afterEach} from 'vitest';
import {INBOX_WS_PATH, INBOX_WS_PROTOCOL, type Message, type ResponseInboxChanges} from '@missiv/common';
import {API, MissivAPIError, openInboxChannel, type InboxChannel, type InboxSocket} from '@missiv/client';
import {conversationIDOf, createHarness, createUser, DOMAIN, type Harness, type TestUser} from './setup.js';

let h: Harness | undefined;
const stops: Array<() => void> = [];

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	await h?.close();
	h = undefined;
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(test: () => boolean, timeoutMs = 3000) {
	const start = Date.now();
	while (!test()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`not within ${timeoutMs} ms`);
		}
		await wait(5);
	}
}

async function world(env: Record<string, string | undefined> = {}) {
	h = createHarness(env);
	const [A, B] = await Promise.all([createUser(), createUser()]);
	await h.registerAll([A, B]);
	return {h, A, B, AB: conversationIDOf([A.address, B.address])};
}

const as = (user: TestUser) => ({privateKey: user.keySet.signing.privateKey});

function poll(api: API, user: TestUser, since: number): Promise<ResponseInboxChanges> {
	return api.inboxChanges({type: 'inboxChanges', domain: DOMAIN, since}, as(user));
}

/** `user`'s channel through `api`, listened to: what it passed on, as it arrived. */
function listen(params: {
	api: API;
	endpoint: string;
	user: TestUser;
	transport: 'socket' | 'poll' | 'auto';
	createWebSocket?: (url: string, protocols: string[]) => InboxSocket;
}) {
	const channel: InboxChannel = openInboxChannel({
		endpoint: params.endpoint,
		domain: DOMAIN,
		privateKey: params.user.keySet.signing.privateKey,
		api: params.api,
		transport: params.transport,
		pollIntervalMs: 100,
		reconnectDelayMs: 10,
		socketRetryIntervalMs: 300,
		createWebSocket: params.createWebSocket,
	});
	const messages: Array<{message: Message; at: number}> = [];
	let opens = 0;
	stops.push(
		channel.subscribe({
			onOpen: () => opens++,
			onMessage: (message) => messages.push({message, at: Date.now()}),
		}),
	);
	return {
		channel,
		messages,
		get opens() {
			return opens;
		},
		contents: () => messages.map((m) => m.message.content),
	};
}

describe('POST /api/inbox/changes', () => {
	it("answers an unchanged poll from the process's memory, with no database read, and a changed one from the database", async () => {
		const {h, A, B, AB} = await world();
		const first = await poll(h.api, B, 0);
		expect(first).toEqual({version: 0, unchanged: true});

		await h.send({from: A, to: B, content: 'one'});
		const read = h.queries.length;
		const changed = await poll(h.api, B, first.version);
		expect(h.queries.length).toBeGreaterThan(read);
		expect('unchanged' in changed).toBe(false);
		if ('unchanged' in changed) return;
		expect(changed.conversations.map((c) => [c.conversationID, c.lastSeq])).toEqual([[AB, 1]]);

		// unchanged, at the answered version: no statement prepared
		const before = h.queries.length;
		for (let i = 0; i < 5; i++) {
			expect(await poll(h.api, B, changed.version)).toEqual({version: changed.version, unchanged: true});
		}
		expect(h.queries.length).toBe(before);

		// every write forgets it: the next poll reads, and finds the change
		await h.markRead(B, AB, 1);
		const afterMark = h.queries.length;
		const marked = await poll(h.api, B, changed.version);
		expect(h.queries.length).toBeGreaterThan(afterMark);
		expect('unchanged' in marked || marked.conversations.map((c) => c.lastReadSeq)).toEqual([1]);
	});

	it('with polling alone (several instances, INBOX_TRANSPORTS=poll), reads its version from the database on every poll', async () => {
		const {h, A, B} = await world({INBOX_TRANSPORTS: 'poll'});
		await h.send({from: A, to: B});
		const {version} = await poll(h.api, B, 0);
		const before = h.queries.length;
		expect(await poll(h.api, B, version)).toEqual({version, unchanged: true});
		// one indexed read of the version, no row read
		expect(h.queries.slice(before)).toHaveLength(1);
	});

	it('is refused without a session, 404 where polling is off, and a malformed INBOX_TRANSPORTS fails the request', async () => {
		const {h, B} = await world({INBOX_TRANSPORTS: 'socket'});
		await expect(poll(h.api, B, 0)).rejects.toMatchObject({status: 404, code: 'not_found'});
		const anonymous = await h.app.request('http://localhost/api/inbox/changes', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({type: 'inboxChanges', domain: DOMAIN, since: 0}),
		});
		expect(anonymous.status).toBe(404);

		const on = await world();
		const unauthenticated = await on.h.app.request('http://localhost/api/inbox/changes', {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({type: 'inboxChanges', domain: DOMAIN, since: 0}),
		});
		expect(unauthenticated.status).toBe(401);
		await on.h.close();

		const typo = await world({INBOX_TRANSPORTS: 'sockets'});
		const error = await poll(typo.h.api, typo.B, 0).catch((err) => err);
		expect(error).toBeInstanceOf(MissivAPIError);
		expect(error.status).toBe(500);
	});
});

describe("the client's transports", () => {
	it('poll: a message sent to the client reaches it within one interval', async () => {
		const {h, A, B, AB} = await world();
		const url = await h.listen();
		const forB = listen({api: new API(url), endpoint: url, user: B, transport: 'poll'});
		await eventually(() => forB.opens === 1);
		expect(forB.channel.transport).toBe('poll');
		const sentAt = Date.now();
		await h.send({from: A, to: B, content: 'polled'});
		await eventually(() => forB.contents().includes('polled'));
		const [arrived] = forB.messages;
		expect(arrived.message).toMatchObject({conversationID: AB, seq: 1, sender: A.address});
		// the poll interval (100 ms), with room for the reads
		expect(arrived.at - sentAt).toBeLessThan(100 + 150);
	});

	it('auto: a socket that cannot open falls back to polling, and the socket takes over again when it can', async () => {
		const {h, A, B} = await world();
		const url = await h.listen();
		let blocked = true;
		let refused = 0;
		/** a socket the network refuses while `blocked`, a real one after */
		const createWebSocket = (socketURL: string, protocols: string[]): InboxSocket => {
			if (!blocked) {
				return new WebSocket(socketURL, protocols) as unknown as InboxSocket;
			}
			refused++;
			const listeners: Array<(event: unknown) => void> = [];
			setTimeout(() => listeners.forEach((listener) => listener({code: 1006})), 1);
			return {
				send() {},
				close() {},
				addEventListener(type, listener) {
					if (type === 'close') listeners.push(listener);
				},
			};
		};
		const forB = listen({api: new API(url), endpoint: url, user: B, transport: 'auto', createWebSocket});
		await eventually(() => forB.channel.transport === 'poll' && forB.channel.connected);
		expect(refused).toBe(3);
		await h.send({from: A, to: B, content: 'while polling'});
		await eventually(() => forB.contents().includes('while polling'));

		blocked = false;
		await eventually(() => forB.channel.transport === 'socket');
		expect(h.liveInbox.size).toBe(1);
		// on the socket now: the next message is pushed
		await h.send({from: A, to: B, content: 'on the socket'});
		await eventually(() => forB.contents().includes('on the socket'));
	});

	it('with INBOX_TRANSPORTS=poll the socket route is off (404), and a client in auto works by polling', async () => {
		const {h, A, B} = await world({INBOX_TRANSPORTS: 'poll'});
		const url = await h.listen();
		const {token} = await h.api.openSession({domain: DOMAIN}, as(B));
		const upgrade = await h.app.request(`http://localhost${INBOX_WS_PATH}`, {
			headers: {Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${INBOX_WS_PROTOCOL}, ${token}`},
		});
		expect(upgrade.status).toBe(404);
		const refusedSocket = await new Promise<string>((resolve) => {
			const ws = new WebSocket(url.replace(/^http/, 'ws') + INBOX_WS_PATH, [INBOX_WS_PROTOCOL, token]);
			ws.addEventListener('open', () => resolve('open'));
			ws.addEventListener('error', () => resolve('refused'));
		});
		expect(refusedSocket).toBe('refused');

		// the default WebSocket, as a browser's
		const forB = listen({api: new API(url), endpoint: url, user: B, transport: 'auto'});
		await eventually(() => forB.channel.transport === 'poll' && forB.channel.connected);
		await h.send({from: A, to: B, content: 'by polling'});
		await eventually(() => forB.contents().includes('by polling'));
		expect(h.liveInbox.size).toBe(0);
	});
});
