// The primitives missiv's messages rest on since 0.6's keys: a key set derived
// by delegated-identity (never a copy of the derivation here), and the public
// half of a key set as it is registered and sent. (The message format's own
// vectors are @missiv/common's `message.test.ts`.)
import { deriveKeySet } from 'delegated-identity';
import { describe, expect, it } from 'vitest';
import { publicKeySetOf, sameKeySet } from './messages.js';

const origin = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;

describe('a key set as registered', () => {
	it('is the public keys only', () => {
		const keySet = deriveKeySet(origin('33'));
		const registered = publicKeySetOf(keySet);
		expect(registered).toEqual({
			signing: { publicKey: keySet.signing.publicKey },
			encryption: { publicKey: keySet.encryption.publicKey }
		});
		expect(sameKeySet(registered, keySet)).toBe(true);
		expect(sameKeySet(registered, deriveKeySet(origin('44')))).toBe(false);
	});
});
