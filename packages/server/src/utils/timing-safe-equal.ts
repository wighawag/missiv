/** Compare two strings in time independent of where they differ (their lengths aside). */
export function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const x = encoder.encode(a);
	const y = encoder.encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	}
	return diff === 0;
}
