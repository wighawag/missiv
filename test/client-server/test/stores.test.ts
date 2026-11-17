// missiv-client's stores (S3-14), each driven against the in-process server: the
// HTTP stores through app.request, the room through fake sockets wired to an
// in-process room. No port. What is checked is the lifecycle (work only while
// subscribed, for the current account), the counts, and that every server error
// reaches the store.
import {describe, it, expect, beforeEach} from 'vitest';
import {get, writable, type Readable} from 'svelte/store';
import {
	createMissivRegistration,
	openConversationList,
	openOneConversation,
	openRoom,
	type Account,
	type RoomSocket,
} from 'missiv-client';
import {createInProcessRooms} from 'missiv-server';
import {
	accountOf,
	conversationIDOf,
	createHarness,
	createUser,
	newDelegateKey,
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

function registrationOf(account: Readable<Account>, fetch: typeof globalThis.fetch = h.app.request as any) {
	return createMissivRegistration({endpoint: SERVER_URL, domain: DOMAIN, appOrigin: APP_ORIGIN, account, fetch});
}

/** Keep a store subscribed; returns its unsubscriber. */
const hold = (store: Readable<unknown>) => store.subscribe(() => {});

describe('registration', () => {
	it('is Idle without a signer, Unregistered for a new account, Registered once registered', async () => {
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

	it("says when the account's registered key is another one, and registering replaces it", async () => {
		const second = newDelegateKey();
		const account = writable<Account>({
			address: A.address,
			signer: {address: A.address, privateKey: toHex(second.privateKey), publicKey: second.publicKey},
		});
		const registration = registrationOf(account);
		const stop = hold(registration);
		const state = await until(registration, (r) => r.step === 'Unregistered');
		expect(state.step === 'Unregistered' && state.otherKey).toBe(true);

		await registration.register(await A.signPublication(second.publicKey));
		expect(get(registration).step).toBe('Registered');
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

describe('conversation list', () => {
	it('polls while subscribed, counts requests and unread apart, and stops on unsubscribe', async () => {
		const {fetch, count} = countingFetch();
		const list = openConversationList({
			registration: registrationOf(writable<Account>(accountOf(B)), fetch),
			endpoint: SERVER_URL,
			domain: DOMAIN,
			namespace: NAMESPACE,
			pollingInterval: 0.02,
			fetch,
		});
		const stop = hold(list);
		let state = await until(list, (l) => l.step === 'Fetched');
		expect(state.step === 'Fetched' && state.conversations).toEqual([]);

		// a request from A (unaccepted), and one from C that B accepts and has read
		await h.send({from: A, to: B, content: 'hi'});
		await h.send({from: C, to: B, content: 'yo'});
		await h.accept(B, conversationIDOf([B.address, C.address]), Date.now());
		state = await until(list, (l) => l.step === 'Fetched' && l.conversations.length === 2);
		expect(state.step === 'Fetched' && [state.numUnaccepted, state.numUnread]).toEqual([1, 0]);

		// a newer message in the accepted one: unread
		await wait(5);
		await h.send({from: C, to: B, content: 'again'});
		state = await until(list, (l) => l.step === 'Fetched' && l.numUnread === 1, 5000);
		expect(state.step === 'Fetched' && state.numUnaccepted).toBe(1);

		stop();
		const after = count('/api/private/getConversations');
		await wait(100);
		expect(count('/api/private/getConversations')).toBeLessThanOrEqual(after + 1);
	});
});

describe('conversation', () => {
	function conversationOf(user: TestUser, other: TestUser, fetch: typeof globalThis.fetch, extra = {}) {
		return openOneConversation({
			registration: registrationOf(writable<Account>(accountOf(user)), fetch),
			endpoint: SERVER_URL,
			domain: DOMAIN,
			namespace: NAMESPACE,
			pollingInterval: 0.02,
			otherUser: {address: other.address},
			fetch,
			...extra,
		});
	}

	it('fetches, sends, shows both sides, and stops polling on unsubscribe, even while fetching', async () => {
		const {fetch, count} = countingFetch();
		const conversation = conversationOf(A, B, fetch);
		const stop = hold(conversation);
		await until(conversation, (c) => c.step === 'Fetched' && !!c.otherUser.publicKey);
		await conversation.sendMessage('hello B');

		const forB = conversationOf(B, A, fetch);
		const stopB = hold(forB);
		const state = await until(forB, (c) => c.step === 'Fetched' && c.messages.length === 1);
		expect(state.step === 'Fetched' && state.messages[0]).toMatchObject({content: 'hello B', sender: A.address});
		stop();
		stopB();

		// a conversation closed before its first fetch completed polls no more
		const early = conversationOf(A, B, fetch);
		const stopEarly = hold(early);
		stopEarly();
		const after = count('/api/private/getMessages');
		await wait(100);
		expect(count('/api/private/getMessages')).toBeLessThanOrEqual(after + 1);
	});

	it('accepts and marks read once per newer message, not on every poll', async () => {
		const {fetch, count} = countingFetch();
		await h.send({from: A, to: B, content: 'one'});
		const conversation = conversationOf(B, A, fetch, {markAsAcceptedAndRead: true});
		const stop = hold(conversation);
		await until(conversation, (c) => c.step === 'Fetched' && c.messages.length === 1);
		await wait(100); // several polls
		expect(count('/api/private/acceptConversation')).toBe(1);
		expect(await h.accepted(B)).toHaveLength(1);
		stop();
	});

	it('surfaces a failing server and goes on polling', async () => {
		let down = true;
		const {fetch} = countingFetch((path) => down && path === '/api/private/getMessages');
		const conversation = conversationOf(A, B, fetch);
		const stop = hold(conversation);
		const failed = await until(conversation, (c) => !!c.error);
		expect(failed.error?.code).toBe('internal');
		down = false;
		await until(conversation, (c) => c.step === 'Fetched');
		stop();
	});

	it('a new account replaces the run: the other account sees its own conversation', async () => {
		const account = writable<Account>(accountOf(A));
		const conversation = openOneConversation({
			registration: registrationOf(account),
			endpoint: SERVER_URL,
			domain: DOMAIN,
			namespace: NAMESPACE,
			pollingInterval: 0.02,
			otherUser: {address: B.address},
			fetch: h.app.request as any,
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

function toHex(arr: Uint8Array): `0x${string}` {
	return `0x${Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
