// Token buckets (spec scalable-direct-messaging, story 27): the budget of each
// account's sends, and a coarse one of each IP on what opens a session or
// registers a key set. Not the room's `RateLimiter` (one action per 5 s per IP,
// a server object a room calls over fetch; spec `scalable-rooms`): these answer
// synchronously, in the request that is charged.
import type {MiddlewareHandler} from 'hono/types';
import type {Context} from 'hono';
import type {Env} from './env.js';
import {MissivError} from './errors.js';
import type {RateLimitedDetails} from '@missiv/common';

/** A bucket of `burst` tokens, one taken per request, refilled at `refillPerSecond`. */
export type TokenBucketConfig = {burst: number; refillPerSecond: number};

/** Whether a request may run; when not, how long until its bucket has a token again. */
export type TokenBucketResult = {allowed: true} | {allowed: false; retryAfterMs: number};

/**
 * One token bucket per key, created full on first use. A refused request takes
 * nothing. May answer asynchronously, so a platform can keep the buckets in a
 * server object (the send's could move into cf-worker's Inbox Durable Object:
 * observation `2026-11-27-cf-send-bucket-still-per-isolate`).
 */
export type TokenBuckets = {
	take(key: string): TokenBucketResult | Promise<TokenBucketResult>;
};

/**
 * The buckets a server charges: `send` per account and domain on
 * `messages/send`; `ip` per client IP on `/session` and `register` together.
 */
export type ServerTokenBuckets = {send: TokenBuckets; ip: TokenBuckets};

export const DEFAULT_TOKEN_BUCKETS = {
	/** 20 messages at once, one a second sustained: more than a person types, far below what saturates a conversation */
	send: {burst: 20, refillPerSecond: 1},
	/** 30 at once, one every 2 s sustained: a NAT of hundreds of users opening their hourly sessions */
	ip: {burst: 30, refillPerSecond: 0.5},
} as const satisfies Record<keyof ServerTokenBuckets, TokenBucketConfig>;

function assertConfig(config: TokenBucketConfig) {
	if (!(Number.isFinite(config.burst) && config.burst >= 1)) {
		throw new Error(`a token bucket's burst must be a number of at least 1, not ${config.burst}`);
	}
	if (!(Number.isFinite(config.refillPerSecond) && config.refillPerSecond > 0)) {
		throw new Error(`a token bucket's refill must be a positive number, not ${config.refillPerSecond}`);
	}
}

/** Token buckets in memory: they answer at once, and say how many keys they hold. */
export type InProcessTokenBuckets = {take(key: string): TokenBucketResult; readonly size: number};

/**
 * Token buckets held in this process's memory (Node, Bun; on Cloudflare, one
 * isolate's, an approximation: each isolate has its own until the Durable
 * Object stores land).
 *
 * Idle eviction: a bucket that has refilled to its burst is the one a new key
 * would get, so it is dropped; a sweep at most once per refill time (the time
 * an empty bucket takes to fill) drops every such bucket, so the memory held is
 * that of the keys active within about that time. `maxKeys` bounds it anyway
 * (a flood of new keys, IPv6 addresses say): past it, the least recently used
 * key is dropped, a refused key counting as used, so a key kept busy at its
 * limit is the last to be reset.
 */
export function createTokenBuckets(
	config: TokenBucketConfig & {now?: () => number; maxKeys?: number},
): InProcessTokenBuckets {
	assertConfig(config);
	const {burst, refillPerSecond} = config;
	const now = config.now ?? Date.now;
	const maxKeys = config.maxKeys ?? 100_000;
	const sweepIntervalMs = Math.max(1000, (burst / refillPerSecond) * 1000);
	const buckets = new Map<string, {tokens: number; at: number}>();
	let lastSweep = now();

	function level(bucket: {tokens: number; at: number}, time: number) {
		return Math.min(burst, bucket.tokens + (Math.max(0, time - bucket.at) / 1000) * refillPerSecond);
	}

	function sweep(time: number) {
		for (const [key, bucket] of buckets) {
			if (level(bucket, time) >= burst) {
				buckets.delete(key);
			}
		}
	}

	function take(key: string): TokenBucketResult {
		const time = now();
		if (time - lastSweep >= sweepIntervalMs) {
			lastSweep = time;
			sweep(time);
		}
		const bucket = buckets.get(key);
		const tokens = bucket ? level(bucket, time) : burst;
		// the refill's anchor never goes back with the clock: a bucket refilled up
		// to `at` is not credited again for the time before it
		const at = bucket ? Math.max(time, bucket.at) : time;
		// the most recently used key goes last
		buckets.delete(key);
		if (tokens < 1) {
			buckets.set(key, bucket!);
			return {allowed: false, retryAfterMs: Math.ceil(at - time + ((1 - tokens) / refillPerSecond) * 1000)};
		}
		buckets.set(key, {tokens: tokens - 1, at});
		while (buckets.size > maxKeys) {
			buckets.delete(buckets.keys().next().value as string);
		}
		return {allowed: true};
	}

	return {
		take,
		get size() {
			return buckets.size;
		},
	};
}

function positiveNumber(env: Env, name: keyof Env, fallback: number): number {
	const value = env[name];
	if (value === undefined || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!(Number.isFinite(parsed) && parsed > 0)) {
		throw new Error(`${name} must be a positive number, not "${value}"`);
	}
	return parsed;
}

/** The configuration of the server's buckets: `DEFAULT_TOKEN_BUCKETS`, each value overridden by its env. */
export function tokenBucketConfigsFromEnv(env: Env): Record<keyof ServerTokenBuckets, TokenBucketConfig> {
	const {send, ip} = DEFAULT_TOKEN_BUCKETS;
	return {
		send: {
			burst: positiveNumber(env, 'RATE_LIMIT_SEND_BURST', send.burst),
			refillPerSecond: positiveNumber(env, 'RATE_LIMIT_SEND_REFILL_PER_SECOND', send.refillPerSecond),
		},
		ip: {
			burst: positiveNumber(env, 'RATE_LIMIT_IP_BURST', ip.burst),
			refillPerSecond: positiveNumber(env, 'RATE_LIMIT_IP_REFILL_PER_SECOND', ip.refillPerSecond),
		},
	};
}

/**
 * The server's buckets held in process, from the env of the request (a worker
 * sees its env only in a request): created on first use and kept while the
 * configuration stays the same.
 */
export function createInProcessTokenBuckets(): (env: Env) => ServerTokenBuckets {
	let current: {key: string; buckets: ServerTokenBuckets} | undefined;
	return (env) => {
		const configs = tokenBucketConfigsFromEnv(env);
		const key = JSON.stringify(configs);
		if (current?.key !== key) {
			current = {key, buckets: {send: createTokenBuckets(configs.send), ip: createTokenBuckets(configs.ip)}};
		}
		return current.buckets;
	};
}

/** Refuse with `rate_limited` when `bucket` has no token for `key`. */
export async function charge(bucket: TokenBuckets, key: string): Promise<void> {
	const result = await bucket.take(key);
	if (!result.allowed) {
		throw new MissivError('rate_limited', 'too many requests: retry later', {
			retryAfterMs: result.retryAfterMs,
		} satisfies RateLimitedDetails);
	}
}

/**
 * The per-IP limit, before anything else of the route (no signature checked, no
 * database read for a refused request). A request whose IP the platform does not
 * know is not limited: one shared bucket for every unknown caller would refuse
 * them all together (every client behind a proxy the platform cannot see through).
 */
export function limitPerIP<CustomEnv extends Env>(options: {
	getEnv(c: Context<{Bindings: CustomEnv}>): CustomEnv;
	getIP?(c: Context): string | undefined;
	getTokenBuckets(env: CustomEnv): ServerTokenBuckets;
}): MiddlewareHandler {
	return async (c, next) => {
		const ip = options.getIP?.(c);
		if (ip) {
			await charge(options.getTokenBuckets(options.getEnv(c)).ip, ip);
		}
		await next();
	};
}
