// A KeyDirectory in front of another, answering its key lookups from a cache
// held by the caller (Cloudflare: one per isolate, so a send's sender lookup and
// a push's recipient lookup do not each cost a D1 round trip, task
// `cloudflare-durable-object-stores`).
//
// Decisions recorded here:
// - Only what was FOUND is cached, never an absence: a user who registers and
//   at once opens a session or receives a message (on another isolate) is seen
//   at once. Alternative: cache absences too; rejected, a fresh registration
//   would be refused for the time to live.
// - A found entry is answered until its time to live (`ttlMs`, Cloudflare's 5 s)
//   even if another isolate replaced the key set meanwhile: for that long a
//   replaced signing key may still open a session or send there, and a send with
//   the new one may be refused `forbidden` (the client re-sends). A registration
//   through THIS cache forgets the user's entries at once. Alternatives: no
//   cache (a D1 read per send and per push, which ADR-0005 wants off the send
//   path), or invalidation across isolates (no cheap channel for it on Workers).
// - The cache is bounded (`maxEntries`, oldest dropped first) so an isolate's
//   memory does not grow with the number of users it has seen.
import type {Address, PublicKey, ResponseGetDomainUser, ResponseGetKeySet, String0x} from '@missiv/common';
import type {KeyDirectory} from './ports.js';

/** Where the cached answers are held: a Map the caller keeps for as long as the cache should live. */
export type KeyDirectoryCache = Map<string, {expiresAt: number; value: unknown}>;

export function cachedKeyDirectory(
	keys: KeyDirectory,
	options: {cache: KeyDirectoryCache; ttlMs: number; maxEntries?: number; now?: () => number},
): KeyDirectory {
	const {cache, ttlMs} = options;
	const maxEntries = options.maxEntries ?? 10_000;
	const now = options.now ?? Date.now;

	async function cached<T>(key: string, found: (value: T) => boolean, read: () => Promise<T>): Promise<T> {
		const entry = cache.get(key);
		const time = now();
		if (entry && entry.expiresAt > time) {
			return entry.value as T;
		}
		cache.delete(key);
		const value = await read();
		if (found(value)) {
			while (cache.size >= maxEntries) {
				const oldest = cache.keys().next();
				if (oldest.done) break;
				cache.delete(oldest.value);
			}
			cache.set(key, {expiresAt: time + ttlMs, value});
		}
		return value;
	}

	const userKey = (domain: string, address: Address) => `user:${domain}:${address.toLowerCase()}`;
	const signingKey = (key: PublicKey) => `signing:${key.toLowerCase()}`;

	/** forget what this cache holds of (domain, address): its current key set and that set's signing key */
	function forget(domain: string, address: Address) {
		const entry = cache.get(userKey(domain, address));
		const domainUser = (entry?.value as ResponseGetDomainUser | undefined)?.domainUser;
		if (domainUser) {
			cache.delete(signingKey(domainUser.keySet.signing.publicKey));
		}
		cache.delete(userKey(domain, address));
	}

	return {
		async register(address, keyRef, timestampMS, action) {
			await keys.register(address, keyRef, timestampMS, action);
			forget(action.domain, address);
		},
		async editUser(address, timestampMS, action) {
			await keys.editUser(address, timestampMS, action);
			forget(action.domain, address);
		},
		getDomainUser(domain, address) {
			return cached<ResponseGetDomainUser>(
				userKey(domain, address),
				(r) => !!r.domainUser,
				() => keys.getDomainUser(domain, address),
			);
		},
		getDomainUserBySigningKey(key) {
			return cached<ResponseGetDomainUser>(
				signingKey(key),
				(r) => !!r.domainUser,
				() => keys.getDomainUserBySigningKey(key),
			);
		},
		getKeySet(domain, keyRef: String0x) {
			return cached<ResponseGetKeySet>(
				`keySet:${domain}:${keyRef.toLowerCase()}`,
				(r) => !!r.keySet,
				() => keys.getKeySet(domain, keyRef),
			);
		},
		acceptRequestSignature(signature, expiresAt, at) {
			return keys.acceptRequestSignature(signature, expiresAt, at);
		},
	};
}
