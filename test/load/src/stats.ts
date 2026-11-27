// Throughput and latency percentiles of a measured operation.

/** The nearest-rank percentile of ascending values: the smallest value with at least p% of the values at or below it. */
export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export type Summary = {
	name: string;
	/** operations that succeeded (their latencies are the percentiles) */
	ok: number;
	errors: number;
	/** successful operations per second of measured time */
	throughput: number;
	/** latencies in milliseconds */
	p50: number;
	p95: number;
	p99: number;
	max: number;
	/** anything else the scenario measured (rates, counts, setup times) */
	extra?: Record<string, number | string>;
};

export function summarize(
	name: string,
	latencies: number[],
	elapsedMs: number,
	errors: number,
	extra?: Record<string, number | string>,
): Summary {
	const sorted = [...latencies].sort((a, b) => a - b);
	return {
		name,
		ok: sorted.length,
		errors,
		throughput: elapsedMs > 0 ? sorted.length / (elapsedMs / 1000) : 0,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: sorted.length ? sorted[sorted.length - 1] : 0,
		...(extra ? {extra} : {}),
	};
}

function fixed(n: number) {
	return Number.isInteger(n) || n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

/** One summary as a line of text. */
export function formatSummary(s: Summary): string {
	const extra = s.extra
		? '  ' +
			Object.entries(s.extra)
				.map(([k, v]) => `${k}=${typeof v === 'number' ? fixed(v) : v}`)
				.join(' ')
		: '';
	return `${s.name.padEnd(14)} ok=${s.ok} errors=${s.errors} throughput=${fixed(s.throughput)}/s  p50=${fixed(s.p50)}ms p95=${fixed(s.p95)}ms p99=${fixed(s.p99)}ms max=${fixed(s.max)}ms${extra}`;
}
