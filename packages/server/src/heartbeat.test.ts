// The server side of the socket heartbeat on Node.js and Bun (`@missiv/common`'s
// heartbeat.ts): `ping` answered with `pong`, and a socket that sent nothing for
// three intervals closed, for the live inbox's sockets and the rooms' alike.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
	HEARTBEAT_CLOSE_TIMEOUT,
	HEARTBEAT_IDLE_INTERVALS,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PING,
	HEARTBEAT_PONG,
} from '@missiv/common';
import type {RemoteSQL} from 'remote-sql';
import {inboxSocketEvents} from './api/inbox/index.js';
import {createInProcessLiveInbox} from './live.js';
import {createInProcessRooms} from './memory.js';
import {RateLimiterClient} from './RateLimiter.js';

const IDLE_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_IDLE_INTERVALS;
const USER = `0x${'ab'.repeat(20)}` as const;

type FakeSocket = {
	sent: string[];
	closed?: {code?: number; reason?: string};
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

function fakeSocket(): FakeSocket {
	const socket: FakeSocket = {
		sent: [],
		send(data) {
			socket.sent.push(data);
		},
		close(code, reason) {
			socket.closed ??= {code, reason};
		},
	};
	return socket;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("the live inbox's sockets on Node.js and Bun", () => {
	const stores = {
		conversations: {listMessages: async () => ({messages: [], hasMore: false})},
		inbox: {getConversation: async () => undefined, update: async () => {}},
	};

	function open() {
		const live = createInProcessLiveInbox();
		const claims = {
			account: USER,
			domain: 'heartbeat.test',
			keyRef: `0x${'33'.repeat(32)}` as const,
			exp: Date.now() + 24 * 60 * 60 * 1000,
		};
		const events = inboxSocketEvents(stores, claims, live);
		const ws = fakeSocket();
		events.onOpen?.(new Event('open'), ws as never);
		const message = async (data: string) => {
			events.onMessage?.(new MessageEvent('message', {data}), ws as never);
			await vi.advanceTimersByTimeAsync(0);
		};
		return {live, ws, message};
	}

	it('answers a ping with pong', async () => {
		const {ws, message} = open();
		await message(HEARTBEAT_PING);
		expect(ws.sent).toEqual([HEARTBEAT_PONG]);
		expect(ws.closed).toBeUndefined();
	});

	it('closes a socket that sent nothing for three intervals', async () => {
		const {live, ws} = open();
		expect(live.size).toBe(1);
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
		expect(ws.closed).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(ws.closed?.code).toBe(HEARTBEAT_CLOSE_TIMEOUT);
		expect(live.size).toBe(0);
	});

	it('keeps a socket that keeps pinging', async () => {
		const {live, ws, message} = open();
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
			await message(HEARTBEAT_PING);
		}
		expect(ws.closed).toBeUndefined();
		expect(live.size).toBe(1);
		expect(ws.sent.filter((frame) => frame === HEARTBEAT_PONG)).toHaveLength(10);
	});

	it('counts any frame as a sign of life (a sync)', async () => {
		const {ws, message} = open();
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
		await message(JSON.stringify({type: 'sync', since: {}}));
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
		expect(ws.closed).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1000);
		expect(ws.closed?.code).toBe(HEARTBEAT_CLOSE_TIMEOUT);
	});
});

describe('the rooms held in process', () => {
	async function open() {
		const rooms = createInProcessRooms({getDB: () => ({}) as RemoteSQL});
		const room = rooms.getRoom({}, '@heartbeat.test');
		expect(room.prepareConnection(new Request('http://localhost/api/public/room/@heartbeat.test/ws'))).toBeUndefined();
		const ws = fakeSocket() as unknown as WebSocket & FakeSocket;
		room.addWebSocket(ws);
		await room.webSocketOpen(ws, {ip: '127.0.0.1'});
		ws.sent.length = 0;
		return {room, ws};
	}

	it('answers a ping with pong, without charging the rate limiter', async () => {
		const {room, ws} = await open();
		const checkLimit = vi.spyOn(RateLimiterClient.prototype, 'checkLimit');
		try {
			for (let i = 0; i < 5; i++) {
				await room.webSocketMessage(ws, HEARTBEAT_PING);
			}
			expect(ws.sent).toEqual([HEARTBEAT_PONG, HEARTBEAT_PONG, HEARTBEAT_PONG, HEARTBEAT_PONG, HEARTBEAT_PONG]);
			expect(checkLimit).not.toHaveBeenCalled();
		} finally {
			checkLimit.mockRestore();
		}
	});

	it('closes a socket that sent nothing for three intervals', async () => {
		const {room, ws} = await open();
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
		expect(ws.closed).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(ws.closed?.code).toBe(HEARTBEAT_CLOSE_TIMEOUT);
		expect(room.getWebSockets()).toHaveLength(0);
	});

	it('keeps a socket that keeps pinging', async () => {
		const {room, ws} = await open();
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
			await room.webSocketMessage(ws, HEARTBEAT_PING);
		}
		expect(ws.closed).toBeUndefined();
		expect(room.getWebSockets()).toEqual([ws]);
	});
});
