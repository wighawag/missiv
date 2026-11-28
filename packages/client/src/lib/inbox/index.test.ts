// The live inbox channel's heartbeat (`@missiv/common`'s heartbeat.ts) on a fake
// clock and fake sockets: a socket whose `pong` never comes is given up and
// replaced, one that answers stays.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	HEARTBEAT_CLOSE_TIMEOUT,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	HEARTBEAT_TIMEOUT_MS
} from '@missiv/common';
import type { API } from '$lib/API.js';
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

const api = { getSession: async () => ({ token: 'a.token' }) } as unknown as API;

let counter = 0;
function channelOf(createWebSocket: () => InboxSocket) {
	return openInboxChannel({
		endpoint: 'http://localhost',
		domain: `heartbeat-${++counter}.test`,
		privateKey: `0x${'11'.repeat(32)}`,
		api,
		createWebSocket,
		reconnectDelayMs: 1000
	});
}

describe("the live inbox channel's heartbeat", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('gives up a socket whose pong never comes, reconnects with backoff and syncs again', async () => {
		const { sockets, createWebSocket } = fakeSockets();
		const channel = channelOf(createWebSocket);
		const onOpen = vi.fn();
		const onError = vi.fn();
		const unsubscribe = channel.subscribe({ onOpen, onError });
		await vi.advanceTimersByTimeAsync(0);
		expect(sockets).toHaveLength(1);
		sockets[0].emit('open');
		expect(onOpen).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
		expect(sockets[0].sent).toEqual([HEARTBEAT_PING]);
		await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS - 1);
		expect(sockets[0].closed).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets[0].closed?.code).toBe(HEARTBEAT_CLOSE_TIMEOUT);
		expect(channel.connected).toBe(false);
		expect(onError).toHaveBeenCalledTimes(1);

		// the backoff's first delay, then a new socket, and the listener syncs again on its open
		await vi.advanceTimersByTimeAsync(999);
		expect(sockets).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets).toHaveLength(2);
		sockets[1].emit('open');
		expect(channel.connected).toBe(true);
		expect(onOpen).toHaveBeenCalledTimes(2);
		// a sync after the reconnection goes out on the new socket, not the given-up one
		void channel.sync({ conversation: 7 });
		expect(sockets[1].sent).toEqual([JSON.stringify({ type: 'sync', since: { conversation: 7 } })]);
		expect(sockets[0].sent).toEqual([HEARTBEAT_PING]);
		// the close the given-up socket reports later changes nothing
		sockets[0].emit('close', { code: 1006 });
		expect(channel.connected).toBe(true);
		unsubscribe();
	});

	it('keeps a socket that answers its pings', async () => {
		const { sockets, createWebSocket } = fakeSockets();
		const channel = channelOf(createWebSocket);
		const onOpen = vi.fn();
		const unsubscribe = channel.subscribe({ onOpen });
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].emit('open');
		for (let i = 1; i <= 5; i++) {
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
			expect(sockets[0].sent).toHaveLength(i);
			sockets[0].emit('message', { data: HEARTBEAT_PONG });
		}
		await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
		expect(sockets[0].closed).toBeUndefined();
		expect(sockets).toHaveLength(1);
		expect(onOpen).toHaveBeenCalledTimes(1);
		unsubscribe();
		expect(sockets[0].closed?.code).toBe(1000);
		// no ping after the channel closed
		await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
		expect(sockets[0].sent).toHaveLength(5);
	});

	it('takes any frame as an answer, and follows the configured interval and timeout', async () => {
		const { sockets, createWebSocket } = fakeSockets();
		const channel = openInboxChannel({
			endpoint: 'http://localhost',
			domain: `heartbeat-${++counter}.test`,
			privateKey: `0x${'22'.repeat(32)}`,
			api,
			createWebSocket,
			heartbeatIntervalMs: 5000,
			heartbeatTimeoutMs: 2000
		});
		const unsubscribe = channel.subscribe({});
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].emit('open');
		await vi.advanceTimersByTimeAsync(5000);
		expect(sockets[0].sent).toEqual([HEARTBEAT_PING]);
		sockets[0].emit('message', { data: JSON.stringify({ type: 'ready' }) });
		await vi.advanceTimersByTimeAsync(2000);
		expect(sockets[0].closed).toBeUndefined();
		await vi.advanceTimersByTimeAsync(3000 + 2000);
		expect(sockets[0].closed?.code).toBe(HEARTBEAT_CLOSE_TIMEOUT);
		unsubscribe();
	});
});

describe("the live inbox channel's features", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("are the current socket's welcome, unknown before it and after the socket is lost", async () => {
		const { sockets, createWebSocket } = fakeSockets();
		const channel = channelOf(createWebSocket);
		const unsubscribe = channel.subscribe({});
		await vi.advanceTimersByTimeAsync(0);
		sockets[0].emit('open');
		// a server older than the welcome sends none: nothing is known
		expect(channel.features).toBeUndefined();
		sockets[0].emit('message', {
			data: JSON.stringify({ type: 'welcome', features: ['typing', 7] })
		});
		expect(channel.features).toEqual(['typing']);
		sockets[0].emit('close', { code: 1006 });
		expect(channel.features).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1000);
		sockets[1].emit('open');
		sockets[1].emit('message', { data: JSON.stringify({ type: 'welcome', features: [] }) });
		expect(channel.features).toEqual([]);
		unsubscribe();
		expect(channel.features).toBeUndefined();
	});
});
