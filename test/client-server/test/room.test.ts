// The Room driven directly on fake sockets, against the harness's database: no
// platform, no port.
import {describe, it, expect, beforeEach} from 'vitest';
import {Room} from 'missiv-server';
import {signRequest} from 'delegated-identity';
import {createHarness, createUser, DOMAIN, type Harness, type TestUser} from './setup.js';

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

async function login(room: any, ws: FakeSocket & {challenge: string}, user: TestUser) {
	const signature = await signRequest(
		{serverOrigin: 'http://localhost', method: 'GET', path: room.identifier.path, body: ws.challenge},
		user.delegatePrivateKey,
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
});

describe('gated room (gated-room-accepts-writes-without-authorization)', () => {
	it.fails('stores nothing from a session whose authorization failed', async () => {
		// chain 1 is not configured, so the authorization cannot pass
		const {room, stored} = createRoom(h, `@${DOMAIN}!1:0x1111111111111111111111111111111111111111:0x:0x01`);
		const ws = await connect(room);
		await login(room, ws, A);
		await room.webSocketMessage(ws, JSON.stringify({message: 'not allowed here', signature: '0x'}));
		expect([...stored.values()]).toEqual([]);
	});
});
