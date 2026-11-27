// The live inbox channel (ADR-0006 "Live channel", spec `scalable-direct-messaging`
// stories 19-22) over a real WebSocket: the harness's app served on a loopback
// port with @hono/node-ws, as the Node.js platform serves it, and Node's own
// WebSocket as the client. What is checked is what a socket receives, never
// how the server holds it.
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {
	INBOX_CLOSE_SESSION_EXPIRED,
	INBOX_SESSION_EXPIRED_REASON,
	INBOX_WS_PATH,
	INBOX_WS_PROTOCOL,
	inboxConversationKey,
	type InboxServerFrame,
} from '@missiv/common';
import type {NewMessageNotification, PushNotifier} from '@missiv/server';
import {
	conversationIDOf,
	createHarness,
	createUser,
	mintSessionToken,
	DOMAIN,
	NAMESPACE,
	SESSION_SECRET,
	type Harness,
	type TestUser,
} from './setup.js';

let h: Harness;
let url: string;
let A: TestUser;
let B: TestUser;
let C: TestUser;
let AB: string;
let notified: NewMessageNotification[];

function harness(env: Record<string, string | undefined> = {}) {
	notified = [];
	const notifier: PushNotifier = {
		async notify(notification) {
			notified.push(notification);
		},
	};
	return createHarness(env, {notifier});
}

beforeEach(async () => {
	h = harness();
	url = await h.listen();
	[A, B, C] = await Promise.all([createUser(), createUser(), createUser()]);
	await h.registerAll([A, B, C]);
	AB = conversationIDOf([A.address, B.address]);
});

afterEach(async () => {
	await h.close();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tokenOf(user: TestUser) {
	const {token} = await h.api.openSession({domain: DOMAIN}, {privateKey: user.keySet.signing.privateKey});
	return token;
}

type Socket = {
	ws: WebSocket;
	frames: InboxServerFrame[];
	/** the first frame (from the start, or after `from`) that matches, or a timeout */
	next(predicate: (frame: InboxServerFrame) => boolean, from?: number, timeoutMs?: number): Promise<InboxServerFrame>;
	closed: Promise<{code: number; reason: string}>;
	sync(since: Record<string, number>): void;
};

/** A socket on the live channel with `token`, open (or rejected when the server refuses it). */
function connect(token: string | undefined, protocols?: string[]): Promise<Socket> {
	const ws = new WebSocket(
		url.replace(/^http/, 'ws') + INBOX_WS_PATH,
		protocols ?? (token ? [INBOX_WS_PROTOCOL, token] : [INBOX_WS_PROTOCOL]),
	);
	const frames: InboxServerFrame[] = [];
	const waiters = new Set<() => void>();
	ws.addEventListener('message', (event) => {
		frames.push(JSON.parse(String(event.data)));
		for (const waiter of [...waiters]) waiter();
	});
	const closed = new Promise<{code: number; reason: string}>((resolve) =>
		ws.addEventListener('close', (event) => resolve({code: event.code, reason: event.reason})),
	);
	const socket: Socket = {
		ws,
		frames,
		closed,
		next(predicate, from = 0, timeoutMs = 2000) {
			return new Promise((resolve, reject) => {
				const check = () => {
					const found = frames.slice(from).find(predicate);
					if (found) {
						waiters.delete(check);
						clearTimeout(timer);
						resolve(found);
					}
				};
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`no matching frame within ${timeoutMs} ms: ${JSON.stringify(frames)}`));
				}, timeoutMs);
				waiters.add(check);
				check();
			});
		},
		sync(since) {
			ws.send(JSON.stringify({type: 'sync', since}));
		},
	};
	return new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(socket));
		ws.addEventListener('error', () => reject(new Error('the socket was refused')));
	});
}

const isMessage = (seq: number) => (frame: InboxServerFrame) => frame.type === 'message' && frame.message.seq === seq;
const messagesOf = (frames: InboxServerFrame[]) =>
	frames.flatMap((frame) => (frame.type === 'message' ? [[frame.message.seq, frame.message.content]] : []));

describe('live inbox channel', () => {
	it("pushes a message sent by A to B's open socket and to A's own, with each member's inbox row", async () => {
		const forB = await connect(await tokenOf(B));
		const otherDeviceOfA = await connect(await tokenOf(A));
		const {seq} = await h.send({from: A, to: B, content: 'hello B'});

		const received = await forB.next(isMessage(seq));
		expect(received.type === 'message' && received.message).toMatchObject({
			content: 'hello B',
			sender: A.address,
			conversationID: AB,
			namespace: NAMESPACE,
		});
		const row = await forB.next((frame) => frame.type === 'conversation');
		expect(row.type === 'conversation' && row.conversation).toMatchObject({
			conversationID: AB,
			status: 'unaccepted',
			lastSeq: seq,
			lastReadSeq: 0,
		});
		await otherDeviceOfA.next(isMessage(seq));
		const own = await otherDeviceOfA.next((frame) => frame.type === 'conversation');
		expect(own.type === 'conversation' && own.conversation).toMatchObject({status: 'accepted', lastReadSeq: seq});
		forB.ws.close();
		otherDeviceOfA.ws.close();
	});

	it('pushes nothing to a member of neither the conversation nor the domain', async () => {
		const forC = await connect(await tokenOf(C));
		await h.send({from: A, to: B, content: 'not for C'});
		await wait(100);
		expect(forC.frames).toEqual([]);
		forC.ws.close();
	});

	it('pushes the inbox row to its own sockets after accept and markRead', async () => {
		const {seq} = await h.send({from: A, to: B, content: 'hi'});
		const forB = await connect(await tokenOf(B));
		await h.accept(B, AB);
		await forB.next((frame) => frame.type === 'conversation' && frame.conversation.status === 'accepted');
		await h.markRead(B, AB, seq);
		await forB.next((frame) => frame.type === 'conversation' && frame.conversation.lastReadSeq === seq);
		forB.ws.close();
	});

	it("pushes a blocked sender's message to the sender only, never to the member who blocked them", async () => {
		await h.send({from: A, to: B, content: 'first'});
		await h.reject(B, AB);
		const forB = await connect(await tokenOf(B));
		const forA = await connect(await tokenOf(A));
		const {seq} = await h.send({from: A, to: B, content: 'hidden'});
		await forA.next(isMessage(seq));
		await wait(100);
		expect(messagesOf(forB.frames)).toEqual([]);
		forA.ws.close();
		forB.ws.close();
	});

	describe('sync', () => {
		it('answers exactly the messages after the seq the client holds, its inbox row, then ready', async () => {
			await h.send({from: A, to: B, content: 'one'});
			await h.send({from: B, to: A, content: 'two'});
			await h.send({from: A, to: B, content: 'three'});
			const forB = await connect(await tokenOf(B));
			forB.sync({[inboxConversationKey({namespace: NAMESPACE, conversationID: AB})]: 1});
			await forB.next((frame) => frame.type === 'ready');
			expect(messagesOf(forB.frames)).toEqual([
				[2, 'two'],
				[3, 'three'],
			]);
			expect(forB.frames.map((frame) => frame.type)).toEqual(['message', 'message', 'conversation', 'ready']);
			forB.ws.close();
		});

		it('after a disconnect, delivers what was sent meanwhile, and nothing it already had', async () => {
			const key = inboxConversationKey({namespace: NAMESPACE, conversationID: AB});
			const first = await connect(await tokenOf(B));
			await h.send({from: A, to: B, content: 'while connected'});
			await first.next(isMessage(1));
			first.ws.close();
			await first.closed;

			await h.send({from: A, to: B, content: 'while away 1'});
			await h.send({from: A, to: B, content: 'while away 2'});
			const again = await connect(await tokenOf(B));
			again.sync({[key]: 1});
			await again.next((frame) => frame.type === 'ready');
			expect(messagesOf(again.frames)).toEqual([
				[2, 'while away 1'],
				[3, 'while away 2'],
			]);
			again.ws.close();
		});

		it('pages through a long absence, skips a hidden message, and answers each sync with its own ready', async () => {
			for (let i = 1; i <= 120; i++) {
				await h.send({from: A, to: B, content: `m${i}`});
			}
			const forB = await connect(await tokenOf(B));
			const key = inboxConversationKey({namespace: NAMESPACE, conversationID: AB});
			forB.sync({[key]: 0});
			forB.sync({[key]: 119});
			await forB.next((frame) => frame.type === 'ready');
			const firstReady = forB.frames.findIndex((frame) => frame.type === 'ready');
			await forB.next((frame) => frame.type === 'ready', firstReady + 1);
			const seqs = messagesOf(forB.frames).map(([seq]) => seq);
			expect(seqs).toEqual([...Array.from({length: 120}, (_, i) => i + 1), 120]);
			forB.ws.close();
		});

		it("skips a conversation the account is not a member of, and one in another namespace's key is its own", async () => {
			await h.send({from: A, to: C, content: 'A to C'});
			await h.send({from: A, to: B, content: 'in another namespace', namespace: 'other'});
			const forB = await connect(await tokenOf(B));
			forB.sync({
				[inboxConversationKey({namespace: NAMESPACE, conversationID: conversationIDOf([A.address, C.address])})]: 0,
				[inboxConversationKey({namespace: 'other', conversationID: AB})]: 0,
				[inboxConversationKey({namespace: NAMESPACE, conversationID: AB})]: 0,
				'not a key': 0,
			});
			await forB.next((frame) => frame.type === 'ready');
			expect(messagesOf(forB.frames)).toEqual([[1, 'in another namespace']]);
			forB.ws.close();
		});

		it('closes a socket that sends anything but a sync', async () => {
			const forB = await connect(await tokenOf(B));
			forB.ws.send('{"type":"hello"}');
			expect((await forB.closed).code).toBe(1008);
		});
	});

	describe('authentication', () => {
		it('refuses an upgrade with no token, a forged token or an expired token, before any socket', async () => {
			const upgrade = (protocol?: string) =>
				h.app.request(`http://localhost${INBOX_WS_PATH}`, {
					headers: {
						upgrade: 'websocket',
						...(protocol ? {'sec-websocket-protocol': protocol} : {}),
					},
				});
			const forged = mintSessionToken('another secret', {
				account: B.address,
				domain: DOMAIN,
				keyRef: B.keyRef,
				exp: Date.now() + 60_000,
			});
			const expired = mintSessionToken(SESSION_SECRET, {
				account: B.address,
				domain: DOMAIN,
				keyRef: B.keyRef,
				exp: Date.now() - 1,
			});
			for (const protocol of [
				undefined,
				INBOX_WS_PROTOCOL,
				`${INBOX_WS_PROTOCOL}, ${forged}`,
				`${INBOX_WS_PROTOCOL}, ${expired}`,
			]) {
				const response = await upgrade(protocol);
				expect(response.status).toBe(401);
				expect((await response.json()).error.code).toBe('unauthenticated');
			}
			// and over a real socket: never opened
			await expect(connect(forged)).rejects.toThrow(/refused/);
			await expect(connect(expired)).rejects.toThrow(/refused/);
			await expect(connect(undefined)).rejects.toThrow(/refused/);
			expect(h.liveInbox.size).toBe(0);
		});

		it('selects the missiv-inbox protocol, never echoing the token', async () => {
			const socket = await connect(await tokenOf(B));
			expect(socket.ws.protocol).toBe(INBOX_WS_PROTOCOL);
			socket.ws.close();
		});

		it('closes an open socket with session-expired when its token expires', async () => {
			const token = mintSessionToken(SESSION_SECRET, {
				account: B.address,
				domain: DOMAIN,
				keyRef: B.keyRef,
				exp: Date.now() + 300,
			});
			const socket = await connect(token);
			expect(await socket.closed).toEqual({
				code: INBOX_CLOSE_SESSION_EXPIRED,
				reason: INBOX_SESSION_EXPIRED_REASON,
			});
			await wait(20);
			expect(h.liveInbox.size).toBe(0);
		});
	});

	describe('Web Push', () => {
		it('still pushes an online recipient by default', async () => {
			const forB = await connect(await tokenOf(B));
			await h.send({from: A, to: B, content: 'hi'});
			await forB.next(isMessage(1));
			expect(notified.map((n) => n.recipient)).toEqual([B.address]);
			forB.ws.close();
		});

		it('with PUSH_SKIP_WHEN_ONLINE, pushes no online recipient, and an offline one as before', async () => {
			await h.close();
			h = harness({PUSH_SKIP_WHEN_ONLINE: 'true'});
			url = await h.listen();
			await h.registerAll([A, B]);

			const forB = await connect(await tokenOf(B));
			await h.send({from: A, to: B, content: 'online'});
			await forB.next(isMessage(1));
			await wait(50);
			expect(notified).toEqual([]);
			forB.ws.close();
			await forB.closed;
			await wait(20);

			const {message} = await h.send({from: A, to: B, content: 'offline'});
			await wait(50);
			expect(notified).toEqual([
				{
					domain: DOMAIN,
					namespace: NAMESPACE,
					conversationID: AB,
					messageID: message.messageID,
					sender: A.address,
					recipient: B.address,
					appOrigin: 'https://test.com',
				},
			]);
		});
	});
});
