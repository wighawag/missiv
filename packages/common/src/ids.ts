// Time-ordered identifiers: a ULID (48-bit millisecond time, then 80 random bits,
// in Crockford base32), monotonic within a process so two in the same millisecond
// still sort in creation order. Collision-free in practice, unlike time * 1000 + random(1000).
// The server's ids, and the client's messageIDs (signed by the sender, so a
// message carries its time).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(time: number): string {
	let str = '';
	for (let i = 0; i < 10; i++) {
		str = ALPHABET[time % 32] + str;
		time = Math.floor(time / 32);
	}
	return str;
}

export function newULID(now: number = Date.now()): string {
	if (now <= lastTime) {
		// same (or an earlier) millisecond: increment the previous random part
		now = lastTime;
		let i = lastRandom.length - 1;
		while (i >= 0 && lastRandom[i] === 31) {
			lastRandom[i] = 0;
			i--;
		}
		if (i < 0) {
			throw new Error('ULID random part overflow');
		}
		lastRandom[i]++;
	} else {
		lastTime = now;
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		lastRandom = Array.from(bytes, (b) => b % 32);
	}
	return encodeTime(now) + lastRandom.map((v) => ALPHABET[v]).join('');
}

/** The time (ms since the epoch) a ULID carries in its first 10 characters; NaN for a malformed one. */
export function ulidTime(id: string): number {
	if (id.length !== 26) {
		return NaN;
	}
	let time = 0;
	for (let i = 0; i < 10; i++) {
		const value = ALPHABET.indexOf(id[i].toUpperCase());
		if (value < 0) {
			return NaN;
		}
		time = time * 32 + value;
	}
	return time;
}

/**
 * A ULID of `time`, not monotonic with `newULID`: for a message signed again
 * under the server's time after a `stale` refusal, when this device's clock
 * is off.
 */
export function ulidAt(time: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return encodeTime(time) + Array.from(bytes, (b) => ALPHABET[b % 32]).join('');
}
