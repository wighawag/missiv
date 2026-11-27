// The harness's arithmetic, the only part of it `pnpm test` runs: a load run
// starts servers and takes seconds, so it has its own command (`pnpm load`).
import {describe, it, expect} from 'vitest';
import {percentile, summarize} from '../src/stats.js';
import {conversationPairs} from '../src/scenarios.js';

describe('percentile (nearest rank)', () => {
	it('picks the value at or above the rank', () => {
		const sorted = Array.from({length: 100}, (_, i) => i + 1);
		expect(percentile(sorted, 50)).toBe(50);
		expect(percentile(sorted, 95)).toBe(95);
		expect(percentile(sorted, 99)).toBe(99);
		expect(percentile(sorted, 100)).toBe(100);
		expect(percentile([7], 99)).toBe(7);
	});
});

describe('summarize', () => {
	it('reports throughput over the measured time, and the percentiles of the latencies', () => {
		const summary = summarize('send', [30, 10, 20, 40], 2000, 1);
		expect(summary).toMatchObject({name: 'send', ok: 4, errors: 1, throughput: 2, p50: 20, p95: 40, p99: 40, max: 40});
	});

	it('reports nothing measured as zeros, not NaN', () => {
		expect(summarize('empty', [], 1000, 0)).toMatchObject({ok: 0, throughput: 0, p50: 0, p99: 0});
	});
});

describe('conversationPairs', () => {
	it('puts every client in a conversation before giving anyone a second one', () => {
		const pairs = conversationPairs(6, 3);
		expect(new Set(pairs.flat())).toEqual(new Set([0, 1, 2, 3, 4, 5]));
	});

	it('never repeats a pair nor pairs a client with itself', () => {
		const pairs = conversationPairs(5, 10);
		expect(pairs).toHaveLength(10);
		const keys = pairs.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join('-'));
		expect(new Set(keys).size).toBe(10);
		expect(pairs.every(([a, b]) => a !== b)).toBe(true);
	});

	it('refuses more conversations than there are pairs', () => {
		expect(() => conversationPairs(3, 4)).toThrow();
	});
});
