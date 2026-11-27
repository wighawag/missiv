// Rate limits (spec scalable-direct-messaging, story 27): a token bucket per
// account on sends, so one abusive account cannot saturate a conversation or
// the server while accounts sharing an IP keep their own budgets, and a coarse
// bucket per IP on what opens sessions and registers keys. A refusal is
// `rate_limited`, with the wait until the next token (`retryAfterMs`, and the
// `Retry-After` header in seconds).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MissivAPIError} from '@missiv/client';
import type {RateLimitedDetails} from '@missiv/common';
import {conversationIDOf, createHarness, createUser, DOMAIN, SERVER_URL, type TestUser} from './setup.js';

let A: TestUser;
let B: TestUser;
let C: TestUser;

beforeEach(async () => {
	[A, B, C] = await Promise.all([createUser(), createUser(), createUser()]);
	// the buckets read the clock: the test moves it
	vi.useFakeTimers({toFake: ['Date']});
	vi.setSystemTime(Date.now());
});

afterEach(() => {
	vi.useRealTimers();
});

async function refusal(promise: Promise<unknown>): Promise<MissivAPIError> {
	const error = await promise.then(
		() => undefined,
		(e) => e,
	);
	expect(error).toBeInstanceOf(MissivAPIError);
	return error as MissivAPIError;
}

describe('the send budget of an account', () => {
	it('accepts a burst, refuses beyond it with a retry-after, and refill restores sending', async () => {
		const h = createHarness({RATE_LIMIT_SEND_BURST: '3', RATE_LIMIT_SEND_REFILL_PER_SECOND: '0.5'});
		await h.registerAll([A, B]);
		for (let i = 0; i < 3; i++) {
			await h.send({from: A, to: B, content: `burst ${i}`});
		}
		const refused = await refusal(h.send({from: A, to: B, content: 'one too many'}));
		expect(refused.status).toBe(429);
		expect(refused.code).toBe('rate_limited');
		expect((refused.details as RateLimitedDetails).retryAfterMs).toBe(2000);
		// nothing of the refused message was stored
		expect(await h.contents(B, conversationIDOf([A.address, B.address]))).toStrictEqual([
			'burst 0',
			'burst 1',
			'burst 2',
		]);

		vi.setSystemTime(Date.now() + 2000);
		await h.send({from: A, to: B, content: 'after the refill'});
		expect((await refusal(h.send({from: A, to: B}))).code).toBe('rate_limited');
	});

	it('is its own: two accounts behind one IP have independent send budgets', async () => {
		const h = createHarness({RATE_LIMIT_SEND_BURST: '2'}, {getIP: () => '203.0.113.7'});
		await h.registerAll([A, B, C]);
		await h.send({from: A, to: C});
		await h.send({from: A, to: B});
		expect((await refusal(h.send({from: A, to: C}))).code).toBe('rate_limited');
		await h.send({from: B, to: C});
		await h.send({from: B, to: A});
		expect((await refusal(h.send({from: B, to: C}))).code).toBe('rate_limited');
	});
});

describe('the budget of an IP on sessions and registrations', () => {
	/** POST /api/session unsigned: refused 401 after the IP's budget is charged, 429 once it is spent. */
	function unsignedSession(h: ReturnType<typeof createHarness>) {
		return h.app.request(`${SERVER_URL}/api/session`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({domain: DOMAIN}),
		});
	}

	it('is shared by registrations and session openings, refused with a Retry-After', async () => {
		let ip = '198.51.100.1';
		const h = createHarness({RATE_LIMIT_IP_BURST: '3', RATE_LIMIT_IP_REFILL_PER_SECOND: '0.25'}, {getIP: () => ip});
		await h.register(A);
		await h.register(B);
		// A's first call on a session opens it: the third request of the IP
		await h.conversations(A);

		const refused = await refusal(h.register(C));
		expect(refused.code).toBe('rate_limited');
		expect((refused.details as RateLimitedDetails).retryAfterMs).toBe(4000);
		const response = await unsignedSession(h);
		expect(response.status).toBe(429);
		expect(response.headers.get('Retry-After')).toBe('4');

		// another IP has its own budget; refill restores this one
		ip = '198.51.100.2';
		await h.register(C);
		ip = '198.51.100.1';
		vi.setSystemTime(Date.now() + 4000);
		expect((await unsignedSession(h)).status).toBe(401);
		expect((await unsignedSession(h)).status).toBe(429);
	});

	it('does not count requests that only use a session', async () => {
		const h = createHarness({RATE_LIMIT_IP_BURST: '3'}, {getIP: () => '198.51.100.1'});
		await h.registerAll([A, B]);
		for (let i = 0; i < 5; i++) {
			await h.conversations(A);
			await h.send({from: A, to: B});
		}
	});

	it('is not applied when the IP is unknown', async () => {
		const h = createHarness({RATE_LIMIT_IP_BURST: '1'});
		await h.registerAll([A, B, C]);
	});
});
