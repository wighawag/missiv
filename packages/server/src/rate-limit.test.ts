import {describe, expect, it} from 'vitest';
import {createInProcessTokenBuckets, createTokenBuckets, tokenBucketConfigsFromEnv} from './rate-limit.js';

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
	let time = start;
	return {
		now: () => time,
		advance(ms: number) {
			time += ms;
		},
		back(ms: number) {
			time -= ms;
		},
	};
}

describe('a token bucket', () => {
	it('accepts a burst, refuses beyond it with the time until the next token, and refills', () => {
		const clock = fakeClock();
		const buckets = createTokenBuckets({burst: 3, refillPerSecond: 0.5, now: clock.now});
		expect([buckets.take('a'), buckets.take('a'), buckets.take('a')]).toStrictEqual([
			{allowed: true},
			{allowed: true},
			{allowed: true},
		]);
		expect(buckets.take('a')).toStrictEqual({allowed: false, retryAfterMs: 2000});
		clock.advance(500);
		// a refusal costs nothing: the wait only shrinks
		expect(buckets.take('a')).toStrictEqual({allowed: false, retryAfterMs: 1500});
		clock.advance(1500);
		expect(buckets.take('a')).toStrictEqual({allowed: true});
		expect(buckets.take('a').allowed).toBe(false);
		// a long pause refills to the burst, never beyond
		clock.advance(60_000);
		for (let i = 0; i < 3; i++) {
			expect(buckets.take('a').allowed).toBe(true);
		}
		expect(buckets.take('a').allowed).toBe(false);
	});

	it('credits no refill twice when the clock steps back', () => {
		const clock = fakeClock();
		const buckets = createTokenBuckets({burst: 2, refillPerSecond: 1, now: clock.now});
		expect(buckets.take('a').allowed).toBe(true);
		// the clock steps back 1 s: the token left is taken, charged at the latest time seen
		clock.back(1000);
		expect(buckets.take('a').allowed).toBe(true);
		// the wait counts from that time, not from the earlier one
		expect(buckets.take('a')).toStrictEqual({allowed: false, retryAfterMs: 2000});
		// back where the clock was: the second it stepped back is not credited again
		clock.advance(1000);
		expect(buckets.take('a')).toStrictEqual({allowed: false, retryAfterMs: 1000});
		clock.advance(1000);
		expect(buckets.take('a')).toStrictEqual({allowed: true});
		expect(buckets.take('a').allowed).toBe(false);
	});

	it('keeps one budget per key', () => {
		const clock = fakeClock();
		const buckets = createTokenBuckets({burst: 1, refillPerSecond: 1, now: clock.now});
		expect(buckets.take('a').allowed).toBe(true);
		expect(buckets.take('a').allowed).toBe(false);
		expect(buckets.take('b').allowed).toBe(true);
	});

	it('forgets a key once its bucket has refilled (idle eviction)', () => {
		const clock = fakeClock();
		const buckets = createTokenBuckets({burst: 2, refillPerSecond: 1, now: clock.now});
		buckets.take('a');
		buckets.take('b');
		buckets.take('b');
		expect(buckets.size).toBe(2);
		// 'a' is full again after 1 s, 'b' after 2 s; the sweep runs at most every refill time
		clock.advance(1000);
		buckets.take('c');
		expect(buckets.size).toBe(3);
		clock.advance(1000);
		buckets.take('c');
		expect(buckets.size).toBe(1);
		clock.advance(10_000);
		buckets.take('d');
		expect(buckets.size).toBe(1);
		// a forgotten key starts from a full bucket, as it would have had anyway
		expect(buckets.take('a').allowed).toBe(true);
		expect(buckets.take('a').allowed).toBe(true);
		expect(buckets.take('a').allowed).toBe(false);
	});

	it('holds at most maxKeys keys, dropping the least recently used', () => {
		const clock = fakeClock();
		const buckets = createTokenBuckets({burst: 1, refillPerSecond: 0.001, now: clock.now, maxKeys: 2});
		buckets.take('a');
		buckets.take('b');
		buckets.take('a');
		buckets.take('c');
		expect(buckets.size).toBe(2);
		// 'b' was dropped, 'a' (used since) was kept
		expect(buckets.take('a').allowed).toBe(false);
		expect(buckets.take('b').allowed).toBe(true);
	});

	it('refuses a configuration that could never send', () => {
		expect(() => createTokenBuckets({burst: 0, refillPerSecond: 1})).toThrow();
		expect(() => createTokenBuckets({burst: 1, refillPerSecond: 0})).toThrow();
		expect(() => createTokenBuckets({burst: Number.NaN, refillPerSecond: 1})).toThrow();
	});
});

describe('the token buckets from env', () => {
	it('defaults, and reads each burst and refill', () => {
		expect(tokenBucketConfigsFromEnv({})).toStrictEqual({
			send: {burst: 20, refillPerSecond: 1},
			ip: {burst: 30, refillPerSecond: 0.5},
		});
		expect(
			tokenBucketConfigsFromEnv({
				RATE_LIMIT_SEND_BURST: '5',
				RATE_LIMIT_SEND_REFILL_PER_SECOND: '0.25',
				RATE_LIMIT_IP_BURST: '7',
				RATE_LIMIT_IP_REFILL_PER_SECOND: '2',
			}),
		).toStrictEqual({send: {burst: 5, refillPerSecond: 0.25}, ip: {burst: 7, refillPerSecond: 2}});
	});

	it('refuses a value that is not a positive number', () => {
		expect(() => tokenBucketConfigsFromEnv({RATE_LIMIT_SEND_BURST: 'many'})).toThrow(/RATE_LIMIT_SEND_BURST/);
		expect(() => tokenBucketConfigsFromEnv({RATE_LIMIT_IP_REFILL_PER_SECOND: '0'})).toThrow(
			/RATE_LIMIT_IP_REFILL_PER_SECOND/,
		);
	});

	it('keeps the same in-process buckets while the configuration is the same', () => {
		const get = createInProcessTokenBuckets();
		const first = get({});
		expect(get({})).toBe(first);
		expect(get({RATE_LIMIT_SEND_BURST: '2'})).not.toBe(first);
	});
});
