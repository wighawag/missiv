// The Room driven directly on fake sockets, against the harness's database: no
// platform, no port.
import {describe, it, expect, beforeEach} from 'vitest';
import {Room, createInProcessRooms} from '@missiv/server';
import {signRequest} from 'delegated-identity';
import {
	createHarness,
	createUser,
	newKeySet,
	publicOf,
	APP_ORIGIN,
	DOMAIN,
	type Harness,
	type TestUser,
} from './setup.js';
import type {KeySet} from 'delegated-identity';

type FakeSocket = {sent: string[]; send(m: string): void; close(): void};

function createRoom(h: Harness, name: string) {
	const stored = new Map<string, unknown>();
	class TestRoom extends (Room as any) {
		getDB() {
			return h.db;
		}
		getRateLimiter() {
			return {fetch: async () => new Response('0')};
		}
		getStorage() {
			return {
				list: async () => new Map(stored),
				put: async (key: string, value: unknown) => {
					stored.set(key, value);
				},
			};
		}
		getWebSockets() {
			return [];
		}
		saveSocketData() {}
		retrieveSocketData() {
			return {};
		}
		async upgradeWebsocket() {
			return new Response();
		}
		async handleErrors(_: unknown, f: () => Promise<Response>) {
			return f();
		}
	}
	const room: any = new TestRoom({});
	room.instantiate();
	const [domain, authorization] = name.slice(1).split('!');
	room.identifier = {
		name,
		domain,
		authorization,
		serverOrigin: 'http://localhost',
		path: `/api/public/room/${name}/ws`,
	};
	return {room, stored};
}

async function connect(room: any): Promise<FakeSocket & {challenge: string}> {
	const ws: FakeSocket = {sent: [], send: (m) => ws.sent.push(m), close() {}};
	await room.webSocketOpen(ws, {ip: '127.0.0.1'});
	const challenge = JSON.parse(ws.sent.find((m) => m.includes('"challenge"'))!).challenge;
	return Object.assign(ws, {challenge});
}

/** Log in as `user`, the challenge signed by its key set's signing key (or another key set's). */
async function login(room: any, ws: FakeSocket & {challenge: string}, user: TestUser, keySet: KeySet = user.keySet) {
	const signature = await signRequest(
		{serverOrigin: 'http://localhost', method: 'GET', path: room.identifier.path, body: ws.challenge},
		keySet.signing.privateKey,
	);
	await room.webSocketMessage(ws, JSON.stringify({address: user.address, signature}));
	// the rate limiter counts the login too, and lifts its cooldown a tick later
	await new Promise((resolve) => setTimeout(resolve, 5));
}

let h: Harness;
let A: TestUser;

beforeEach(async () => {
	h = createHarness();
	A = await createUser();
	await h.register(A);
});

describe('public room', () => {
	it('stores and broadcasts a logged-in message', async () => {
		const {room, stored} = createRoom(h, `@${DOMAIN}`);
		const ws = await connect(room);
		await login(room, ws, A);
		await room.webSocketMessage(ws, JSON.stringify({message: 'hello', signature: '0x'}));
		expect([...stored.values()].map((v) => JSON.parse(v as string).message)).toEqual(['hello']);
	});

	it('logs in with the Ed25519 signature of the current key set, and announces its signing key', async () => {
		const {room} = createRoom(h, `@${DOMAIN}`);
		const ws = await connect(room);
		await login(room, ws, A);
		const joined = ws.sent.map((m) => JSON.parse(m)).find((m) => 'joined' in m);
		expect(joined).toMatchObject({joined: A.address, publicKey: A.keySet.signing.publicKey});
	});

	it('refuses a login not signed by the signing key of the current key set', async () => {
		const {room, stored} = createRoom(h, `@${DOMAIN}`);
		const ws = await connect(room);
		await login(room, ws, A, newKeySet());
		expect(ws.sent.map((m) => JSON.parse(m))).toContainEqual({error: 'Invalid signature', code: 'unauthenticated'});
		await room.webSocketMessage(ws, JSON.stringify({message: 'not logged in'}));
		expect([...stored.values()]).toEqual([]);
	});

	it('refuses a login by a replaced key set', async () => {
		const replacement = newKeySet();
		await h.api.register(
			{
				type: 'register',
				domain: DOMAIN,
				appOrigin: APP_ORIGIN,
				address: A.address,
				keySet: publicOf(replacement),
				ownershipSignature: await A.signPublication(replacement),
			},
			{privateKey: replacement.signing.privateKey},
		);
		const {room} = createRoom(h, `@${DOMAIN}`);
		const ws = await connect(room);
		await login(room, ws, A);
		expect(ws.sent.map((m) => JSON.parse(m))).toContainEqual({error: 'Invalid signature', code: 'unauthenticated'});
		const again = await connect(room);
		await login(room, again, A, replacement);
		expect(again.sent.map((m) => JSON.parse(m)).find((m) => 'joined' in m)).toMatchObject({joined: A.address});
	});
});

describe('gated room (gated-room-accepts-writes-without-authorization)', () => {
	it('stores nothing from a session whose authorization failed', async () => {
		// chain 1 is not configured, so the authorization cannot pass
		const {room, stored} = createRoom(h, `@${DOMAIN}!1:0x1111111111111111111111111111111111111111:0x:0x01`);
		const ws = await connect(room);
		await login(room, ws, A);
		await room.webSocketMessage(ws, JSON.stringify({message: 'not allowed here', signature: '0x'}));
		expect([...stored.values()]).toEqual([]);
	});
});

describe('in-process rooms (createInProcessRooms)', () => {
	it('one room per name, holding its own history', async () => {
		const rooms = createInProcessRooms({getDB: () => h.db});
		const room = rooms.getRoom({}, `@${DOMAIN}`);
		expect(rooms.getRoom({}, `@${DOMAIN}`)).toBe(room);
		const refused = room.prepareConnection(new Request(`http://localhost/api/public/room/${DOMAIN}/ws`));
		expect(refused?.status).toBe(400);
		expect(room.prepareConnection(new Request(`http://localhost/api/public/room/@${DOMAIN}/ws`))).toBeUndefined();

		const ws = await connect(room);
		room.addWebSocket(ws as any);
		await login(room, ws, A);
		await room.webSocketMessage(ws, JSON.stringify({message: 'kept', signature: '0x'}));
		const history = await room.getStorage().list<string>();
		expect([...history.values()].map((v) => JSON.parse(v).message)).toEqual(['kept']);

		await room.webSocketClose(ws as any, 1000, '', true);
		expect(room.getWebSockets()).toEqual([]);
	});
});
