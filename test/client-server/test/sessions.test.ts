// Sessions (ADR-0004 decision 5, ADR-0006 "Sessions and replay"): one Ed25519
// signed request to POST /api/session opens a session, and its HMAC token
// authenticates every later request but `register` (sends included, whose
// message carries its own signature), with no signature check and no database
// read.
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {signRequest} from 'delegated-identity';
import {API, MissivAPIError} from '@missiv/client';
import {
	createActions,
	createHarness,
	createUser,
	mintSessionToken,
	newKeySet,
	publicOf,
	APP_ORIGIN,
	DOMAIN,
	NAMESPACE,
	SERVER_URL,
	SESSION_SECRET,
	type Harness,
	type SessionClaims,
	type TestUser,
} from './setup.js';

let h: Harness;
let A: TestUser;
let B: TestUser;

beforeEach(async () => {
	h = createHarness();
	[A, B] = await Promise.all([createUser(), createUser()]);
	await h.registerAll([A, B]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

const HOUR = 60 * 60 * 1000;

function claimsOf(user: TestUser, overrides: Partial<SessionClaims> = {}): SessionClaims {
	return {account: user.address, domain: DOMAIN, keyRef: user.keyRef, exp: Date.now() + HOUR, ...overrides};
}

/** listConversations in DOMAIN, authenticated by `token` alone. */
async function withToken(token: string, harness: Harness = h, domain = DOMAIN) {
	const response = await harness.app.request(`${SERVER_URL}/api/private/listConversations`, {
		method: 'POST',
		headers: {'content-type': 'application/json', Authorization: `Bearer ${token}`},
		body: JSON.stringify({type: 'listConversations', domain, namespace: NAMESPACE}),
	});
	return {status: response.status, body: (await response.json()) as any};
}

/** POST /api/session for `domain`, signed by `user`'s signing key (or another key set's). */
async function signedSession(user: TestUser | {keySet: {signing: {privateKey: `0x${string}`}}}, domain = DOMAIN) {
	const body = JSON.stringify({domain});
	const signature = await signRequest(
		{serverOrigin: SERVER_URL, method: 'POST', path: '/api/session', body},
		user.keySet.signing.privateKey,
	);
	const headers = {'content-type': 'application/json', SIGNATURE: signature};
	const response = await h.app.request(`${SERVER_URL}/api/session`, {method: 'POST', headers, body});
	return {response, headers, body};
}

describe('opening a session', () => {
	it('returns a token for the account whose current key set signed, valid about an hour', async () => {
		const before = Date.now();
		const session = await h.api.openSession({domain: DOMAIN}, {privateKey: A.keySet.signing.privateKey});
		expect(session.keyRef).toBe(A.keyRef);
		expect(session.expiresAt).toBeGreaterThanOrEqual(before + HOUR - 1000);
		expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + HOUR);
		expect((await withToken(session.token)).status).toBe(200);
	});

	it('refuses a replayed session request within its window', async () => {
		const first = await signedSession(A);
		expect(first.response.status).toBe(200);
		const replay = await h.app.request(`${SERVER_URL}/api/session`, {
			method: 'POST',
			headers: first.headers,
			body: first.body,
		});
		expect(replay.status).toBe(409);
		expect(((await replay.json()) as any).error.code).toBe('conflict');
	});

	it('refuses an unsigned request, an unregistered key, a replaced key set and another domain', async () => {
		const unsigned = await h.app.request(`${SERVER_URL}/api/session`, {
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({domain: DOMAIN}),
		});
		expect(unsigned.status).toBe(401);

		expect((await signedSession({keySet: newKeySet()})).response.status).toBe(401);
		expect((await signedSession(A, 'other.com')).response.status).toBe(403);

		const second = newKeySet();
		await h.api.register(
			{
				type: 'register',
				domain: DOMAIN,
				appOrigin: APP_ORIGIN,
				address: A.address,
				keySet: publicOf(second),
				ownershipSignature: await A.signPublication(second),
			},
			{privateKey: second.signing.privateKey},
		);
		expect((await signedSession(A)).response.status).toBe(401);
	});
});

describe('a session token', () => {
	it('authenticates a request without a database read', async () => {
		const {token} = await h.api.openSession({domain: DOMAIN}, {privateKey: A.keySet.signing.privateKey});
		h.queries.length = 0;
		expect((await withToken(token)).status).toBe(200);
		// the route's own conversation listing, and nothing of the key directory or the replay set
		expect(h.queries.length).toBeGreaterThan(0);
		expect(h.queries.filter((sql) => /DomainUsers|KeySets|RequestSignatures/.test(sql))).toEqual([]);

		// a refused token costs no read either
		h.queries.length = 0;
		expect((await withToken(token + 'x')).status).toBe(401);
		expect(h.queries).toEqual([]);
	});

	it('names the account it was issued for', async () => {
		await h.send({from: B, to: A, content: 'hi'});
		const {token} = await h.api.openSession({domain: DOMAIN}, {privateKey: A.keySet.signing.privateKey});
		const {body} = await withToken(token);
		// A's side of the conversation (B's, the sender's, is accepted)
		expect(body.conversations.map((c: any) => c.status)).toEqual(['unaccepted']);
	});

	it('is refused, unauthenticated, when expired, tampered, for another domain or under another secret', async () => {
		const refusals = [
			mintSessionToken(SESSION_SECRET, claimsOf(A, {exp: Date.now() - 1})),
			mintSessionToken('another secret', claimsOf(A)),
			// tampered: B's claims under A's MAC
			`${mintSessionToken(SESSION_SECRET, claimsOf(B)).split('.')[0]}.${mintSessionToken(SESSION_SECRET, claimsOf(A)).split('.')[1]}`,
			'not a token',
			'',
		];
		for (const token of refusals) {
			const {status, body} = await withToken(token);
			expect(status).toBe(401);
			expect(body.error.code).toBe('unauthenticated');
		}
		const otherDomain = await withToken(mintSessionToken(SESSION_SECRET, claimsOf(A)), h, 'other.com');
		expect(otherDomain.status).toBe(401);
		expect(otherDomain.body.error.code).toBe('unauthenticated');
		expect((await withToken(mintSessionToken(SESSION_SECRET, claimsOf(A, {domain: 'other.com'})))).status).toBe(401);
	});

	it('signed with the previous secret is accepted while SESSION_SECRET_PREVIOUS names it', async () => {
		const rotated = createHarness({SESSION_SECRET: 'new secret', SESSION_SECRET_PREVIOUS: SESSION_SECRET});
		await rotated.setupDatabase();
		const old = mintSessionToken(SESSION_SECRET, claimsOf(A));
		expect((await withToken(old, rotated)).status).toBe(200);
		expect((await withToken(mintSessionToken('new secret', claimsOf(A)), rotated)).status).toBe(200);
		delete rotated.env.SESSION_SECRET_PREVIOUS;
		expect((await withToken(old, rotated)).status).toBe(401);
	});

	it('is the only authentication of a read: a request signature there is refused', async () => {
		const body = JSON.stringify({type: 'listConversations', domain: DOMAIN, namespace: NAMESPACE});
		const signature = await signRequest(
			{serverOrigin: SERVER_URL, method: 'POST', path: '/api/private/listConversations', body},
			A.keySet.signing.privateKey,
		);
		const response = await h.app.request(`${SERVER_URL}/api/private/listConversations`, {
			method: 'POST',
			headers: {'content-type': 'application/json', SIGNATURE: signature},
			body,
		});
		expect(response.status).toBe(401);
	});
});

describe('a server without SESSION_SECRET', () => {
	it('refuses every authenticated route, as the admin API without ADMIN_TOKEN', async () => {
		const bare = createHarness({SESSION_SECRET: undefined});
		const C = await createUser();
		const refused = async (call: Promise<unknown>) => {
			const error = await call.then(
				() => undefined,
				(e) => e,
			);
			expect(error).toBeInstanceOf(MissivAPIError);
			expect(error).toMatchObject({status: 403, code: 'forbidden'});
		};
		await refused(bare.register(C));
		await refused(bare.api.openSession({domain: DOMAIN}, {privateKey: C.keySet.signing.privateKey}));
		await refused(bare.send({from: C, to: A}));
		const {status} = await withToken(mintSessionToken('', claimsOf(C)), bare);
		expect(status).toBe(403);
		// a public read still answers
		expect(await bare.api.getDomainUser({type: 'getDomainUser', domain: DOMAIN, address: C.address})).toEqual({});
	});
});

describe("the client's sessions", () => {
	/** an API on the harness's app, counting session openings and refused tokens */
	function countingAPI(tamper?: (token: string) => string) {
		const counts = {sessions: 0, unauthenticated: 0, calls: 0};
		const api = new API(SERVER_URL, {
			fetch: (async (url: string, init: RequestInit) => {
				const headers = {...(init.headers as Record<string, string>)};
				if (url.endsWith('/api/session')) {
					counts.sessions++;
				} else {
					counts.calls++;
				}
				if (tamper && headers.Authorization) {
					headers.Authorization = `Bearer ${tamper(headers.Authorization.slice(7))}`;
				}
				const response = await h.app.request(url, {...init, headers});
				if (response.status === 401) {
					counts.unauthenticated++;
				}
				return response;
			}) as any,
		});
		return {api, counts};
	}
	const list = (api: API) =>
		api.listConversations(
			{type: 'listConversations', domain: DOMAIN, namespace: NAMESPACE},
			{privateKey: A.keySet.signing.privateKey},
		);

	it('opens one session and reuses it', async () => {
		const {api, counts} = countingAPI();
		await Promise.all([list(api), list(api)]);
		await list(api);
		expect(counts).toEqual({sessions: 1, unauthenticated: 0, calls: 3});
	});

	it('renews a session before it expires', async () => {
		const {api, counts} = countingAPI();
		await list(api);
		const now = Date.now();
		// five minutes before the token expires (on the server's clock as on the client's)
		vi.spyOn(Date, 'now').mockReturnValue(now + HOUR - 4 * 60 * 1000);
		await list(api);
		expect(counts).toEqual({sessions: 2, unauthenticated: 0, calls: 2});
	});

	it('retries once with a new session when its token is refused', async () => {
		const {api, counts} = countingAPI();
		await list(api);
		h.env.SESSION_SECRET = 'rotated without a previous secret';
		await list(api);
		expect(counts).toEqual({sessions: 2, unauthenticated: 1, calls: 3});
	});

	it('gives up after that one retry', async () => {
		const {api, counts} = countingAPI((token) => token + 'x');
		await expect(list(api)).rejects.toMatchObject({status: 401, code: 'unauthenticated'});
		expect(counts).toEqual({sessions: 2, unauthenticated: 2, calls: 2});
	});

	it('signs registrations (no session), and sends on the session with no request signature', async () => {
		const signed: boolean[] = [];
		const api = new API(SERVER_URL, {
			fetch: (async (url: string, init: RequestInit) => {
				if (!url.endsWith('/api/session')) {
					signed.push('SIGNATURE' in (init.headers as Record<string, string>));
				}
				return h.app.request(url, init);
			}) as any,
		});
		const actions = createActions(api);
		const C = await createUser();
		await actions.register(C);
		await actions.send({from: A, to: B, content: 'signed once, in the message'});
		await actions.send({from: A, to: B, content: 'twice'});
		expect(signed).toEqual([true, false, false]);
		expect(await h.contents(B, (await h.unaccepted(B))[0].conversationID)).toEqual([
			'signed once, in the message',
			'twice',
		]);
	});
});
