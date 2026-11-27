// The room store's heartbeat (`@missiv/common`'s heartbeat.ts) on a fake clock
// and fake sockets: a socket whose `pong` never comes is given up and replaced,
// one that answers stays.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import {
	HEARTBEAT_CLOSE_TIMEOUT,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
	HEARTBEAT_TIMEOUT_MS
} from '@missiv/common';
import type { MissivRegistrationStore } from '$lib/registration/index.js';
import { openRoom, type Room, type RoomSocket } from './index.js';

type FakeSocket = RoomSocket & {
	sent: string[];
	closed?: { code?: number; reason?: string };
	emit(type: 'open' | 'close' | 'message', event?: unknown): void;
};

function fakeSockets() {
	const sockets: FakeSocket[] = [];
	function createWebSocket(): RoomSocket {
		const listeners = new Map<string, Set<(event: any) => void>>();
		const socket: FakeSocket = {
			sent: [],
			send(data) {
				socket.sent.push(data);
			},
			close(code?: number, reason?: string) {
				socket.closed = { code, reason };
			},
			addEventListener(type, listener) {
				listeners.set(type, new Set([...(listeners.get(type) ?? []), listener]));
			},
			removeEventListener(type, listener) {
				listeners.get(type)?.delete(listener);
			},
			emit(type, event = {}) {
				for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
			}
		};
		sockets.push(socket);
		return socket;
	}
	return { sockets, createWebSocket };
}

/** a room with no registered account: it connects, reads, and sends no login */
function roomOf(
	createWebSocket: () => RoomSocket,
	options: Partial<Parameters<typeof openRoom>[0]> = {}
) {
	const registration = writable({ step: 'Idle' }) as unknown as MissivRegistrationStore;
	const room = openRoom({
		url: 'ws://localhost/api/public/room/@heartbeat.test/ws',
		registration,
		createWebSocket,
		reconnectDelayMs: 1000,
		...options
	});
	let state: Room | undefined;
	const unsubscribe = room.subscribe((value) => (state = value));
	return { state: () => state!, unsubscribe };
}

describe("the room store's heartbeat", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('gives up a socket whose pong never comes, and reconnects with backoff', async () => {
		const { sockets, createWebSocket } = fakeSockets();
		const room = roomOf(createWebSocket);
		sockets[0].emit('open');
		expect(room.state().step).toBe('Connected');

		await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
		expect(sockets[0].sent).toEqual([HEARTBEAT_PING]);
		await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS - 1);
		expect(sockets[0].closed).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets[0].closed?.code).toBe(HEARTBEAT_CLOSE_TIMEOUT);
		expect(room.state().step).toBe('Connecting');

		await vi.advanceTimersByTimeAsync(999);
		expect(sockets).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets).toHaveLength(2);
		sockets[1].emit('open');
		expect(room.state().step).toBe('Connected');
		room.unsubscribe();
	});

	it('keeps a socket that answers its pings', async () => {
		const { sockets, createWebSocket } = fakeSockets();
		const room = roomOf(createWebSocket);
		sockets[0].emit('open');
		for (let i = 1; i <= 5; i++) {
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
			expect(sockets[0].sent).toHaveLength(i);
			sockets[0].emit('message', { data: HEARTBEAT_PONG });
		}
		await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS);
		expect(sockets[0].closed).toBeUndefined();
		expect(sockets).toHaveLength(1);
		expect(room.state().step).toBe('Connected');
		room.unsubscribe();
		await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
		expect(sockets[0].sent).toHaveLength(5);
	});

	it('takes any frame as an answer, and follows the configured interval and timeout', async () => {
		const { sockets, createWebSocket } = fakeSockets();
		const room = roomOf(createWebSocket, { heartbeatIntervalMs: 5000, heartbeatTimeoutMs: 2000 });
		sockets[0].emit('open');
		await vi.advanceTimersByTimeAsync(5000);
		expect(sockets[0].sent).toEqual([HEARTBEAT_PING]);
		sockets[0].emit('message', { data: JSON.stringify({ challenge: 'c', id: 'i' }) });
		await vi.advanceTimersByTimeAsync(2000);
		expect(sockets[0].closed).toBeUndefined();
		await vi.advanceTimersByTimeAsync(3000 + 2000);
		expect(sockets[0].closed?.code).toBe(HEARTBEAT_CLOSE_TIMEOUT);
		room.unsubscribe();
	});
});
