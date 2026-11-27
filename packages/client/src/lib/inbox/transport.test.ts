// The live inbox channel's transports (`@missiv/common`'s inbox.ts) on a fake
// clock, fake sockets and a fake API: polling passes on what changed and the
// messages it lacks, `auto` falls back to polling after the socket kept
// failing and returns to it when one opens, and a server that does not poll
// sends `auto` back to the socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	inboxConversationKey,
	type Conversation,
	type Message,
	type ResponseInboxChanges
} from '@missiv/common';
import { MissivAPIError, type API } from '$lib/API.js';
import { openInboxChannel, type InboxSocket } from './index.js';

type FakeSocket = InboxSocket & {
	sent: string[];
	closed?: { code?: number; reason?: string };
	emit(type: 'open' | 'close' | 'message', event?: unknown): void;
};

function fakeSockets() {
	const sockets: FakeSocket[] = [];
	function createWebSocket(): InboxSocket {
		const listeners = new Map<string, Array<(event: any) => void>>();
		const socket: FakeSocket = {
			sent: [],
			send(data) {
				socket.sent.push(data);
			},
			close(code, reason) {
				socket.closed = { code, reason };
			},
			addEventListener(type, listener) {
				listeners.set(type, [...(listeners.get(type) ?? []), listener]);
			},
			emit(type, event = {}) {
				for (const listener of listeners.get(type) ?? []) listener(event);
			}
		};
		sockets.push(socket);
		return socket;
	}
	return { sockets, createWebSocket };
}

const NAMESPACE = 'ns';
const CONVERSATION = `0x${'aa'.repeat(20)}`;

function rowOf(domain: string, lastSeq: number, version: number): Conversation {
	return {
		domain,
		namespace: NAMESPACE,
		conversationID: CONVERSATION,
		members: [],
		status: 'accepted',
		lastSeq,
		lastReadSeq: 0,
		lastMessageAt: lastSeq,
		version
	};
}

function messageOf(domain: string, seq: number): Message {
	return {
		domain,
		namespace: NAMESPACE,
		conversationID: CONVERSATION,
		seq,
		content: `m${seq}`
	} as unknown as Message;
}

/** A server's inbox as the fake API answers it: its rows (one conversation) and messages. */
function fakeServer(domain: string) {
	const state = { version: 0, lastSeq: 0, polls: 0, reads: [] as number[], refusePoll: 0 };
	const api = {
		getSession: async () => ({ token: 'a.token' }),
		async inboxChanges(action: { since: number }): Promise<ResponseInboxChanges> {
			state.polls++;
			if (state.refusePoll) {
				throw new MissivAPIError(state.refusePoll, 'not_found', 'no polling here');
			}
			if (action.since === state.version) return { version: state.version, unchanged: true };
			return {
				version: state.version,
				conversations: [rowOf(domain, state.lastSeq, state.version)],
				hasMore: false
			};
		},
		async listMessages(action: { after: number }) {
			state.reads.push(action.after);
			const messages = [];
			for (let seq = action.after + 1; seq <= state.lastSeq; seq++)
				messages.push(messageOf(domain, seq));
			return { messages, hasMore: false };
		}
	} as unknown as API;
	return {
		state,
		api,
		/** a new message in the conversation */
		send() {
			state.lastSeq++;
			state.version++;
		}
	};
}

let counter = 0;
function setup(options: { transport: 'socket' | 'poll' | 'auto'; pollIntervalMs?: number }) {
	const domain = `transport-${++counter}.test`;
	const server = fakeServer(domain);
	const { sockets, createWebSocket } = fakeSockets();
	const channel = openInboxChannel({
		endpoint: 'http://localhost',
		domain,
		privateKey: `0x${'11'.repeat(32)}`,
		api: server.api,
		createWebSocket,
		reconnectDelayMs: 1000,
		transport: options.transport,
		pollIntervalMs: options.pollIntervalMs ?? 5000,
		socketRetryIntervalMs: 60_000
	});
	const seen = { opens: 0, messages: [] as number[], rows: [] as number[], errors: 0 };
	const unsubscribe = channel.subscribe({
		onOpen: () => seen.opens++,
		onMessage: (message) => seen.messages.push(message.seq),
		onConversation: (conversation) => seen.rows.push(conversation.lastSeq),
		onError: () => seen.errors++
	});
	return { domain, server, sockets, channel, seen, unsubscribe };
}

describe("the live inbox channel's transports", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('poll: learns the inbox first, then passes on each change and its messages within one interval', async () => {
		const { server, sockets, channel, seen, unsubscribe } = setup({ transport: 'poll' });
		server.send();
		await vi.advanceTimersByTimeAsync(0);
		expect(sockets).toHaveLength(0);
		expect(channel.transport).toBe('poll');
		expect(channel.connected).toBe(true);
		expect(seen.opens).toBe(1);
		// the first look learns the row, reads no message (the stores fetch on onOpen)
		expect(seen.rows).toEqual([1]);
		expect(seen.messages).toEqual([]);

		// an unchanged poll every interval, nothing passed on
		await vi.advanceTimersByTimeAsync(5000 * 3);
		expect(server.state.polls).toBe(4);
		expect(seen.rows).toEqual([1]);

		server.send();
		server.send();
		await vi.advanceTimersByTimeAsync(5000);
		expect(seen.rows).toEqual([1, 3]);
		expect(seen.messages).toEqual([2, 3]);
		expect(server.state.reads).toEqual([1]);

		// a store's sync while polling reads over HTTP, and resolves once read
		await channel.sync({
			[inboxConversationKey({ namespace: NAMESPACE, conversationID: CONVERSATION })]: 1
		});
		expect(seen.messages).toEqual([2, 3, 2, 3]);
		unsubscribe();
		await vi.advanceTimersByTimeAsync(5000 * 2);
		expect(server.state.polls).toBe(5);
	});

	it('poll: a failed poll is reported and retried with backoff, then opens again', async () => {
		const { server, channel, seen, unsubscribe } = setup({ transport: 'poll' });
		server.state.refusePoll = 500;
		await vi.advanceTimersByTimeAsync(0);
		expect(channel.connected).toBe(false);
		expect(seen.errors).toBe(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(seen.errors).toBe(2);
		server.state.refusePoll = 0;
		await vi.advanceTimersByTimeAsync(2000);
		expect(channel.connected).toBe(true);
		expect(seen.opens).toBe(1);
		unsubscribe();
	});

	it('auto: polls after three sockets in a row could not open, and returns to the socket when one opens', async () => {
		const { server, sockets, channel, seen, unsubscribe } = setup({ transport: 'auto' });
		await vi.advanceTimersByTimeAsync(0);
		expect(channel.transport).toBe('socket');
		// three refused sockets, with the reconnection's backoff between them
		sockets[0].emit('close', { code: 1006 });
		await vi.advanceTimersByTimeAsync(1000);
		sockets[1].emit('close', { code: 1006 });
		await vi.advanceTimersByTimeAsync(2000);
		expect(sockets).toHaveLength(3);
		expect(server.state.polls).toBe(0);
		sockets[2].emit('close', { code: 1006 });
		await vi.advanceTimersByTimeAsync(0);
		expect(channel.transport).toBe('poll');
		expect(channel.connected).toBe(true);
		expect(seen.opens).toBe(1);

		// polling delivers
		server.send();
		await vi.advanceTimersByTimeAsync(5000);
		expect(seen.rows).toEqual([1]);

		// a socket is tried again after the retry interval; refused, polling goes on
		await vi.advanceTimersByTimeAsync(60_000 - 5000);
		expect(sockets).toHaveLength(4);
		sockets[3].emit('close', { code: 1006 });
		expect(channel.transport).toBe('poll');
		expect(channel.connected).toBe(true);
		const errors = seen.errors;
		// the next one opens: the socket takes over, the listeners sync on it
		await vi.advanceTimersByTimeAsync(60_000);
		expect(sockets).toHaveLength(5);
		sockets[4].emit('open');
		expect(channel.transport).toBe('socket');
		expect(seen.opens).toBe(2);
		expect(seen.errors).toBe(errors);
		const polls = server.state.polls;
		await vi.advanceTimersByTimeAsync(5000 * 4);
		expect(server.state.polls).toBe(polls);
		void channel.sync({ conversation: 1 });
		expect(sockets[4].sent).toEqual([JSON.stringify({ type: 'sync', since: { conversation: 1 } })]);
		unsubscribe();
	});

	it('auto: a socket the server answered resets the count, and a refused poll (404) sends it back to the socket', async () => {
		const { server, sockets, channel, unsubscribe } = setup({ transport: 'auto' });
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].emit('close', { code: 1006 });
		await vi.advanceTimersByTimeAsync(1000);
		sockets[1].emit('open');
		sockets[1].emit('message', { data: JSON.stringify({ type: 'ready' }) });
		sockets[1].emit('close', { code: 1006 });
		await vi.advanceTimersByTimeAsync(1000);
		sockets[2].emit('close', { code: 1006 });
		await vi.advanceTimersByTimeAsync(2000);
		// two failures in a row since the answer: still on the socket
		expect(channel.transport).toBe('socket');
		expect(sockets).toHaveLength(4);
		server.state.refusePoll = 404;
		sockets[3].emit('close', { code: 1006 });
		await vi.advanceTimersByTimeAsync(10);
		// the third: polling, which this server refuses, so back to the socket
		expect(server.state.polls).toBe(1);
		expect(channel.transport).toBe('socket');
		expect(sockets).toHaveLength(5);
		unsubscribe();
	});

	it('socket: never polls, however often the socket fails', async () => {
		const { server, sockets, channel, unsubscribe } = setup({ transport: 'socket' });
		await vi.advanceTimersByTimeAsync(0);
		for (let i = 0; i < 5; i++) {
			sockets[i].emit('close', { code: 1006 });
			await vi.advanceTimersByTimeAsync(30_000);
		}
		expect(sockets).toHaveLength(6);
		expect(server.state.polls).toBe(0);
		expect(channel.transport).toBe('socket');
		unsubscribe();
	});

	it('takes the version of the rows the socket passes on, so a switch to polling keeps its position', async () => {
		const { domain, server, sockets, channel, seen, unsubscribe } = setup({ transport: 'auto' });
		server.send();
		server.send();
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].emit('open');
		sockets[0].emit('message', {
			data: JSON.stringify({ type: 'message', message: messageOf(domain, 2) })
		});
		sockets[0].emit('message', {
			data: JSON.stringify({ type: 'conversation', conversation: rowOf(domain, 2, 2) })
		});
		for (let i = 0; i < 3; i++) {
			sockets[i].emit('close', { code: 1006 });
			await vi.advanceTimersByTimeAsync(4000);
		}
		expect(channel.transport).toBe('poll');
		// polling from version 2: unchanged, nothing passed on again
		expect(seen.rows).toEqual([2]);
		server.send();
		await vi.advanceTimersByTimeAsync(5000);
		expect(seen.rows).toEqual([2, 3]);
		expect(seen.messages).toEqual([2, 3]);
		expect(server.state.reads).toEqual([2]);
		unsubscribe();
	});
});
