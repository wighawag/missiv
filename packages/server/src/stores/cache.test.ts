import {describe, it, expect} from 'vitest';
import type {DomainUser, RegisteredKeySet} from '@missiv/common';
import {cachedKeyDirectory, type KeyDirectoryCache} from './cache.js';
import type {KeyDirectory} from './ports.js';

const A = `0x${'aa'.repeat(20)}` as const;
const SIGNING = `0x${'01'.repeat(32)}` as const;
const NEW_SIGNING = `0x${'02'.repeat(32)}` as const;
const KEY_REF = `0x${'03'.repeat(32)}` as const;

function domainUserOf(signing: `0x${string}`): DomainUser {
	return {
		user: A,
		domain: 'test.com',
		keyRef: KEY_REF,
		keySet: {signing: {publicKey: signing}, encryption: {publicKey: signing}},
		ownershipSignature: '0x00',
		appOrigin: 'https://test.com',
		name: null,
		description: null,
		added: 0,
		lastPresence: 0,
	};
}

/** A directory that counts its reads, with one user whose signing key can be replaced. */
function directory() {
	const reads = {domainUser: 0, bySigningKey: 0, keySet: 0};
	let current: DomainUser | undefined;
	const keys: KeyDirectory = {
		async register() {
			current = domainUserOf(current ? NEW_SIGNING : SIGNING);
		},
		async editUser() {},
		async getDomainUser() {
			reads.domainUser++;
			return {domainUser: current};
		},
		async getDomainUserBySigningKey(key) {
			reads.bySigningKey++;
			return {domainUser: current?.keySet.signing.publicKey === key ? current : undefined};
		},
		async getKeySet() {
			reads.keySet++;
			return {keySet: current ? ({...current, registered: 0} as RegisteredKeySet) : undefined};
		},
		async acceptRequestSignature() {
			return true;
		},
	};
	return {keys, reads};
}

const register = (keys: KeyDirectory) =>
	keys.register(A, KEY_REF, 0, {
		type: 'register',
		domain: 'test.com',
		appOrigin: 'https://test.com',
		address: A,
		keySet: {signing: {publicKey: SIGNING}, encryption: {publicKey: SIGNING}},
		ownershipSignature: '0x00',
	});

describe('cachedKeyDirectory', () => {
	it('answers a found key set from the cache until its time to live has passed', async () => {
		const {keys, reads} = directory();
		let now = 0;
		const cache: KeyDirectoryCache = new Map();
		const cached = cachedKeyDirectory(keys, {cache, ttlMs: 1000, now: () => now});
		await register(keys);
		for (let i = 0; i < 3; i++) {
			expect((await cached.getDomainUser('test.com', A)).domainUser?.user).toBe(A);
			expect((await cached.getDomainUserBySigningKey(SIGNING)).domainUser?.user).toBe(A);
			expect((await cached.getKeySet('test.com', KEY_REF)).keySet?.user).toBe(A);
		}
		expect(reads).toEqual({domainUser: 1, bySigningKey: 1, keySet: 1});
		now = 1001;
		await cached.getDomainUser('test.com', A);
		expect(reads.domainUser).toBe(2);
	});

	it('never caches an absence: a registration is seen at once', async () => {
		const {keys, reads} = directory();
		const cached = cachedKeyDirectory(keys, {cache: new Map(), ttlMs: 1000, now: () => 0});
		expect((await cached.getDomainUser('test.com', A)).domainUser).toBeUndefined();
		await register(keys);
		expect((await cached.getDomainUser('test.com', A)).domainUser?.user).toBe(A);
		expect(reads.domainUser).toBe(2);
	});

	it("forgets a user's entries when this isolate registers a key set for them", async () => {
		const {keys} = directory();
		const cached = cachedKeyDirectory(keys, {cache: new Map(), ttlMs: 1000, now: () => 0});
		await register(cached);
		await cached.getDomainUser('test.com', A);
		await cached.getDomainUserBySigningKey(SIGNING);
		await register(cached); // the key set replaced
		expect((await cached.getDomainUser('test.com', A)).domainUser?.keySet.signing.publicKey).toBe(NEW_SIGNING);
		expect((await cached.getDomainUserBySigningKey(SIGNING)).domainUser).toBeUndefined();
	});

	it('holds at most maxEntries, dropping the oldest', async () => {
		const {keys} = directory();
		const cache: KeyDirectoryCache = new Map();
		const cached = cachedKeyDirectory(keys, {cache, ttlMs: 1000, maxEntries: 2, now: () => 0});
		await register(keys);
		await cached.getDomainUser('test.com', A);
		await cached.getDomainUserBySigningKey(SIGNING);
		await cached.getKeySet('test.com', KEY_REF);
		expect(cache.size).toBe(2);
	});
});
