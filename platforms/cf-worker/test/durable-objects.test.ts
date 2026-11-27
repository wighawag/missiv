// What Cloudflare's Durable Object stores do beyond the store contract
// (`store-contract.test.ts`): the inbox updates retried by alarm, the blocks
// propagated by the blocker's Inbox, and the live sockets held (hibernatable) by
// each user's Inbox object, behind the Worker's `GET /api/inbox/ws`. Failures
// are injected through the objects' seams (`inboxOf`, `conversationOf`), with
// `runInDurableObject` on the live instance.
import {env, runDurableObjectAlarm, runInDurableObject, SELF} from 'cloudflare:test';
import {describe, it, expect, beforeAll} from 'vitest';
import {
	conversationIDOf,
	inboxConversationKey,
	newULID,
	INBOX_CLOSE_SESSION_EXPIRED,
	type Address,
	type InboxServerFrame,
	type MessageToSend,
} from '@missiv/common';
import {migrate, signSessionToken} from '@missiv/server';
import {RemoteD1} from 'remote-sql-d1';
import {
	conversationObject,
	createCloudflareStores,
	inboxObject,
	ServerObjectConversation,
	ServerObjectInbox,
} from '../src/stores/index.js';
import type {CloudflareWorkerEnv} from '../src/env.js';

const DOMAIN = 'objects.test';
const SECRET = 'test-session-secret';
const SIGNATURE = `0x${'11'.repeat(64)}` as `0x${string}`;
const KEY_REF = `0x${'33'.repeat(32)}` as `0x${string}`;
const cfEnv = env as CloudflareWorkerEnv;

let counter = 0;
/** A distinct lowercase address. */
function address(): Address {
	counter++;
	return `0x${counter.toString(16).padStart(8, '0')}${'cd'.repeat(16)}` as Address;
}

function scope(a: Address, b: Address, namespace = 'ns') {
	return {domain: DOMAIN, namespace, conversationID: conversationIDOf([a, b])};
}

function messageOf(from: Address, to: Address, namespace = 'ns', content = 'hello'): MessageToSend {
	return {
		...scope(from, to, namespace),
		messageID: newULID(),
		sender: from,
		senderKeyRef: KEY_REF,
		scheme: 'clear',
		keyID: null,
		content,
		signature: SIGNATURE,
	};
}

function setup() {
	const stores = createCloudflareStores(cfEnv, new Map());
	let now = Date.now();
	async function send(from: Address, to: Address, namespace = 'ns', content = 'hello') {
		const message = messageOf(from, to, namespace, content);
		const result = await stores.conversations.append(message, {sender: from, recipient: to}, ++now);
		if (result.status !== 'appended') {
			throw new Error(`not appended: ${result.status}`);
		}
		return result;
	}
	async function rows(user: Address, namespace = 'ns') {
		const page = await stores.inbox.listConversations(user, {domain: DOMAIN, namespace}, {limit: 100});
		return page.conversations.map((c) => [c.lastSeq, c.lastReadSeq, c.status]);
	}
	return {stores, send, rows};
}

/** The socket a user's client opens on the Worker, its session token at the upgrade, and what arrives on it. */
async function openInbox(user: Address, exp = Date.now() + 60 * 60 * 1000) {
	const token = signSessionToken({account: user, domain: DOMAIN, keyRef: KEY_REF, exp}, SECRET);
	const response = await SELF.fetch('https://missiv.test/api/inbox/ws', {
		headers: {Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `missiv-inbox, ${token}`},
	});
	expect(response.status).toBe(101);
	expect(response.headers.get('Sec-WebSocket-Protocol')).toBe('missiv-inbox');
	const ws = response.webSocket!;
	ws.accept();
	const frames: InboxServerFrame[] = [];
	let closed: {code: number; reason: string} | undefined;
	ws.addEventListener('message', (event) => {
		frames.push(JSON.parse(event.data as string));
	});
	ws.addEventListener('close', (event) => {
		closed = {code: event.code, reason: event.reason};
	});
	return {
		ws,
		frames,
		closed: () => closed,
		/** wait until `test` holds of what arrived (2 s at most) */
		async until(test: () => boolean) {
			for (let i = 0; i < 200 && !test(); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(test()).toBe(true);
		},
	};
}

/** Make a Conversation object's calls to `user`'s Inbox fail while `failing()` holds. */
async function failInboxOf(key: ReturnType<typeof scope>, user: Address, failing: () => boolean) {
	await runInDurableObject(conversationObject(cfEnv, key), (instance: ServerObjectConversation) => {
		const target = instance as unknown as {inboxOf(domain: string, user: Address): unknown};
		const real = target.inboxOf.bind(instance);
		target.inboxOf = (domain: string, member: Address) => {
			const inbox = real(domain, member) as {apply: (...args: unknown[]) => Promise<unknown>};
			if (member !== user) {
				return inbox;
			}
			return new Proxy(inbox, {
				get(stub, property) {
					if (property === 'apply' && failing()) {
						return async () => {
							throw new Error('injected: the Inbox object is unreachable');
						};
					}
					return Reflect.get(stub, property);
				},
			});
		};
	});
}

async function alarmOf(stub: DurableObjectStub) {
	return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

beforeAll(async () => {
	await migrate(new RemoteD1(cfEnv.DB));
});

describe('inbox updates', () => {
	it('retries a failed inbox update by alarm until it is acknowledged; a repeated or reordered one changes nothing', async () => {
		const {stores, send, rows} = setup();
		const [a, b] = [address(), address()];
		const key = scope(a, b);
		let failing = true;
		await failInboxOf(key, b, () => failing);

		// the send succeeds; the sender's row is there, the recipient's is pending
		const first = await send(a, b);
		expect(first.message.seq).toBe(1);
		expect(await rows(a)).toEqual([[1, 1, 'accepted']]);
		expect(await rows(b)).toEqual([]);
		const conversation = conversationObject(cfEnv, key);
		expect(await alarmOf(conversation)).not.toBeNull();

		// still unreachable: the alarm fails again and is set again
		expect(await runDurableObjectAlarm(conversation)).toBe(true);
		expect(await rows(b)).toEqual([]);
		expect(await alarmOf(conversation)).not.toBeNull();

		// reachable again: the alarm delivers, and no alarm is left
		failing = false;
		expect(await runDurableObjectAlarm(conversation)).toBe(true);
		expect(await rows(b)).toEqual([[1, 0, 'unaccepted']]);
		expect(await alarmOf(conversation)).toBeNull();

		// a repeated and a reordered update change nothing
		await send(a, b);
		expect(await rows(b)).toEqual([[2, 0, 'unaccepted']]);
		const update = {...key, user: b, own: false};
		await stores.inbox.update({...update, seq: 1, lastMessageAt: 1});
		await stores.inbox.update({...update, seq: 2, lastMessageAt: 1});
		const [row] = (await stores.inbox.listConversations(b, {domain: DOMAIN, namespace: 'ns'}, {limit: 10}))
			.conversations;
		expect([row.lastSeq, row.lastMessageAt]).toEqual([2, first.message.serverTimestamp + 1]);
		expect(await runDurableObjectAlarm(conversation)).toBe(false);
	});

	it("delivers a member's pending older update before a newer one, so the newer one does not void it", async () => {
		const {send, rows} = setup();
		const [a, b] = [address(), address()];
		const key = scope(a, b);
		let failing = true;
		await failInboxOf(key, a, () => failing);

		// A's own update (which accepts and reads A's row) fails; B's arrives
		await send(a, b);
		expect(await rows(a)).toEqual([]);
		expect(await rows(b)).toEqual([[1, 0, 'unaccepted']]);

		// B answers once A's Inbox is reachable again, before the alarm retried A's update
		failing = false;
		await send(b, a);
		expect(await rows(a)).toEqual([[2, 1, 'accepted']]);
		const conversation = conversationObject(cfEnv, key);
		await runDurableObjectAlarm(conversation);
		expect(await rows(a)).toEqual([[2, 1, 'accepted']]);
		expect(await alarmOf(conversation)).toBeNull();
	});

	it("heals the recipient's list on the client's sync while the update is still failing", async () => {
		const {send, rows} = setup();
		const [a, b] = [address(), address()];
		const key = scope(a, b);
		let failing = true;
		await failInboxOf(key, b, () => failing);
		await send(a, b, 'ns', 'one');
		await send(a, b, 'ns', 'two');
		expect(await rows(b)).toEqual([]);

		const socket = await openInbox(b);
		socket.ws.send(JSON.stringify({type: 'sync', since: {[inboxConversationKey(key)]: 0}}));
		await socket.until(() => socket.frames.some((frame) => frame.type === 'ready'));
		const messages = socket.frames.flatMap((frame) => (frame.type === 'message' ? [frame.message.content] : []));
		expect(messages).toEqual(['one', 'two']);
		const row = socket.frames.find((frame) => frame.type === 'conversation');
		expect(row?.type === 'conversation' && [row.conversation.lastSeq, row.conversation.status]).toEqual([
			2,
			'unaccepted',
		]);
		expect(await rows(b)).toEqual([[2, 0, 'unaccepted']]);

		// the retried updates arrive later and change nothing
		failing = false;
		await runDurableObjectAlarm(conversationObject(cfEnv, key));
		expect(await rows(b)).toEqual([[2, 0, 'unaccepted']]);
		socket.ws.close(1000, 'done');
	});
});

describe('blocks', () => {
	it('a block set in one namespace stops the blocked member in every namespace of the domain, a conversation started after it included', async () => {
		const {stores, send, rows} = setup();
		const [a, b] = [address(), address()];
		await send(a, b, 'one');
		await send(a, b, 'two');
		await stores.inbox.reject(b, scope(a, b, 'one'), a, Date.now());

		for (const namespace of ['one', 'two', 'three']) {
			const after = await send(a, b, namespace, `after the block in ${namespace}`);
			expect(after.hiddenFrom).toBe(b);
			expect(after.pushTo).toEqual([]);
			const forB = await stores.conversations.listMessages(b, scope(a, b, namespace), {limit: 10});
			expect(forB.messages.map((m) => m.content)).not.toContain(`after the block in ${namespace}`);
			const forA = await stores.conversations.listMessages(a, scope(a, b, namespace), {limit: 10});
			expect(forA.messages.map((m) => m.content)).toContain(`after the block in ${namespace}`);
		}
		expect(await rows(b, 'one')).toEqual([[1, 0, 'rejected']]);
		expect(await rows(b, 'two')).toEqual([[1, 0, 'unaccepted']]);
		expect(await rows(b, 'three')).toEqual([]);

		// unblock lifts it everywhere, the conversation started during the block included
		await stores.inbox.unblock(b, DOMAIN, a);
		for (const namespace of ['one', 'two', 'three']) {
			expect((await send(a, b, namespace)).hiddenFrom).toBeUndefined();
		}
	});

	it('hides a message from the blocker whose block has not reached the conversation yet, and retries the propagation by alarm', async () => {
		const {stores, send} = setup();
		const [a, b] = [address(), address()];
		await send(a, b, 'one');
		await send(a, b, 'two');
		// b's Inbox cannot reach the conversation of namespace `two`
		let failing = true;
		const inbox = inboxObject(cfEnv, DOMAIN, b);
		await runInDurableObject(inbox, (instance: ServerObjectInbox) => {
			const target = instance as unknown as {conversationOf(key: ReturnType<typeof scope>): unknown};
			const real = target.conversationOf.bind(instance);
			target.conversationOf = (key) => {
				const stub = real(key) as object;
				return key.namespace === 'two' && failing
					? new Proxy(stub, {
							get(object, property) {
								return property === 'setBlock'
									? async () => {
											throw new Error('injected: the Conversation object is unreachable');
										}
									: Reflect.get(object, property);
							},
						})
					: stub;
			};
		});
		await stores.inbox.reject(b, scope(a, b, 'one'), a, Date.now());
		expect(await alarmOf(inbox)).not.toBeNull();

		// the conversation does not know yet; b's Inbox refuses the update, so it is hidden from b
		const early = await send(a, b, 'two', 'before the propagation');
		expect(early.hiddenFrom).toBe(b);
		const forB = await stores.conversations.listMessages(b, scope(a, b, 'two'), {limit: 10});
		expect(forB.messages.map((m) => m.content)).toEqual(['hello']);

		failing = false;
		expect(await runDurableObjectAlarm(inbox)).toBe(true);
		expect(await alarmOf(inbox)).toBeNull();
		const late = await send(a, b, 'two', 'after the propagation');
		expect(late.hiddenFrom).toBe(b);
	});
});

describe('live sockets', () => {
	it("pushes a new message and its row to the recipient's and the sender's sockets", async () => {
		const {send} = setup();
		const [a, b] = [address(), address()];
		const [forA, forB] = [await openInbox(a), await openInbox(b)];
		const {message} = await send(a, b, 'ns', 'live');
		for (const socket of [forA, forB]) {
			await socket.until(() => socket.frames.some((f) => f.type === 'conversation'));
			expect(socket.frames.find((f) => f.type === 'message')).toEqual({type: 'message', message});
		}
		forA.ws.close(1000, 'done');
		forB.ws.close(1000, 'done');
	});

	it('survives hibernation: a fresh instance answers the socket from the session in its attachment', async () => {
		const {send} = setup();
		const [a, b] = [address(), address()];
		const {message} = await send(a, b, 'ns', 'before');
		const socket = await openInbox(b);
		const inbox = inboxObject(cfEnv, DOMAIN, b);
		expect(await inbox.isOnline({domain: DOMAIN, user: b})).toBe(true);
		await runInDurableObject(inbox, async (_instance, state) => {
			const [ws] = state.getWebSockets();
			expect(ws.deserializeAttachment()).toMatchObject({account: b, domain: DOMAIN});
			// what the runtime does after an eviction: a new instance, then the socket's event
			const awoken = new ServerObjectInbox(state, cfEnv);
			await awoken.webSocketMessage(
				ws,
				JSON.stringify({type: 'sync', since: {[inboxConversationKey(scope(a, b))]: 0}}),
			);
		});
		await socket.until(() => socket.frames.some((f) => f.type === 'ready'));
		expect(socket.frames.find((f) => f.type === 'message')).toEqual({type: 'message', message});
		const row = socket.frames.find((f) => f.type === 'conversation');
		expect(row?.type === 'conversation' && row.conversation.domain).toBe(DOMAIN);
		socket.ws.close(1000, 'done');
	});

	it("closes a socket with session-expired at its token's expiry, by the Inbox object's alarm", async () => {
		const b = address();
		const socket = await openInbox(b, Date.now() + 200);
		const inbox = inboxObject(cfEnv, DOMAIN, b);
		expect(await alarmOf(inbox)).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 250));
		await runDurableObjectAlarm(inbox);
		await socket.until(() => socket.closed() !== undefined);
		expect(socket.closed()).toEqual({code: INBOX_CLOSE_SESSION_EXPIRED, reason: 'session-expired'});
		expect(await inbox.isOnline({domain: DOMAIN, user: b})).toBe(false);
	});

	it('refuses an upgrade without a valid token before any socket is opened', async () => {
		for (const protocol of ['missiv-inbox', 'missiv-inbox, not.a-token']) {
			const response = await SELF.fetch('https://missiv.test/api/inbox/ws', {
				headers: {Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocol},
			});
			expect(response.status).toBe(401);
			expect(((await response.json()) as {error: {code: string}}).error.code).toBe('unauthenticated');
		}
	});
});
