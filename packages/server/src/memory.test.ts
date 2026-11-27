import {afterEach, describe, expect, it, vi} from 'vitest';
import {createInProcessRooms} from './memory.js';

const noDB = () => {
	throw new Error('not used');
};

/** One action of `ip` on its room rate limiter, as a room's RateLimiterClient posts it: the cooldown in seconds. */
async function act(rooms: ReturnType<typeof createInProcessRooms>, ip: string): Promise<number> {
	const response = await rooms.getRateLimiter({}, ip).fetch('https://dummy-url', {method: 'POST'});
	return Number(await response.text());
}

describe('the room rate limiters of a process', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('forgets a limiter once it is idle (its cooldown has passed), and keeps a busy one', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(1_000_000);
		const rooms = createInProcessRooms({getDB: noDB});
		await act(rooms, '1.1.1.1');
		await act(rooms, '2.2.2.2');
		expect(rooms.rateLimiterCount()).toBe(2);

		// '1.1.1.1' keeps acting (its limiter runs 5 s ahead per action), '2.2.2.2' goes quiet
		for (let i = 0; i < 6; i++) {
			await act(rooms, '1.1.1.1');
		}
		vi.setSystemTime(1_000_000 + 10_000);
		await act(rooms, '3.3.3.3');
		expect(rooms.rateLimiterCount()).toBe(2);

		// long after, every limiter has caught up with the clock: only the last one used is left
		vi.setSystemTime(1_000_000 + 10 * 60_000);
		await act(rooms, '3.3.3.3');
		expect(rooms.rateLimiterCount()).toBe(1);
	});

	it('keeps the limit of an IP across an eviction: a room holding its stub sees the same limiter', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(1_000_000);
		const rooms = createInProcessRooms({getDB: noDB});
		// a room's RateLimiterClient keeps the stub it was given for the socket's life
		const held = rooms.getRateLimiter({}, '1.1.1.1');
		await held.fetch('https://dummy-url', {method: 'POST'});
		vi.setSystemTime(1_000_000 + 10 * 60_000);
		await act(rooms, '2.2.2.2');
		expect(rooms.rateLimiterCount()).toBe(1);

		// the held stub and a new one for the same IP share one budget again
		const cooldowns: number[] = [];
		for (let i = 0; i < 5; i++) {
			const response = await held.fetch('https://dummy-url', {method: 'POST'});
			cooldowns.push(Number(await response.text()));
		}
		cooldowns.push(await act(rooms, '1.1.1.1'));
		expect(cooldowns.slice(0, 4)).toStrictEqual([0, 0, 0, 0]);
		expect(cooldowns[5]).toBeGreaterThan(0);
	});
});
