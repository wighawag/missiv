// @missiv/client's stores (S3-14), each driven against the in-process server: the
// registration through app.request, the conversation stores against the same
// app served on a loopback port (their live inbox channel is a real WebSocket),
// the room through fake sockets wired to an in-process room. What is checked is the lifecycle (work only while
// subscribed, for the current account), the counts, and that every server error
// reaches the store.
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {get, writable, type Readable} from 'svelte/store';
import {
	createMissivRegistration,
	openConversationList,
	openOneConversation,
	openRoom,
	type Account,
	type RoomSocket,
} from '@missiv/client';
import {createInProcessRooms} from '@missiv/server';
import {deriveKeySet} from 'delegated-identity';
import {
	accountOf,
	conversationIDOf,
	createHarness,
	createUser,
	mintSessionToken,
	SESSION_SECRET,
	newKeySet,
	DOMAIN,
	APP_ORIGIN,
	NAMESPACE,
	SERVER_URL,
	until,
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server's fetch, counting the calls per route. */
function countingFetch(fail?: (path: string) => boolean) {
	const calls = new Map<string, number>();
	const fetch = (async (input: any, init?: any) => {
		const path = new URL(String(input)).pathname;
		calls.set(path, (calls.get(path) ?? 0) + 1);
		if (fail?.(path)) {
			return new Response(JSON.stringify({error: {code: 'internal', message: 'down for a test'}}), {status: 500});
		}
		return h.app.request(input, init);
	}) as typeof globalThis.fetch;
	return {fetch, count: (path: string) => calls.get(path) ?? 0};
}

function registrationOf(
	account: Readable<Account>,
	fetch: typeof globalThis.fetch = h.app.request as any,
	endpoint: string = SERVER_URL,
) {
	return createMissivRegistration({endpoint, domain: DOMAIN, appOrigin: APP_ORIGIN, account, fetch});
}

/** Keep a store subscribed; returns its unsubscriber. */
const hold = (store: Readable<unknown>) => store.subscribe(() => {});

describe('registration', () => {
	it('is Idle without an account, Unregistered for a new account, Registered once registered', async () => {
		const D = await createUser();
		const account = writable<Account>(undefined);
		const registration = registrationOf(account);
		const stop = hold(registration);
		expect(get(registration).step).toBe('Idle');

		account.set(accountOf(D));
		await until(registration, (r) => r.step === 'Unregistered');
		await registration.register(D.ownershipSignature, {name: 'D'});
		const registered = get(registration);
		expect(registered.step === 'Registered' && registered.user.name).toBe('D');

		account.set(undefined);
		expect(get(registration).step).toBe('Idle');
		stop();
	});

	it("says when the account's registered key set is another one, and registering replaces it", async () => {
		const second = newKeySet();
		const account = writable<Account>(accountOf(A, second));
		const registration = registrationOf(account);
		const stop = hold(registration);
		const state = await until(registration, (r) => r.step === 'Unregistered');
		expect(state.step === 'Unregistered' && state.otherKey).toBe(true);

		await registration.register(await A.signPublication(second));
		expect(get(registration).step).toBe('Registered');
		stop();
	});

	it("registers with the account's saved ownership signature, as connect's account carries it", async () => {
		const D = await createUser();
		const registration = registrationOf(writable<Account>(accountOf(D)));
		const stop = hold(registration);
		await until(registration, (r) => r.step === 'Unregistered');
		await registration.register();
		const registered = get(registration);
		expect(registered.step === 'Registered' && registered.user.keyRef).toBe(D.keyRef);
		stop();
	});

	it('a second device of the account (the same origin key) is Registered with no new registration', async () => {
		const {fetch, count} = countingFetch();
		const device = accountOf({...A, keySet: deriveKeySet(A.originPrivateKey)});
		const registration = registrationOf(writable<Account>(device), fetch);
		const stop = hold(registration);
		const state = await until(registration, (r) => r.step === 'Registered');
		expect(state.step === 'Registered' && state.user.keyRef).toBe(A.keyRef);
		expect(count('/api/user/register')).toBe(0);
		stop();
	});

	it('surfaces a refused registration on the store and to the caller', async () => {
		const D = await createUser();
		const registration = registrationOf(writable<Account>(accountOf(D)));
		const stop = hold(registration);
		await until(registration, (r) => r.step === 'Unregistered');
		await expect(registration.register(A.ownershipSignature)).rejects.toMatchObject({status: 403});
		const state = get(registration);
		expect(state.step === 'Unregistered' && state.error?.code).toBe('forbidden');
		stop();
	});
});

/**
 * The stores of direct messaging against the harness served on a loopback port:
 * their HTTP calls through `fetch` (counted per route), their live inbox
 * channel over a real WebSocket.
 */
async function served(fail?: (path: string) => boolean) {
	const url = await h.listen();
	const calls = new Map<string, number>();
	const bodies = new Map<string, any[]>();
	const fetch = (async (input: any, init?: any) => {
		const path = new URL(String(input)).pathname;
		calls.set(path, (calls.get(path) ?? 0) + 1);
		bodies.set(path, [...(bodies.get(path) ?? []), init?.body ? JSON.parse(init.body) : undefined]);
		if (fail?.(path)) {
			return new Response(JSON.stringify({error: {code: 'internal', message: 'down for a test'}}), {status: 500});
		}
		return globalThis.fetch(input, init);
	}) as typeof globalThis.fetch;
	return {url, fetch, count: (path: string) => calls.get(path) ?? 0, bodies: (path: string) => bodies.get(path) ?? []};
}

describe('conversation list', () => {
	afterEach(() => h.close());

	function listOf(user: TestUser, s: Awaited<ReturnType<typeof served>>) {
		return openConversationList({
			registration: registrationOf(writable<Account>(accountOf(user)), s.fetch, s.url),
			endpoint: s.url,
			domain: DOMAIN,
			namespace: NAMESPACE,
			retryDelayMs: 10,
			fetch: s.fetch,
		});
	}

	it('fetches once, then follows the pushed inbox rows: requests and unread counted apart, no polling', async () => {
		const s = await served();
		const list = listOf(B, s);
		const stop = hold(list);
		let state = await until(list, (l) => l.step === 'Fetched');
		expect(state.step === 'Fetched' && state.conversations).toEqual([]);

		// a request from A (unaccepted), and one from C that B accepts and has read
		await h.send({from: A, to: B, content: 'hi'});
		await h.send({from: C, to: B, content: 'yo'});
		await h.accept(B, conversationIDOf([B.address, C.address]));
		await h.markRead(B, conversationIDOf([B.address, C.address]), 1);
		state = await until(
			list,
			(l) => l.step === 'Fetched' && l.conversations.length === 2 && l.numUnaccepted === 1 && l.numUnread === 0,
		);
		expect(state.step === 'Fetched' && [state.numUnaccepted, state.numUnread]).toEqual([1, 0]);

		// a newer message in the accepted one: unread
		await h.send({from: C, to: B, content: 'again'});
		state = await until(list, (l) => l.step === 'Fetched' && l.numUnread === 1);
		expect(state.step === 'Fetched' && state.conversations.map((c) => c.lastSeq)).toEqual([2, 1]);

		await wait(100);
		expect(s.count('/api/private/listConversations')).toBe(1);
		stop();
		await wait(30);
		expect(h.liveInbox.size).toBe(0);
	});

	it('after a lost socket, reconnects and fetches again what changed while it was away', async () => {
		const s = await served();
		const list = listOf(B, s);
		const stop = hold(list);
		await until(list, (l) => l.step === 'Fetched');
		await until({subscribe: (f: (n: number) => void) => (f(h.liveInbox.size), () => {})}, (n) => n === 1);
		h.dropSockets();
		await h.send({from: A, to: B, content: 'while away'});
		const state = await until(list, (l) => l.step === 'Fetched' && l.conversations.length === 1);
		expect(state.step === 'Fetched' && state.numUnaccepted).toBe(1);
		expect(s.count('/api/private/listConversations')).toBeGreaterThanOrEqual(2);
		stop();
	});
});

describe('conversation', () => {
	afterEach(() => h.close());

	function conversationOf(user: TestUser, other: TestUser, s: Awaited<ReturnType<typeof served>>, extra = {}) {
		return openOneConversation({
			registration: registrationOf(writable<Account>(accountOf(user)), s.fetch, s.url),
			endpoint: s.url,
			domain: DOMAIN,
			namespace: NAMESPACE,
			otherUser: {address: other.address},
			retryDelayMs: 10,
			fetch: s.fetch,
			...extra,
		});
	}

	/** resolves once `n` live sockets are open */
	const sockets = (n: number) =>
		new Promise<void>((resolve, reject) => {
			const started = Date.now();
			const check = () =>
				h.liveInbox.size === n
					? resolve()
					: Date.now() - started > 2000
						? reject(new Error(`${h.liveInbox.size} sockets, not ${n}`))
						: setTimeout(check, 5);
			check();
		});

	it('fetches once, sends, and receives the other side live, with no polling', async () => {
		const s = await served();
		const conversation = conversationOf(A, B, s);
		const stop = hold(conversation);
		await until(conversation, (c) => c.step === 'Fetched' && !!c.otherUser.keySet);
		const forB = conversationOf(B, A, s);
		const stopB = hold(forB);
		await until(forB, (c) => c.step === 'Fetched');
		await sockets(2);

		await conversation.sendMessage('hello B');
		// shown to the sender from the send's answer
		expect(get(conversation).step === 'Fetched' && (get(conversation) as any).messages.length).toBe(1);
		const state = await until(forB, (c) => c.step === 'Fetched' && c.messages.length === 1);
		expect(state.step === 'Fetched' && state.messages[0]).toMatchObject({content: 'hello B', sender: A.address});

		await forB.sendMessage('hello A');
		const both = await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 2);
		expect(both.step === 'Fetched' && both.messages.map((m) => [m.seq, m.content])).toEqual([
			[1, 'hello B'],
			[2, 'hello A'],
		]);
		await wait(100);
		// one newest page each, and no read since
		expect(s.count('/api/private/listMessages')).toBe(2);
		stop();
		stopB();
		await sockets(0);
	});

	it('a conversation closed before its first fetch completed fetches no more and holds no socket', async () => {
		const s = await served();
		const early = conversationOf(A, B, s);
		const stopEarly = hold(early);
		stopEarly();
		await wait(100);
		expect(s.count('/api/private/listMessages')).toBeLessThanOrEqual(1);
		expect(h.liveInbox.size).toBe(0);
	});

	it('accepts once and marks read once per newer message', async () => {
		const s = await served();
		await h.send({from: A, to: B, content: 'one'});
		const conversation = conversationOf(B, A, s, {markAsAcceptedAndRead: true});
		const stop = hold(conversation);
		await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 1);
		await wait(100);
		expect(s.count('/api/private/accept')).toBe(1);
		expect(s.count('/api/private/markRead')).toBe(1);
		const [accepted] = await h.accepted(B);
		expect([accepted.lastSeq, accepted.lastReadSeq]).toEqual([1, 1]);
		await h.send({from: A, to: B, content: 'two'});
		await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 2);
		await wait(100);
		expect([s.count('/api/private/accept'), s.count('/api/private/markRead')]).toEqual([1, 2]);
		stop();
	});

	it('shares one socket with the conversation list, whose unread count follows the marks it makes', async () => {
		const s = await served();
		await h.send({from: A, to: B, content: 'one'});
		await h.accept(B, conversationIDOf([A.address, B.address]));
		const list = openConversationList({
			registration: registrationOf(writable<Account>(accountOf(B)), s.fetch, s.url),
			endpoint: s.url,
			domain: DOMAIN,
			namespace: NAMESPACE,
			fetch: s.fetch,
		});
		const stopList = hold(list);
		await until(list, (l) => l.step === 'Fetched' && l.numUnread === 1);
		const conversation = conversationOf(B, A, s, {markAsAcceptedAndRead: true});
		const stop = hold(conversation);
		await until(list, (l) => l.step === 'Fetched' && l.numUnread === 0);
		expect(h.liveInbox.size).toBe(1);
		stop();
		stopList();
	});

	it('after a lost socket, syncs exactly what it missed: every message once, in seq order', async () => {
		const s = await served();
		await h.send({from: A, to: B, content: 'one'});
		const conversation = conversationOf(B, A, s);
		const stop = hold(conversation);
		await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 1);
		await sockets(1);
		h.dropSockets();
		await sockets(0);
		await h.send({from: A, to: B, content: 'two'});
		await h.send({from: A, to: B, content: 'three'});
		const state = await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 3);
		await wait(100);
		expect(state.step === 'Fetched' && state.messages.map((m) => [m.seq, m.content])).toEqual([
			[1, 'one'],
			[2, 'two'],
			[3, 'three'],
		]);
		const after = get(conversation);
		expect(after.step === 'Fetched' && after.messages.length).toBe(3);
		// the history came by sync, not by a new read
		expect(s.count('/api/private/listMessages')).toBe(1);
		stop();
	});

	it('after a lost socket, still syncs what it missed when it sent a newer message itself meanwhile', async () => {
		const s = await served();
		await h.send({from: A, to: B, content: 'one'});
		// slow to reconnect, so its own send lands while the socket is down
		const conversation = conversationOf(B, A, s, {retryDelayMs: 400});
		const stop = hold(conversation);
		await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 1 && !!c.otherUser.keySet);
		await sockets(1);
		h.dropSockets();
		await sockets(0);
		await h.send({from: A, to: B, content: 'two, missed'});
		await conversation.sendMessage('three, from B');
		// shown from the send's answer, newer than the missed one
		expect((get(conversation) as any).messages.map((m: any) => m.seq)).toEqual([1, 3]);
		const state = await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 3);
		expect(state.step === 'Fetched' && state.messages.map((m) => [m.seq, m.content])).toEqual([
			[1, 'one'],
			[2, 'two, missed'],
			[3, 'three, from B'],
		]);
		stop();
	});

	it('when its session expires, the server closes the socket and the store resumes on a renewed token', async () => {
		const url = await h.listen();
		let sessions = 0;
		// the first session's token runs out in 300 ms (minted with the server's secret),
		// though the server's answer says an hour: only the socket's close tells the client
		const fetch = (async (input: any, init?: any) => {
			const response = await globalThis.fetch(input, init);
			if (!new URL(String(input)).pathname.endsWith('/api/session') || !response.ok) {
				return response;
			}
			sessions++;
			const body = await response.json();
			if (sessions === 1) {
				body.token = mintSessionToken(SESSION_SECRET, {
					account: B.address,
					domain: DOMAIN,
					keyRef: B.keyRef,
					exp: Date.now() + 300,
				});
			}
			return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
		}) as typeof globalThis.fetch;
		const conversation = openOneConversation({
			registration: registrationOf(writable<Account>(accountOf(B)), fetch, url),
			endpoint: url,
			domain: DOMAIN,
			namespace: NAMESPACE,
			otherUser: {address: A.address},
			retryDelayMs: 10,
			fetch,
		});
		const stop = hold(conversation);
		await until(conversation, (c) => c.step === 'Fetched');
		await wait(400);
		await until({subscribe: (f: (n: number) => void) => (f(sessions), () => {})}, (n) => n >= 2);
		await sockets(1);
		await h.send({from: A, to: B, content: 'after the renewal'});
		const state = await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 1);
		expect(state.step === 'Fetched' && state.messages[0].content).toBe('after the renewal');
		stop();
	});

	it('surfaces a failing server and recovers without polling', async () => {
		let down = true;
		const s = await served((path) => down && path === '/api/private/listMessages');
		const conversation = conversationOf(A, B, s);
		const stop = hold(conversation);
		const failed = await until(conversation, (c) => !!c.error);
		expect(failed.error?.code).toBe('internal');
		down = false;
		await until(conversation, (c) => c.step === 'Fetched' && !c.error);
		const reads = s.count('/api/private/listMessages');
		await wait(100);
		expect(s.count('/api/private/listMessages')).toBe(reads);
		stop();
	});

	it('a new account replaces the run: the other account sees its own conversation', async () => {
		const s = await served();
		const account = writable<Account>(accountOf(A));
		const conversation = openOneConversation({
			registration: registrationOf(account, s.fetch, s.url),
			endpoint: s.url,
			domain: DOMAIN,
			namespace: NAMESPACE,
			otherUser: {address: B.address},
			retryDelayMs: 10,
			fetch: s.fetch,
		});
		await h.send({from: C, to: B, content: 'C to B'});
		const stop = hold(conversation);
		let state = await until(conversation, (c) => c.step === 'Fetched');
		expect(state.conversationID).toBe(conversationIDOf([A.address, B.address]));
		account.set(accountOf(C));
		state = await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 1);
		expect(state.step === 'Fetched' && state.messages[0].content).toBe('C to B');
		stop();
	});
});

describe('room', () => {
	type Probe = {sockets: number; open: number; closeAll(): void};

	/** Fake browser sockets, each wired to an in-process room as a platform would wire a real one. */
	function inProcessSockets(): {createWebSocket: (url: string) => RoomSocket; probe: Probe} {
		const rooms = createInProcessRooms({getDB: () => h.db});
		const live = new Set<{close(): void}>();
		const probe: Probe = {
			sockets: 0,
			get open() {
				return live.size;
			},
			closeAll() {
				for (const socket of [...live]) socket.close();
			},
		};
		function createWebSocket(url: string): RoomSocket {
			probe.sockets++;
			const httpURL = url.replace(/^ws/, 'http');
			const room = rooms.getRoom({}, httpURL.split('/').slice(-2)[0]);
			const listeners: Record<string, Array<(event: any) => void>> = {open: [], close: [], message: []};
			const emit = (type: string, event: unknown) => listeners[type].slice().forEach((l) => l(event));
			let closed = false;
			const server = {
				send(data: string) {
					queueMicrotask(() => !closed && emit('message', {data}));
				},
				close() {
					client.close();
				},
			} as unknown as WebSocket;
			const client: RoomSocket = {
				addEventListener: (type, listener) => listeners[type].push(listener),
				removeEventListener: (type, listener) => {
					listeners[type] = listeners[type].filter((l) => l !== listener);
				},
				send(data) {
					if (closed) throw new Error('closed');
					room.webSocketMessage(server, data);
				},
				close() {
					if (closed) return;
					closed = true;
					live.delete(client);
					room.webSocketClose(server, 1000, '', true);
					queueMicrotask(() => emit('close', {}));
				},
			};
			live.add(client);
			queueMicrotask(async () => {
				room.prepareConnection(new Request(httpURL));
				room.addWebSocket(server);
				emit('open', {});
				await room.webSocketOpen(server, {ip: '127.0.0.1'});
			});
			return client;
		}
		return {createWebSocket, probe};
	}

	function roomOf(user: TestUser, createWebSocket: (url: string) => RoomSocket) {
		return openRoom({
			url: `ws://localhost/api/public/room/@${DOMAIN}/ws`,
			registration: registrationOf(writable<Account>(accountOf(user))),
			autoLogin: true,
			createWebSocket,
			reconnectDelayMs: 10,
		});
	}

	it('logs in, sends, and resolves a pending message by its echo', async () => {
		const {createWebSocket} = inProcessSockets();
		const room = roomOf(A, createWebSocket);
		const stop = hold(room);
		await until(room, (r) => r.step === 'Connected' && r.loginStatus === 'LoggedIn');
		await wait(5); // the login's rate-limit tick
		await room.sendMessage('hello room');
		const state = await until(room, (r) => r.step === 'Connected' && r.messages.some((m) => !m.pending));
		if (state.step !== 'Connected') throw new Error('unreachable');
		expect(state.messages.map((m) => [m.from, m.message, !!m.pending])).toEqual([[A.address, 'hello room', false]]);
		stop();
	});

	it("marks a refused message failed with the room's error (rate-limited)", async () => {
		const {createWebSocket} = inProcessSockets();
		const room = roomOf(A, createWebSocket);
		const stop = hold(room);
		await until(room, (r) => r.step === 'Connected' && r.loginStatus === 'LoggedIn');
		await wait(5);
		await room.sendMessage('one');
		await room.sendMessage('two'); // within the limiter's cooldown
		const state = await until(room, (r) => r.step === 'Connected' && r.messages.every((m) => !m.pending));
		if (state.step !== 'Connected') throw new Error('unreachable');
		expect(state.messages.map((m) => [m.message, m.failed?.code])).toEqual([
			['one', undefined],
			['two', 'rate_limited'],
		]);
		expect(state.error?.code).toBe('rate_limited');
		stop();
	});

	it('reconnects a lost socket with a fresh challenge and logs in again', async () => {
		const {createWebSocket, probe} = inProcessSockets();
		const room = roomOf(A, createWebSocket);
		const stop = hold(room);
		const first = await until(room, (r) => r.step === 'Connected' && r.loginStatus === 'LoggedIn');
		const firstSession = first.step === 'Connected' && first.loginStatus === 'LoggedIn' && first.session;
		const before = probe.sockets;
		probe.closeAll();
		await until(room, (r) => r.step === 'Connecting');
		const again = await until(room, (r) => r.step === 'Connected' && r.loginStatus === 'LoggedIn');
		const session = again.step === 'Connected' && again.loginStatus === 'LoggedIn' && again.session;
		expect(session && firstSession && session.challenge !== firstSession.challenge).toBe(true);
		expect(probe.sockets).toBe(before + 1);
		stop();
		await wait(30);
		expect(probe.open).toBe(0);
		expect(probe.sockets).toBe(before + 1); // no reconnection once unsubscribed
	});

	it('without an account, reads the room and logs in no one', async () => {
		const {createWebSocket} = inProcessSockets();
		const room = openRoom({
			url: `ws://localhost/api/public/room/@${DOMAIN}/ws`,
			registration: registrationOf(writable<Account>(undefined)),
			autoLogin: true,
			createWebSocket,
		});
		const stop = hold(room);
		const state = await until(room, (r) => r.step === 'Connected');
		expect(state.step === 'Connected' && state.loginStatus).toBe('NoAccount');
		await expect(room.sendMessage('x')).rejects.toThrow(/not logged in/);
		stop();
	});
});
